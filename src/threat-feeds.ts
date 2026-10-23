import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { collect, collectionLimit } from "./collections.js";
import type { LeafResult } from "./notes.js";
import { describeMultipartFile, type Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

const defaultsSchema = z.object({
  category: z.enum(["cnc", "exfil", "lateral"]), certainty: z.enum(["Low", "Medium", "High"]),
  indicatorType: z.enum(["Anonymization", "C2", "Exfiltration", "Malware Artifacts", "Watchlist"]),
  duration: z.number().int(),
});
const feedSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), defaults: defaultsSchema,
  _rev: z.string().optional(), lastUpdated: z.string().optional(),
  uploadResults: z.record(z.string(), z.unknown()).nullable().optional(),
});
type Feed = z.infer<typeof feedSchema>;
type Action = "create" | "edit" | "delete" | "file.set" | "file.delete";

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `vectra-axi threat-feed --help`"]);
}

export function threatFeedId(flags: ReadonlyMap<string, string | boolean>): string {
  const id = flags.get("id");
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) invalid("--id must contain only letters, digits, underscores or hyphens");
  return id;
}

function decodeFeed(body: unknown): Feed {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const parsed = feedSchema.safeParse({ ...value, id: value.id ?? value._id });
  if (!parsed.success) throw new AxiError("Cannot determine threat-feed state", "MALFORMED_RESPONSE");
  return parsed.data;
}

async function readFeed(session: Session, id: string): Promise<Feed> {
  const { body } = await session.request(`${session.profile.kind}.threat-feed.show`, { pathParams: { id } });
  const row = decodeFeed(body);
  if (row.id !== id) throw new AxiError("Threat-feed response has a different ID", "MALFORMED_RESPONSE");
  return row;
}

async function readFeeds(session: Session): Promise<Feed[]> {
  if (session.profile.kind === "qux") {
    const { body } = await session.request("qux.threat-feed.list");
    const parsed = z.object({ threatFeeds: z.array(z.unknown()) }).safeParse(body);
    if (!parsed.success) throw new AxiError("Cannot determine threat-feed list", "MALFORMED_RESPONSE");
    const rows = parsed.data.threatFeeds.map(decodeFeed);
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new AxiError("Duplicate threat-feed IDs", "MALFORMED_RESPONSE");
    return rows;
  }
  const result = await collect(session, `${session.profile.kind}.threat-feed.list`, { all: true, decodeRow: decodeFeed });
  if (!result.complete) throw result.error ?? new AxiError("Threat-feed list is incomplete", "INCOMPLETE_READ");
  if (result.total !== null && result.total !== result.rows.length) throw new AxiError("Threat-feed count does not match the complete list", "MALFORMED_RESPONSE");
  if (new Set(result.rows.map((row) => row.id)).size !== result.rows.length) {
    throw new AxiError("Duplicate threat-feed IDs", "MALFORMED_RESPONSE");
  }
  return result.rows;
}

export async function runThreatFeedRead(
  session: Session, flags: ReadonlyMap<string, string | boolean>, action: "list" | "show",
): Promise<LeafResult> {
  if (action === "show") return { failed: false, output: { profile: session.profile.name, ...await readFeed(session, threatFeedId(flags)) } };
  const limit = collectionLimit(flags);
  if (session.profile.kind === "qux" && flags.has("all")) invalid("QUX threat-feed list is nonpaged; omit --all");
  const result = session.profile.kind === "rux"
    ? await collect(session, "rux.threat-feed.list", { all: flags.has("all"), ...(limit === undefined ? {} : { limit }), decodeRow: decodeFeed })
    : undefined;
  const completeRows = result?.rows ?? await readFeeds(session);
  const rows = completeRows.slice(0, limit);
  const total = result?.total ?? completeRows.length;
  return { failed: result?.error !== undefined, output: { profile: session.profile.name, count: rows.length, total,
    ...(result?.error ? { error: result.error.message } : {}),
    feeds: rows.map(({ id, name, defaults }) => ({ id, name, category: defaults.category, certainty: defaults.certainty })),
    help: result?.complete === false || rows.length < total
      ? [session.profile.kind === "rux" ? `Run \`vectra-axi threat-feed list --profile ${session.profile.name} --all\` for bounded traversal`
        : `Run \`vectra-axi threat-feed list --profile ${session.profile.name} --limit ${total}\` for all feeds`]
      : rows.length === 0 ? ["No threat feeds are configured on this instance"]
      : [`Run \`vectra-axi threat-feed show --profile ${session.profile.name} --id <id>\` for full detail`],
  } };
}

export async function runThreatFeedWrite(
  session: Session, coordinator: MutationCoordinator, flags: ReadonlyMap<string, string | boolean>, action: Action,
): Promise<LeafResult> {
  const id = action === "create" ? undefined : threatFeedId(flags);
  const name = flags.get("name");
  if (name !== undefined && (typeof name !== "string" || !name.trim() || /[\x00-\x1f\x7f]/.test(name))) invalid("--name must be non-empty without control characters");
  const changes: Record<string, unknown> = {};
  for (const [flag, field] of [["category", "category"], ["certainty", "certainty"], ["indicator-type", "indicatorType"], ["duration", "duration"]] as const) {
    const raw = flags.get(flag);
    if (raw === undefined) {
      if (action === "create") invalid(`Create requires --${flag}`);
      continue;
    }
    if (flag === "duration" && (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)) invalid("--duration must be a positive integer number of days");
    const value = flag === "duration" ? Number(raw) : raw;
    if (!defaultsSchema.shape[field].safeParse(value).success) invalid(`Invalid --${flag}`);
    changes[field] = value;
  }
  if (action === "create" && name === undefined) invalid("Create requires --name");
  if (action === "edit" && name === undefined && Object.keys(changes).length === 0) invalid("Edit requires --name or at least one default field");
  const filePath = flags.get("file");
  if (action === "file.set" && (typeof filePath !== "string" || !filePath || filePath === "-")) invalid("--file must be a STIX file path, never stdin");
  const target = action === "create" ? `new threat feed ${name}` : `threat feed ${id}`;
  const base = `/api/v${session.profile.apiVersion}/threatFeeds`;
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.threat-feed.${action}`,
    method: action === "create" || action === "file.set" ? "POST" : action === "edit" ? "PATCH" : "DELETE",
    path: `${base}${id === undefined ? "" : `/${id}`}${action === "file.delete" ? "/file" : ""}${session.profile.kind === "rux" ? "/" : ""}`,
    effect: "write", requiresConfirmation: true, target,
  };
  coordinator.preview(definition);
  if (action === "file.set") definition.multipart = describeMultipartFile(filePath as string);
  let current: Feed | null | undefined;
  const isNoop = (state: unknown): boolean => {
    const row = state as Feed | null;
    return (action === "edit" || action === "create") && row !== null
      && (name === undefined || row.name === name)
      && Object.entries(changes).every(([field, value]) => row.defaults[field as keyof Feed["defaults"]] === value);
  };
  const readState = async (): Promise<Feed | null> => {
    const row = id === undefined ? (await readFeeds(session)).find((entry) => entry.name === name) ?? null : await readFeed(session, id);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(row) && !isNoop(row)) {
      throw new AxiError(`${target} changed before sending`, "VERSION_CONFLICT", ["Preview the changed feed before retrying"]);
    }
    if (action === "create" && row !== null && !isNoop(row)) {
      throw new AxiError("A threat feed with this name already exists", "VERSION_CONFLICT", ["Use threat-feed edit with its ID"]);
    }
    current = row;
    return row;
  };
  // PATCH defaults are sent together so a partial edit preserves the other defaults.
  if (action === "create" || action === "edit") {
    if (action === "edit") await readState();
    definition.payload = { threatFeed: { ...(name === undefined ? {} : { name }),
      ...(Object.keys(changes).length === 0 ? {} : { defaults: { ...current?.defaults, ...changes } }) } };
  }
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}), readState, isNoop,
  });
  const common = { profile: session.profile.name, operation: definition.operation, target };
  if (result.kind === "dry-run") return { failed: false, output: { ...common,
    warning: "Threat feeds affect threat intelligence matching and detection scoring. Pre-send reads are not atomic.",
    ...(current ? { current } : {}), proposed: result.preview.proposedChange,
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to apply this change`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, state: "success", audit: result.auditId } };
  return { failed: true, output: { ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Threat-feed mutation rejected with status ${result.status}` : result.guidance,
    help: [`Read back with \`vectra-axi threat-feed list --profile ${session.profile.name}\` before doing anything else; never replay an unknown outcome`],
  } };
}
