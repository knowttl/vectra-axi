import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { collect } from "./collections.js";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

// WRITE-03: desired-state host/account assignment set through the WRITE-00
// gate pipeline. The upstream contract (VAT create_account_assignment,
// create_host_assignment, update_assignment and delete_assignment on the
// pinned commit, corroborated by the RUX v3.4 assignments create/update/
// delete operations) assigns analysts at the entity level only: POST
// /assignments with {assign_host_id | assign_account_id, assign_to_user_id}
// creates, PUT /assignments/{id} with {assign_to_user_id} reassigns, and
// DELETE /assignments/{id} unassigns. Individual detections have no
// assignment route (they inherit their entity's assignment), so this family
// covers hosts and accounts only. Resolving stays the separate resolve
// operation with its own outcome/note/triage contract and no leaf here.
//
// One `assignment set` leaf expresses the whole family: --host xor --account
// selects the entity, --user xor --unassign selects the desired state. The
// current open assignment is read through the READ-04 list route, the
// target user is validated through the READ-04 user show route before
// preview and before send, and the dry run previews assign, reassign
// (from X to Y) or unassign. Verified already-desired state is an exit-0
// no-op that sends nothing. There is no evidenced ETag contract, so the
// concurrency check is a client-side re-read like WRITE-01: when the
// assignment moves between the preview read and the pre-send re-read, the
// send is refused unless the fresh state already matches the desired state,
// which is a no-op.

export const ASSIGNMENT_SET_KINDS = ["host", "account"] as const;
export type AssignmentSetKind = (typeof ASSIGNMENT_SET_KINDS)[number];

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

// Exactly one entity selector: --host <id> xor --account <id>, both
// positive integer entity IDs. Reads stay kind-scoped like READ-04.
export function assignmentTarget(
  flags: ReadonlyMap<string, string | boolean>,
): { kind: AssignmentSetKind; id: number } {
  const command = "assignment set";
  const host = flags.get("host");
  const account = flags.get("account");
  if (host !== undefined && account !== undefined) {
    invalid("--host cannot be combined with --account",
      `Run \`vectra-axi ${command} --help\``);
  }
  const raw = host ?? account;
  const kind: AssignmentSetKind = host !== undefined ? "host" : "account";
  if (raw === undefined) {
    invalid(`${command} requires --host <id> or --account <id>`,
      "Example: vectra-axi assignment set --profile <name> --host 7 --user 3",
      `Run \`vectra-axi ${command} --help\``);
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid(`--${kind} must be a positive integer entity ID`, `Example: --${kind} 7`);
  }
  return { kind, id: Number(raw) };
}

export type AssignmentDesired = { user: number } | { unassign: true };

// Exactly one desired state: --user <id> assigns to that user, --unassign
// clears the assignment. The target user ID is a positive integer; its
// existence is validated against the users route before preview and send.
export function assignmentDesired(
  flags: ReadonlyMap<string, string | boolean>,
): AssignmentDesired {
  const command = "assignment set";
  const user = flags.get("user");
  const unassign = flags.get("unassign");
  if (user !== undefined && unassign !== undefined) {
    invalid("--user cannot be combined with --unassign",
      `Run \`vectra-axi ${command} --help\``);
  }
  if (user === undefined && unassign === undefined) {
    invalid(`${command} requires --user <id> or --unassign`,
      "Example: vectra-axi assignment set --profile <name> --host 7 --user 3",
      "Example: vectra-axi assignment set --profile <name> --host 7 --unassign",
      `Run \`vectra-axi ${command} --help\``);
  }
  if (unassign !== undefined) return { unassign: true as const };
  if (typeof user !== "string" || !/^\d+$/.test(user) || Number(user) < 1) {
    invalid("--user must be a positive integer user ID", "Example: --user 3");
  }
  return { user: Number(user) };
}

const assignmentRowSchema = z.object({
  id: z.number().int().positive(),
  host_id: z.number().int().positive().nullable().optional(),
  account_id: z.number().int().positive().nullable().optional(),
  date_resolved: z.string().nullable(),
  assigned_to: z.object({ id: z.number().int().positive() }).nullable(),
});

const userSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().nullable().optional(),
});

type CurrentState = { assignmentId: number | null; assignee: number | null };

function isState(value: unknown): value is CurrentState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (typeof state.assignmentId === "number" || state.assignmentId === null)
    && (typeof state.assignee === "number" || state.assignee === null);
}

function sameState(left: CurrentState, right: CurrentState): boolean {
  return left.assignmentId === right.assignmentId && left.assignee === right.assignee;
}

function isDesired(state: CurrentState, desired: AssignmentDesired): boolean {
  return "user" in desired
    ? state.assignmentId !== null && state.assignee === desired.user
    : state.assignee === null;
}

function decodeRow(kind: AssignmentSetKind, id: number, row: unknown): {
  assignmentId: number; assignee: number | null;
} | null {
  const result = assignmentRowSchema.safeParse(row);
  if (!result.success
    || (kind === "host" ? result.data.host_id : result.data.account_id) === undefined
    || (result.data.host_id == null && result.data.account_id == null)) {
    throw new AxiError("Vectra assignment response is malformed: expected valid assignment fields",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  const decoded = result.data;
  // Only unresolved rows for our own entity count: resolved rows are closed
  // history (READ-04 semantics intact), and rows for another entity can
  // never select this command's PUT/DELETE target.
  if (decoded.date_resolved !== null) return null;
  if ((kind === "host" ? decoded.host_id : decoded.account_id) !== id) return null;
  return { assignmentId: decoded.id, assignee: decoded.assigned_to === null ? null : decoded.assigned_to.id };
}

// Reads the current open assignment through the READ-04 list route with the
// entity filter. More than one open row for one entity is ambiguous (no
// single PUT/DELETE target), so it is refused rather than guessed.
async function readCurrent(
  session: Session, kind: AssignmentSetKind, id: number, previewCommand: string,
): Promise<CurrentState> {
  // The entity filter plus resolved=false keeps the window on this
  // entity's open assignments; resolved rows are closed history and can
  // never select a PUT/DELETE target.
  const query: Record<string, string | number | boolean> =
    kind === "host" ? { hosts: id, resolved: "false" } : { accounts: id, resolved: "false" };
  const collected = await collect(session, "qux.assignment.list", { query });
  // A denied or partial window cannot establish the current state: refuse
  // instead of routing a mutation off incomplete reads.
  if (collected.error) throw collected.error;
  const open = collected.rows
    .map((row) => decodeRow(kind, id, row))
    .filter((row): row is { assignmentId: number; assignee: number | null } => row !== null);
  if (open.length > 1) {
    throw new AxiError(
      `blocked: ${kind} ${id} has ${open.length} open assignments; refusing to choose between them`,
      "VALIDATION_ERROR",
      [`Resolve the duplicate assignments before re-running \`${previewCommand}\``],
    );
  }
  const [only] = open;
  return only ?? { assignmentId: null, assignee: null };
}

// Validates the target user exists through the READ-04 user show route.
// Existence is the whole check: the returned username is informational and
// the preview names users by exact ID.
async function readUser(session: Session, user: number): Promise<void> {
  const { body } = await session.request("qux.user.show", { pathParams: { id: user } });
  const result = userSchema.safeParse(body);
  if (!result.success || result.data.id !== user) {
    throw new AxiError(`Vectra user ${user} response is malformed: expected the requested user`,
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
}

function owner(kind: AssignmentSetKind, id: number): string {
  return `${kind} ${id}`;
}

function setCommand(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: AssignmentSetKind, id: number,
  desired: AssignmentDesired,
): string {
  const config = flags.get("config");
  return "vectra-axi assignment set"
    + `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --${kind} ${id}`
    + ("user" in desired ? ` --user ${desired.user}` : " --unassign");
}

function listCommand(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: AssignmentSetKind, id: number,
): string {
  const config = flags.get("config");
  return "vectra-axi assignment list"
    + `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --${kind} ${id}`;
}

function pastAction(current: CurrentState, desired: AssignmentDesired, target: string): string {
  const from = current.assignee === null ? "unassigned" : `user ${current.assignee}`;
  if ("user" in desired) {
    if (current.assignmentId === null) return `assigned ${target} to user ${desired.user}`;
    return `reassigned ${target} from ${from} to user ${desired.user}`;
  }
  return `unassigned ${target} (was ${from})`;
}

function describeAction(current: CurrentState, desired: AssignmentDesired, target: string): string {
  const from = current.assignee === null ? "unassigned" : `user ${current.assignee}`;
  if ("user" in desired) {
    if (current.assignmentId === null) return `assign ${target} to user ${desired.user}`;
    return `reassign ${target} from ${from} to user ${desired.user}`;
  }
  return `unassign ${target} from ${from}`;
}

function definitionFor(
  session: Session, kind: AssignmentSetKind, id: number, current: CurrentState, desired: AssignmentDesired,
): MutationDefinition {
  const target = owner(kind, id);
  if ("user" in desired) {
    if (current.assignmentId === null) {
      return {
        operation: `qux.${kind}.assignment.create`,
        method: "POST",
        path: `/api/v${session.profile.apiVersion}/assignments`,
        effect: "write",
        requiresConfirmation: true,
        target,
        payload: { [`assign_${kind}_id`]: id, assign_to_user_id: desired.user },
      };
    }
    return {
      operation: `qux.${kind}.assignment.reassign`,
      method: "PUT",
      path: `/api/v${session.profile.apiVersion}/assignments/${current.assignmentId}`,
      effect: "write",
      requiresConfirmation: true,
      target,
      // Only the analyst moves: the upstream PUT can also move the entity,
      // but this command never retargets an assignment onto another entity.
      payload: { assign_to_user_id: desired.user },
    };
  }
  return {
    operation: `qux.${kind}.assignment.unassign`,
    method: "DELETE",
    // The open assignment selects the DELETE target; with nothing open the
    // coordinator reports a no-op before this definition could ever send.
    path: current.assignmentId === null
      ? `/api/v${session.profile.apiVersion}/assignments`
      : `/api/v${session.profile.apiVersion}/assignments/${current.assignmentId}`,
    effect: "write",
    requiresConfirmation: true,
    target,
  };
}

export async function runAssignmentSet(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const { kind, id } = assignmentTarget(flags);
  const desired = assignmentDesired(flags);
  if (flags.has("execute") && flags.has("dry-run")) {
    throw new AxiError("--dry-run cannot be combined with --execute", "VALIDATION_ERROR", [
      "Omit --execute to preview the mutation without sending it",
    ]);
  }
  const target = owner(kind, id);
  const previewCommand = setCommand(session, flags, kind, id, desired);
  // The routing read runs before the coordinator: it selects the POST, PUT
  // or DELETE definition and validates the target user ahead of the
  // preview. The coordinator's preview read reuses it, and the pre-send
  // re-read repeats both reads for the conflict and existence checks.
  const routed = await readCurrent(session, kind, id, previewCommand);
  if ("user" in desired) await readUser(session, desired.user);
  const definition = definitionFor(session, kind, id, routed, desired);
  let baseline: CurrentState | undefined;
  const readState = async (): Promise<CurrentState> => {
    if (baseline === undefined) {
      baseline = routed;
      return routed;
    }
    const fresh = await readCurrent(session, kind, id, previewCommand);
    if ("user" in desired) await readUser(session, desired.user);
    if (!sameState(baseline, fresh) && !isDesired(fresh, desired)) {
      throw new AxiError(
        `blocked: assignment for ${target} changed since the preview; re-run to preview the new state`,
        "VERSION_CONFLICT",
        [`Re-run \`${previewCommand}\` without --execute to preview the current assignment`],
      );
    }
    return fresh;
  };
  const result = await coordinator.execute(definition, {
    ...(flags.has("execute") ? { execute: true } : {}),
    ...(flags.has("dry-run") ? { dryRun: true } : {}),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState,
    isNoop: (current: unknown) => isState(current) && isDesired(current, desired),
  });
  const profile = session.profile.name;
  const action = describeAction(routed, desired, target);
  const desiredText = "user" in desired ? `user ${desired.user}` : "unassigned";
  const currentText = routed.assignee === null ? "unassigned" : `user ${routed.assignee}`;
  if (result.kind === "dry-run") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      current: currentText,
      desired: desiredText,
      action,
      ...(result.preview.noop
        ? { state: `${target} is already ${"user" in desired ? `assigned to user ${desired.user}` : "unassigned"} (no-op)` }
        : { help: [`Re-run with --execute --confirm '${target}' to ${action}`] }),
    } };
  }
  if (result.kind === "noop") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      assignment: `${target} is already ${"user" in desired ? `assigned to user ${desired.user}` : "unassigned"} (no-op)`,
    } };
  }
  if (result.kind === "success") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      assignment: pastAction(routed, desired, target),
      audit: result.auditId,
    } };
  }
  if (result.kind === "failed") {
    return { failed: true, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      error: `assignment for ${target} was rejected with status ${result.status}`,
      audit: result.auditId,
      help: [`Read back \`${listCommand(session, flags, kind, id)}\` before doing anything else`],
    } };
  }
  return { failed: true, output: {
    profile,
    type: kind,
    id,
    operation: definition.operation,
    error: result.guidance,
    audit: result.auditId,
  } };
}
