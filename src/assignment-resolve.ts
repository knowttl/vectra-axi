import { AxiError } from "axi-sdk-js";
import { assignmentTarget, readOpenAssignment } from "./assignment-set.js";
import { desiredNote } from "./note-add.js";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `vectra-axi assignment resolve --help`"]);
}

function positiveId(raw: unknown, flag: string): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    invalid(`${flag} must be a positive integer ID`);
  }
  return Number(raw);
}

export async function runAssignmentResolve(
  session: Session, coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const { kind, id } = assignmentTarget(flags, "assignment resolve");
  const outcome = positiveId(flags.get("outcome"), "--outcome");
  const fixed = flags.has("mark-fixed");
  const triage = flags.get("triage-as");
  const detections = flags.get("detections");
  if (fixed && triage !== undefined) invalid("--mark-fixed cannot be combined with --triage-as");
  if ((detections !== undefined) !== (fixed || triage !== undefined)) {
    invalid("--detections requires exactly one of --mark-fixed or --triage-as, and either action requires --detections");
  }
  if (triage !== undefined && (typeof triage !== "string" || !triage.trim())) invalid("--triage-as requires a non-empty label");
  const detectionIds = typeof detections === "string"
    ? [...new Set(detections.split(",").map((value) => positiveId(value.trim(), "--detections")))].sort((a, b) => a - b)
    : undefined;
  if (detectionIds && detectionIds.length > 100) invalid("--detections is limited to 100 IDs");
  const note = flags.has("note") || flags.has("note-file") ? desiredNote(flags, kind) : undefined;
  if (flags.has("execute") && flags.has("dry-run")) invalid("--dry-run cannot be combined with --execute");
  const { profile } = session;
  const target = `${kind} ${id}`;
  const definition: MutationDefinition = {
    operation: `${profile.kind}.${kind}.assignment.resolve`, method: "PUT",
    path: `/api/v${profile.apiVersion}/assignments${profile.kind === "rux" ? "/" : ""}`,
    effect: "disruptive", requiresConfirmation: true, target,
    payload: { outcome, ...(note !== undefined ? { note } : {}),
      ...(detectionIds ? { detection_ids: detectionIds } : {}),
      ...(fixed ? { mark_as_fixed: true } : {}), ...(triage !== undefined ? { triage_as: triage } : {}) },
  };
  // Check the write scope before routing reads. Only the verified open
  // assignment may supply the final mutation path.
  coordinator.preview(definition);
  const command = "vectra-axi assignment resolve";
  const routed = await readOpenAssignment(session, kind, id, command);
  if (routed.assignmentId === null) invalid(`No open assignment for ${target}`);
  definition.path = `/api/v${profile.apiVersion}/assignments/${routed.assignmentId}/resolve${profile.kind === "rux" ? "/" : ""}`;
  let first = true;
  const readState = async (): Promise<unknown> => {
    const current = first ? routed : await readOpenAssignment(session, kind, id, command);
    first = false;
    if (current.assignmentId !== routed.assignmentId || current.assignee !== routed.assignee) {
      throw new AxiError(`Assignment for ${target} changed since preview`, "VERSION_CONFLICT",
        ["Preview the current assignment again before resolving"]);
    }
    const { body } = await session.request(`${profile.kind}.assignment-outcome.show`, { pathParams: { id: outcome } });
    if (!body || typeof body !== "object" || (body as { id?: unknown }).id !== outcome) {
      throw new AxiError("Malformed assignment outcome: expected the requested outcome", "RESPONSE_INVALID",
        ["Read assignment outcome list before resolving"]);
    }
    return current;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"), readState,
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
  });
  const output = { profile: profile.name, type: kind, id, assignment: routed.assignmentId,
    operation: definition.operation, effect: definition.effect, ...definition.payload as Record<string, unknown>,
    warning: "Resolves the assignment permanently; there is no unresolve" };
  if (result.kind === "dry-run") return { failed: false, output: { ...output,
    help: [`Re-run with --execute --confirm '${target}' to resolve ${target}`] } };
  if (result.kind === "success") return { failed: false, output: { ...output, audit: result.auditId } };
  if (result.kind === "noop") return { failed: false, output };
  return { failed: true, output: { ...output, audit: result.auditId,
    error: result.kind === "failed" ? `Resolution for ${target} was rejected with status ${result.status}` : result.guidance } };
}
