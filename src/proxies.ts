import { isIP } from "node:net";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

const proxySchema = z.object({
  id: z.string().min(1), address: z.string().refine((value) => isIP(value) !== 0),
  considerProxy: z.boolean(), source: z.string().min(1),
  createdAt: z.string().optional(), lastUpdatedAt: z.string().optional(),
});
const envelopeSchema = z.object({
  meta: z.object({ count: z.number().int().nonnegative() }), proxies: z.array(proxySchema),
});
type Proxy = z.infer<typeof proxySchema>;
const warning = "Proxy settings affect detection attribution.";

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `vectra-axi proxy --help`"]);
}

export function proxyId(flags: ReadonlyMap<string, string | boolean>): string {
  const id = flags.get("id");
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) invalid("--id must be a proxy identifier (letters, digits, underscores or hyphens)");
  return id;
}

async function readProxies(session: Session, id?: string): Promise<Proxy[]> {
  const { body } = await session.request(`${session.profile.kind}.proxy.${id === undefined ? "list" : "show"}`,
    id === undefined ? {} : { pathParams: { id } });
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success || parsed.data.meta.count !== parsed.data.proxies.length
    || new Set(parsed.data.proxies.map((row) => row.id)).size !== parsed.data.proxies.length
    || (id !== undefined && (parsed.data.proxies.length !== 1 || parsed.data.proxies[0]?.id !== id))) {
    throw new AxiError("Cannot determine proxy state from the response", "MALFORMED_RESPONSE", ["Read the proxy list before retrying"]);
  }
  return parsed.data.proxies;
}

export async function runProxyRead(
  session: Session, flags: ReadonlyMap<string, string | boolean>, action: "list" | "show",
): Promise<LeafResult> {
  const rows = await readProxies(session, action === "show" ? proxyId(flags) : undefined);
  return { failed: false, output: action === "show" ? { profile: session.profile.name, ...rows[0] } : {
    profile: session.profile.name, count: rows.length,
    proxies: rows.map(({ id, address, considerProxy, source }) => ({ id, address, considerProxy, source })),
    help: rows.length === 0 ? ["No proxies are defined on this instance"]
      : [`Run \`vectra-axi proxy show --profile ${session.profile.name} --id <id>\` for full detail`],
  } };
}

export async function runProxyWrite(
  session: Session, coordinator: MutationCoordinator, flags: ReadonlyMap<string, string | boolean>,
  action: "create" | "edit" | "delete",
): Promise<LeafResult> {
  if (action === "delete" && session.profile.kind === "qux") {
    throw new AxiError("QUX proxy delete is unsupported", "OPERATION_NOT_WRITABLE", ["Proxy deletion is available only on RUX"]);
  }
  const id = action === "create" ? undefined : proxyId(flags);
  const address = flags.get("address");
  const consider = flags.get("consider");
  if (address !== undefined && (typeof address !== "string" || isIP(address) === 0)) invalid("--address must be an IP address");
  if (consider !== undefined && consider !== "true" && consider !== "false") invalid("--consider must be true or false");
  if (action === "create" && (address === undefined || consider === undefined)) invalid("Create requires --address and --consider");
  if (action === "edit" && address === undefined && consider === undefined) invalid("Edit requires --address or --consider");
  const proposed = { ...(address !== undefined ? { address } : {}),
    ...(consider !== undefined ? { considerProxy: consider === "true" } : {}) };
  const target = action === "create" ? `new proxy ${address}` : `proxy ${id}`;
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.proxy.${action}`, method: action === "create" ? "POST" : action === "edit" ? "PATCH" : "DELETE",
    path: `/api/v${session.profile.apiVersion}/proxies${id === undefined ? "" : `/${id}`}${session.profile.kind === "rux" ? "/" : ""}`,
    effect: "write", requiresConfirmation: true, target,
    ...(action === "delete" ? {} : { payload: { proxy: proposed } }),
  };
  coordinator.preview(definition);
  let current: Proxy | null | undefined;
  const isNoop = (state: unknown): boolean => {
    const row = state as Proxy | null;
    return action !== "delete" && row !== null && (action !== "create" || row.source.toLowerCase() === "user")
      && (address === undefined || address === row.address)
      && (consider === undefined || row.considerProxy === (consider === "true"));
  };
  const readState = async (): Promise<Proxy | null> => {
    const rows = await readProxies(session, id);
    const row = action === "create" ? rows.find((entry) => entry.address === address) ?? null : rows[0]!;
    if (action !== "create" && row?.source.toLowerCase() !== "user") {
      throw new AxiError("Only user-defined proxies can be changed", "PROXY_NOT_WRITABLE", ["Choose a proxy with source user"]);
    }
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(row) && !isNoop(row)) {
      throw new AxiError(`${target} changed before sending`, "VERSION_CONFLICT", ["Preview the changed proxy before retrying"]);
    }
    if (action === "create" && row !== null && !isNoop(row)) {
      throw new AxiError("A proxy already exists for this address", "VERSION_CONFLICT", ["Use proxy edit with the existing ID"]);
    }
    current = row;
    return row;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}), readState, isNoop,
  });
  const common = { profile: session.profile.name, operation: definition.operation, target };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, warning, ...(current ? { current } : {}), ...(action === "delete" ? {} : { proposed }),
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to ${action} the proxy`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, state: "success", audit: result.auditId } };
  return { failed: true, output: { ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Proxy ${action} rejected with status ${result.status}` : result.guidance,
    help: [`Read back with \`vectra-axi proxy list --profile ${session.profile.name}\` before doing anything else; edits may change the proxy ID; never replay an unknown outcome`],
  } };
}
