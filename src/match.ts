import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { LeafResult } from "./notes.js";
import { describeMultipartFile, resourceDigest, type Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

export type MatchAction = "enablement.set" | "ruleset.upload" | "ruleset.delete" | "assignment.set" | "assignment.delete";
const warning = "Vectra Match requires a valid licence to enable, upload rules or add assignments. Changing enablement causes a reboot. Disabling a previously enabled device is permitted after licence expiry. Pre-send reads are not atomic.";
const uploadWarning = "RUX multipart POST /vectra-match/rules/ is deprecated; the documented successor is the staged /rules/upload/ flow (follow-up candidate).";
const serial = z.string().regex(/^[A-Za-z0-9_-]+$/);
const uuid = z.string().regex(/^[A-Za-z0-9_-]+$/);
const enablement = z.object({ is_enabled: z.boolean() });
const ruleset = z.object({ uuid, name: z.string(), hashsum: z.string(), device_serials: z.array(serial), timestamp: z.string() });
const assignments = z.object({ device_to_rules_map: z.array(z.object({ device_serial: serial, rules: z.array(uuid) })) });

function value(flags: ReadonlyMap<string, string | boolean>, name: string): string {
  const raw = flags.get(name);
  if (typeof raw !== "string" || !serial.safeParse(raw).success) throw new AxiError(
    `--${name} requires letters, digits, underscores or hyphens`, "VALIDATION_ERROR", ["Run `vectra-axi match --help`"],
  );
  return raw;
}

async function readMatch(session: Session, kind: "enablement" | "ruleset" | "assignment", query: Record<string, string> = {}) {
  const { body } = await session.request(`${session.profile.kind}.match.${kind}.${kind === "assignment" ? "list" : "show"}`, { query });
  const details = body && typeof body === "object" ? (body as Record<string, unknown>).details : undefined;
  if (details !== undefined && details !== null && details !== "") throw new AxiError("Match read returned failure details", "MALFORMED_RESPONSE");
  const schema = kind === "enablement" ? enablement : kind === "ruleset" ? ruleset : assignments;
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AxiError(`Cannot determine Match ${kind} state`, "MALFORMED_RESPONSE");
  if (kind === "ruleset" && (parsed.data as z.infer<typeof ruleset>).uuid !== query.uuid) {
    throw new AxiError("Match ruleset response has a different UUID", "MALFORMED_RESPONSE");
  }
  if (kind === "assignment") {
    const rows = (parsed.data as z.infer<typeof assignments>).device_to_rules_map;
    if (new Set(rows.map((row) => row.device_serial)).size !== rows.length
      || rows.some((row) => new Set(row.rules).size !== row.rules.length)) {
      throw new AxiError("Match assignment response contains duplicate devices or rules", "MALFORMED_RESPONSE");
    }
    rows.forEach((row) => row.rules.sort());
    rows.sort((a, b) => a.device_serial.localeCompare(b.device_serial));
  }
  return parsed.data;
}

export async function runMatchRead(session: Session, flags: ReadonlyMap<string, string | boolean>, kind: "enablement" | "ruleset" | "assignment"): Promise<LeafResult> {
  const query: Record<string, string> = kind === "enablement" ? { device_serial: value(flags, "device") }
    : kind === "ruleset" ? { uuid: value(flags, "uuid") } : {};
  const state = await readMatch(session, kind, query);
  const count = kind === "assignment" ? (state as z.infer<typeof assignments>).device_to_rules_map.length : undefined;
  return { failed: false, output: { profile: session.profile.name, ...state,
    ...(count === undefined ? {} : { count, help: [count === 0 ? "No Match device assignments are configured"
      : `Use \`vectra-axi match assignment set --profile ${session.profile.name} --device <serial> --uuid <uuid>\` to preview an assignment`] }),
  } };
}

export async function runMatchWrite(session: Session, coordinator: MutationCoordinator, flags: ReadonlyMap<string, string | boolean>, action: MatchAction): Promise<LeafResult> {
  const device = action.startsWith("assignment.") || action === "enablement.set" ? value(flags, "device") : undefined;
  const id = action === "ruleset.delete" || action.startsWith("assignment.") ? value(flags, "uuid") : undefined;
  const raw = flags.get("value");
  if (action === "enablement.set" && raw !== "true" && raw !== "false") throw new AxiError("--value must be true or false", "VALIDATION_ERROR");
  const desired = raw === "true";
  const file = flags.get("file");
  if (action === "ruleset.upload" && (typeof file !== "string" || !file || file === "-")) {
    throw new AxiError("--file requires a ruleset file path, never stdin; maximum 5000000 bytes", "VALIDATION_ERROR");
  }
  const kind = action.split(".")[0] as "enablement" | "ruleset" | "assignment";
  const target = kind === "enablement" ? `match device ${device}` : kind === "assignment" ? `match assignment ${device} ruleset ${id}`
    : action === "ruleset.upload" ? "new match ruleset" : `match ruleset ${id}`;
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.match.${action}`, method: action.endsWith("delete") ? "DELETE" : "POST",
    path: `/api/v${session.profile.apiVersion}/vectra-match/${kind === "ruleset" ? "rules" : kind}${session.profile.kind === "rux" ? "/" : ""}`,
    effect: kind === "enablement" ? "disruptive" : "write", requiresConfirmation: true, target,
    ...(kind === "enablement" ? { payload: { device_serial: device, desired_state: desired } }
      : action === "ruleset.delete" ? { payload: { uuid: id } }
      : kind === "assignment" ? { payload: action === "assignment.set" ? { uuid: id, device_serials: [device] } : { uuid: id, device_serial: device } } : {}),
  };
  // Refuse disabled operations before opening an upload or reading the appliance.
  coordinator.preview(definition);
  if (action === "ruleset.upload") definition.multipart = describeMultipartFile(file as string);
  let before: unknown;
  const isNoop = (state: unknown): boolean => {
    if (kind === "enablement") return (state as z.infer<typeof enablement>).is_enabled === desired;
    if (kind !== "assignment") return false;
    const assigned = (state as z.infer<typeof assignments>).device_to_rules_map
      .find((row) => row.device_serial === device)?.rules.includes(id!) ?? false;
    return action === "assignment.set" ? assigned : !assigned;
  };
  const readState = async () => {
    if (action === "assignment.set") await readMatch(session, "ruleset", { uuid: id! });
    const fresh = await readMatch(session, kind === "ruleset" && action === "ruleset.upload" ? "assignment" : kind,
      kind === "enablement" ? { device_serial: device! } : kind === "ruleset" && id ? { uuid: id } : {});
    if (before !== undefined && resourceDigest(before) !== resourceDigest(fresh) && !isNoop(fresh)) {
      throw new AxiError("Match state changed before sending", "VERSION_CONFLICT", ["Read and preview the changed state before retrying"]);
    }
    before = fresh;
    return fresh;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}), readState, isNoop,
  });
  const common = { profile: session.profile.name, operation: definition.operation, target, warning,
    ...(action === "ruleset.upload" && session.profile.kind === "rux" ? { uploadWarning } : {}),
  };
  if (result.kind === "dry-run") return { failed: false, output: { ...common, before, proposed: result.preview.proposedChange,
    ...(result.preview.noop ? { state: "already in desired state (no-op)" } : { help: [`Re-run with --execute --confirm '${target}' to apply this change`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, state: "success", audit: result.auditId } };
  return { failed: true, output: { ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Match mutation rejected with status ${result.status}` : result.guidance,
    help: ["Read back Match enablement, ruleset or assignment state before doing anything else; never replay an unknown outcome"],
  } };
}
