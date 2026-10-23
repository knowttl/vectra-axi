import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { collect } from "./collections.js";
import type { LeafResult } from "./groups.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

type Member = string | number;
type Action = "add" | "remove" | "set";

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `vectra-axi group member set --help`"]);
}

function normalized(members: Member[]): Member[] {
  return [...new Set(members)].sort((a, b) => String(a).localeCompare(String(b)));
}

export async function runGroupWrite(
  session: Session, coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>, action: "create" | "edit" | "delete",
): Promise<LeafResult> {
  const invalid = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [`Run \`vectra-axi group ${action} --help\``]);
  };
  if (flags.has("execute") && flags.has("dry-run")) invalid("--dry-run cannot be combined with --execute");
  const rawId = flags.get("id");
  if (action !== "create" && (typeof rawId !== "string" || !/^\d+$/.test(rawId)
    || !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 1)) invalid("--id must be a positive integer group ID");
  const payload: Record<string, unknown> = {};
  for (const key of ["name", "description", "importance"]) {
    const value = flags.get(key);
    if (value !== undefined) {
      if (typeof value !== "string" || key !== "description" && !value.trim()) invalid(`--${key} must be text${key === "description" ? "" : " and non-empty"}`);
      payload[key] = value;
    } else if (action === "create") invalid(`Create requires --${key}`);
  }
  if (action === "edit" && !Object.keys(payload).length) invalid("Edit requires --name, --description or --importance");
  if (payload.importance !== undefined && !["high", "medium", "low", "never_prioritize"].includes(payload.importance as string)) {
    invalid("--importance must be high, medium, low or never_prioritize");
  }
  if (action === "create") {
    const type = flags.get("type");
    if (typeof type !== "string" || !["host", "account", "ip", "domain"].includes(type)) invalid("--type must be host, account, ip or domain");
    payload.type = type;
    const modes = ["members", "regex", "ad-group-dn"].filter((key) => flags.has(key));
    if (modes.length !== 1) invalid("Provide exactly one of --members, --regex or --ad-group-dn");
    const mode = modes[0]!;
    const value = flags.get(mode);
    if (typeof value !== "string" || !value.trim()) invalid(`--${mode} must be non-empty`);
    const text = value as string;
    if (mode === "members") {
      const members = text.split(",").map((part) => part.trim());
      if (members.some((part) => !part || type === "host" && (!/^\d+$/.test(part)
        || !Number.isSafeInteger(Number(part)) || Number(part) < 1))) invalid("Use positive host IDs or non-empty account UIDs, IPs or domains");
      payload.members = normalized(type === "host" ? members.map(Number) : members);
    } else {
      if (type !== "host" && type !== "account") invalid("Regex and AD membership require a host or account group");
      payload[mode === "regex" ? "regex" : "ad_group_dn"] = text;
      const release = session.profile.kind === "qux" ? session.profile.applianceRelease : undefined;
      if (release !== undefined && /^\d+(?:\.\d+)*$/.test(release)) {
        const [major, minor = 0] = release.split(".").map(Number);
        const minimum = mode === "regex" ? 0 : 6;
        if (major! < 9 || major === 9 && minor < minimum) invalid(`${mode} groups require appliance release 9.${minimum} or later (profile reports ${release})`);
      }
    }
  }
  const id = Number(rawId);
  const generation = session.profile.kind;
  const target = action === "create" ? "new group" : `group ${id}`;
  const definition: MutationDefinition = {
    operation: `${generation}.group.${action}`,
    method: action === "create" ? "POST" : action === "edit" ? "PATCH" : "DELETE",
    path: `/api/v${session.profile.apiVersion}/groups${action === "create" ? "" : `/${id}`}${generation === "rux" ? "/" : ""}`,
    effect: action === "delete" ? "disruptive" : "write", requiresConfirmation: true, target,
    ...(action === "delete" ? {} : { payload }),
  };
  coordinator.preview(definition);
  let before: Record<string, unknown> | undefined;
  const isNoop = (state: unknown): boolean => action === "edit" && state !== null
    && Object.entries(payload).every(([key, value]) => (state as Record<string, unknown>)[key] === value);
  const readState = async (): Promise<Record<string, unknown> | null> => {
    // Creation has no existing resource to compare.
    if (action === "create") return null;
    const { body } = await session.request(`${generation}.group.show`, { pathParams: { id },
      ...(generation === "rux" ? { query: { include_members: false } } : {}) });
    const row = body as Record<string, unknown> | null;
    if (!row || row.id !== id || typeof row.type !== "string" || typeof row.name !== "string") {
      throw new AxiError(`Cannot determine state of ${target}`, "MALFORMED_RESPONSE", ["Read the group before retrying"]);
    }
    const state = Object.fromEntries(["id", "type", "name", "description", "importance", "regex", "ad_group_dn", "is_regex", "is_ad_group"].map((key) => [key, row[key]]));
    if (before && JSON.stringify(before) !== JSON.stringify(state)) {
      throw new AxiError(`${target} changed before sending`, "VERSION_CONFLICT", ["Preview the changed group before retrying"]);
    }
    before = state;
    return state;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState, isNoop,
  });
  const common = { profile: session.profile.name, operation: definition.operation, target,
    warning: action === "delete" ? "Deleting a group orphans triage rule references" : "Groups drive triage rules and importance" };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, ...(before ? { before } : {}), ...(action === "delete" ? {} : { proposed: payload }),
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to ${action} the group`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, state: "success", audit: result.auditId } };
  return { failed: true, output: { ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Group ${action} rejected with status ${result.status}` : result.guidance,
    help: [`Read back with \`vectra-axi group ${action === "create" ? "list" : `show --id ${id}`} --profile ${session.profile.name}\` before doing anything else; never replay an unknown outcome`],
  } };
}

export async function runGroupMemberWrite(
  session: Session, coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>, action: Action,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): Promise<LeafResult> {
  if (flags.has("execute") && flags.has("dry-run")) invalid("--dry-run cannot be combined with --execute");
  const rawId = flags.get("id");
  if (typeof rawId !== "string" || !/^\d+$/.test(rawId)
    || !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 1) invalid("--id must be a positive integer group ID");
  const inline = flags.get("members");
  const file = flags.get("members-file");
  if ((inline === undefined) === (file === undefined)) invalid("Provide exactly one of --members or --members-file");
  let input: unknown;
  if (typeof inline === "string") {
    input = inline.split(",").map((value) => value.trim());
  } else if (typeof file === "string" && file) {
    try {
      input = JSON.parse(file === "-" ? readStdin() : readFileSync(file, "utf8"));
    } catch {
      invalid("--members-file must contain a readable JSON array of member IDs or strings");
    }
  }
  if (!Array.isArray(input) || input.some((value) =>
    typeof value !== "string" && typeof value !== "number"
    || typeof value === "string" && !value.trim()
    || typeof value === "number" && (!Number.isSafeInteger(value) || value < 1))) {
    invalid("Members must be a JSON array or comma-separated list of non-empty member IDs or strings");
  }
  const id = Number(rawId);
  const target = `group ${id}`;
  const generation = session.profile.kind;
  const definition: MutationDefinition = {
    operation: `${generation}.group.member.set`, method: "PATCH",
    path: `/api/v${session.profile.apiVersion}/groups/${id}${generation === "rux" ? "/" : ""}`,
    effect: "write", requiresConfirmation: true, target, payload: { members: [] },
  };
  // Authorize before reading any target state, including in preview mode.
  coordinator.preview(definition);
  let before: Member[] | undefined;
  let desired: Member[] = [];
  let originalType: string | undefined;
  const readState = async (): Promise<Member[]> => {
    const { body } = await session.request(`${generation}.group.show`, { pathParams: { id },
      ...(generation === "rux" ? { query: { include_members: false } } : {}) });
    const group = body as Record<string, unknown> | null;
    if (!group || group.id !== id || typeof group.type !== "string") {
      throw new AxiError("Cannot determine group type", "MALFORMED_RESPONSE", ["Read back the group before retrying"]);
    }
    if (group.is_regex || group.regex || group.is_ad_group || group.ad_group_dn
      || /regex|^ad(?:_|$)/i.test(group.type)) {
      invalid("Regex and AD group membership cannot be patched");
    }
    const type = group.type;
    if (!["host", "account", "ip", "domain"].includes(type)) invalid(`Unsupported group type: ${type}`);
    const member = (value: unknown): Member => {
      const row = value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
      const raw = row ? row[type === "host" ? "id" : type === "account" ? "uid" : type] : value;
      const identity = typeof raw === "string" ? raw.trim() : raw;
      if (type === "host") {
        const number = typeof identity === "string" && /^\d+$/.test(identity) ? Number(identity) : identity;
        if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
      } else if (typeof identity === "string" && identity) return identity;
      throw new AxiError(`Invalid ${type} group member identity`, "MALFORMED_RESPONSE", ["Use host IDs, account UIDs, IPs or domains matching the group type"]);
    };
    const window = await collect(session, `${generation}.group.member.list`, {
      pathParams: { id }, all: true, decodeRow: member,
    });
    if (window.error) throw window.error;
    if (!window.complete || window.cursor || window.total !== null && window.total !== window.rows.length) {
      throw new AxiError("Complete group membership is required before replacing members", "INCOMPLETE_READ", ["Read the complete membership before retrying"]);
    }
    const userMember = (value: Member): Member => {
      const identity = typeof value === "string" ? value.trim() : value;
      if (type === "host") {
        const number = typeof identity === "string" && /^\d+$/.test(identity) ? Number(identity) : identity;
        if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
        invalid(`Invalid ${type} group member identity`);
      }
      if (typeof identity === "string" && identity) return identity;
      if (typeof identity === "number" && Number.isSafeInteger(identity) && identity > 0) return String(identity);
      invalid(`Invalid ${type} group member identity`);
    };
    const current = normalized(window.rows);
    if (before !== undefined) {
      if (originalType !== type || JSON.stringify(before) !== JSON.stringify(current)) {
        throw new AxiError("Group membership changed after preview", "VERSION_CONFLICT", ["Preview the new membership before executing again"]);
      }
    } else {
      before = current;
      originalType = type;
      const requested = normalized((input as Member[]).map(userMember));
      desired = action === "set" ? requested : action === "add" ? normalized([...current, ...requested])
        : current.filter((value) => !requested.includes(value));
    }
    return current;
  };
  // Build the full replacement before the coordinator serializes its payload.
  await readState();
  definition.payload = { members: desired };
  let initial = true;
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState: async () => {
      if (!initial) return readState();
      initial = false;
      return before!;
    },
    isNoop: (state) => JSON.stringify(state) === JSON.stringify(desired),
  });
  const common = { profile: session.profile.name, operation: definition.operation, target,
    warning: "Groups drive triage rules and importance" };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, before, after: desired,
    added: desired.filter((value) => !before!.includes(value)),
    removed: before!.filter((value) => !desired.includes(value)),
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to replace membership`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, members: desired, audit: result.auditId } };
  return { failed: true, output: { ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Group membership change rejected with status ${result.status}` : result.guidance,
    help: [`Read back with \`vectra-axi group member list --profile ${session.profile.name} --id ${id}\` before doing anything else; never replay an unknown outcome`],
  } };
}
