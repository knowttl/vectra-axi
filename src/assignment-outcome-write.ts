import { AxiError } from "axi-sdk-js";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

export const OUTCOME_CATEGORIES = ["benign_true_positive", "malicious_true_positive", "false_positive", "internal"] as const;

export async function runAssignmentOutcomeWrite(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  action: "create" | "edit" | "delete",
): Promise<LeafResult> {
  const title = flags.get("title");
  const category = flags.get("category");
  const rawId = flags.get("id");
  const invalid = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [`Run \`vectra-axi assignment outcome ${action} --help\``]);
  };
  if (action !== "create" && (typeof rawId !== "string" || !/^\d+$/.test(rawId)
    || !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 1)) invalid("--id must be a positive integer");
  if (title !== undefined && (typeof title !== "string" || !title.trim())) invalid("--title must be non-empty");
  if (category !== undefined && !OUTCOME_CATEGORIES.includes(category as typeof OUTCOME_CATEGORIES[number])) {
    invalid(`--category must be one of ${OUTCOME_CATEGORIES.join(", ")}`);
  }
  if (action === "create" && (title === undefined || category === undefined)) invalid("Create requires --title and --category");
  if (action === "edit" && title === undefined && category === undefined) invalid("Edit requires --title or --category");
  const id = Number(rawId);
  const target = action === "create" ? "new assignment outcome" : `assignment outcome ${id}`;
  const payload = { ...(title !== undefined ? { title } : {}), ...(category !== undefined ? { category } : {}) };
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.assignment-outcome.${action}`,
    method: action === "create" ? "POST" : action === "edit" ? "PUT" : "DELETE",
    path: `/api/v${session.profile.apiVersion}/assignment_outcomes${action === "create" ? "" : `/${id}`}${session.profile.kind === "rux" ? "/" : ""}`,
    effect: "write", requiresConfirmation: true, target,
    ...(action !== "delete" ? { payload } : {}),
  };
  coordinator.preview(definition);
  type Outcome = { id: number; title: string; category: string; builtin: boolean };
  let current: Outcome | undefined;
  const isNoop = (state: unknown): boolean => {
    const row = state as Outcome | null;
    return action === "edit" && row !== null
      && (title === undefined || title === row.title) && (category === undefined || category === row.category);
  };
  const readState = async (): Promise<Outcome | null> => {
    // A create has no existing resource to read or compare.
    if (action === "create") return null;
    const { body } = await session.request(`${session.profile.kind}.assignment-outcome.show`, { pathParams: { id } });
    const row = body as Outcome | null;
    if (!row || row.id !== id || typeof row.title !== "string" || typeof row.category !== "string" || typeof row.builtin !== "boolean") {
      throw new AxiError(`Cannot determine state of ${target}`, "MALFORMED_RESPONSE", ["Read the outcome before retrying"]);
    }
    if (row.builtin) throw new AxiError(`Cannot ${action} builtin ${target}`, "BUILTIN_OUTCOME", ["Choose a custom assignment outcome"]);
    const state = { id: row.id, title: row.title, category: row.category, builtin: row.builtin };
    if (current && JSON.stringify(current) !== JSON.stringify(state) && !isNoop(state)) {
      throw new AxiError(`${target} changed before sending`, "VERSION_CONFLICT", ["Preview the changed outcome before retrying"]);
    }
    current = state;
    return state;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState, isNoop,
  });
  const common = { profile: session.profile.name, operation: definition.operation, target };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, ...(current ? { current } : {}), ...(action !== "delete" ? { proposed: payload } : {}),
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to ${action} the outcome`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, state: "success", audit: result.auditId } };
  return { failed: true, output: {
    ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Assignment outcome ${action} rejected with status ${result.status}` : result.guidance,
    help: [`Read back with \`vectra-axi assignment outcome ${action === "create" ? "list" : `show --id ${id}`} --profile ${session.profile.name}\` before doing anything else; never replay an unknown outcome`],
  } };
}
