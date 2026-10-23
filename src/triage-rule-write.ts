import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

const conditionValue = z.strictObject({
  value: z.union([z.string(), z.number()]), label: z.string(),
  url: z.string().nullable().optional(),
});
const operand = z.strictObject({
  field: z.string().min(1), label: z.string(),
  values: z.array(conditionValue), groups: z.array(conditionValue),
});
const leaf = z.union([z.strictObject({ ANY_OF: operand }), z.strictObject({ NONE_OF: operand })]);
const tree = z.strictObject({ OR: z.tuple([z.strictObject({ AND: z.array(leaf) })]) });
const rule = z.strictObject({
  description: z.string(), detection_category: z.string().min(1),
  triage_category: z.string().refine((value) => value.trim().length > 0), detection: z.string().min(1),
  is_whitelist: z.boolean(), source_conditions: tree.nullable(), additional_conditions: tree.nullable(),
});
const risk = "High: org-wide triage automation can suppress future detections; replacement and deletion affect every matching entity";

export async function runTriageRuleWrite(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  action: "create" | "edit" | "delete",
  readStdin: () => string = () => readFileSync(0, "utf8"),
): Promise<LeafResult> {
  const invalid = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [`Run \`vectra-axi triage rule ${action} --help\``]);
  };
  const rawId = flags.get("id");
  if (action !== "create" && (typeof rawId !== "string" || !/^\d+$/.test(rawId)
    || !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 1)) invalid("--id must be a positive integer");
  const id = Number(rawId);
  let payload: z.infer<typeof rule> | undefined;
  if (action !== "delete") {
    const file = flags.get("rule-file");
    if (typeof file !== "string" || !file.trim()) invalid("--rule-file <path|-> is required (JSON only)");
    let value: unknown;
    try {
      value = JSON.parse(file === "-" ? readStdin() : readFileSync(file as string, "utf8"));
    } catch {
      invalid("Cannot read --rule-file as JSON");
    }
    const parsed = rule.safeParse(value);
    if (!parsed.success) invalid("Invalid rule: supply description, detection_category, triage_category, detection, is_whitelist and both condition trees; each non-null tree must be OR with one AND child and ANY_OF/NONE_OF leaves (field, label, values, groups)");
    payload = parsed.data;
  }
  const target = action === "create" ? "new triage rule" : `triage rule ${id}`;
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.triage-rule.${action}`,
    method: action === "create" ? "POST" : action === "edit" ? "PUT" : "DELETE",
    path: `/api/v${session.profile.apiVersion}/rules${action === "create" ? "" : `/${id}`}${session.profile.kind === "rux" ? "/" : ""}`,
    effect: "write", requiresConfirmation: true, target,
    ...(payload ? { payload } : {}),
  };
  coordinator.preview(definition);
  let before: Record<string, unknown> | undefined;
  const readState = async (): Promise<unknown> => {
    if (action === "create") return null;
    const { body } = await session.request(`${session.profile.kind}.triage-rule.show`, {
      pathParams: session.profile.kind === "rux" ? { rule_id: id } : { id },
    });
    if (!body || typeof body !== "object" || Array.isArray(body)
      || (body as Record<string, unknown>).id !== id || typeof (body as Record<string, unknown>).enabled !== "boolean") {
      throw new AxiError(`Cannot determine state of ${target}`, "MALFORMED_RESPONSE", ["Read the rule before retrying"]);
    }
    // Compare the full response, including fields the read display does not project.
    if (before && !isDeepStrictEqual(before, body)) {
      throw new AxiError(`${target} changed before sending`, "VERSION_CONFLICT", ["Preview the changed rule before retrying"]);
    }
    before = body as Record<string, unknown>;
    return before;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"), readState,
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
  });
  const common = { profile: session.profile.name, operation: definition.operation, target, risk };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, before: before ?? null, after: payload ?? null,
    help: [`Re-run with --execute --confirm '${target}' to ${action} the org-wide rule`],
  } };
  if (result.kind === "success") return { failed: false, output: { ...common, state: "success", audit: result.auditId } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "no-op" } };
  return { failed: true, output: {
    ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Triage rule ${action} rejected with status ${result.status}` : result.guidance,
    help: ["Read back with `vectra-axi triage rule list` or `vectra-axi triage rule show --id <id>` before doing anything else; never replay an unknown outcome"],
  } };
}
