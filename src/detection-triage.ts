import { AxiError } from "axi-sdk-js";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import { bulkTargetLabel, MAX_BULK_TAG_TARGETS } from "./tags-bulk.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

export async function runDetectionTriage(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  action: "set" | "clear",
): Promise<LeafResult> {
  const invalid = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [`Run \`vectra-axi detection triage ${action} --help\``]);
  };
  const raw = flags.get("ids");
  if (typeof raw !== "string") invalid("--ids must contain positive integer detection IDs");
  const entries = (raw as string).split(",").map((value) => value.trim());
  if (entries.some((value) => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
    invalid("--ids must contain positive integer detection IDs");
  }
  const ids = [...new Set(entries.map(Number))].sort((a, b) => a - b);
  if (ids.length > MAX_BULK_TAG_TARGETS) invalid(`Accepts at most ${MAX_BULK_TAG_TARGETS} detection targets per run`);
  const category = flags.get("category");
  if (action === "set" && (typeof category !== "string" || !category.trim())) invalid("--category must be a nonempty label");
  const target = bulkTargetLabel("detection", ids);
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.detection.triage.${action}`,
    method: action === "set" ? "POST" : "DELETE",
    path: `/api/v${session.profile.apiVersion}/rules${session.profile.kind === "rux" ? "/" : ""}`,
    effect: "write", requiresConfirmation: true, target,
    payload: { detectionIdList: ids, ...(action === "set" ? { triage_category: category } : {}) },
  };
  coordinator.preview(definition);
  let baseline: unknown[] | undefined;
  const readState = async (): Promise<unknown[]> => {
    const current = [];
    for (const id of ids) {
      const { body } = await session.request(`${session.profile.kind}.detection.show`, { pathParams: { id } });
      const row = body as Record<string, unknown> | null;
      if (!row || row.id !== id || typeof row.is_triaged !== "boolean") {
        throw new AxiError(`Cannot determine triage state of detection ${id}`, "MALFORMED_RESPONSE", [
          `Read back detection ${id} before retrying`,
        ]);
      }
      current.push({ id, is_triaged: row.is_triaged, triage_rule_id: row.triage_rule_id,
        category: row.category, triage_category: row.triage_category, is_marked_custom: row.is_marked_custom });
    }
    if (baseline && JSON.stringify(current) !== JSON.stringify(baseline)) {
      throw new AxiError("Detection triage state changed since preview", "VERSION_CONFLICT", [
        "Re-run without --execute to preview the current state",
      ]);
    }
    baseline ??= current;
    return current;
  };
  // Detection reads do not reliably identify the current custom label, so do not infer a no-op.
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"), readState,
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
  });
  const common = { profile: session.profile.name, operation: definition.operation, target };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, current: baseline, proposed: definition.payload,
    scoring: "Triage suppresses scoring; clearing triage removes that suppression",
    help: [`Re-run with --execute --confirm '${target}' to ${action} detection triage`],
  } };
  if (result.kind === "success") return { failed: false, output: { ...common, state: action === "set" ? "triage set" : "triage cleared", audit: result.auditId } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  return { failed: true, output: {
    ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Detection triage ${action} rejected with status ${result.status}` : result.guidance,
    help: ["Read back every target with `vectra-axi detection show --profile <name> --id <id>` before doing anything else; never replay an unknown outcome"],
  } };
}
