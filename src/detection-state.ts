import { AxiError } from "axi-sdk-js";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import { bulkTargetLabel, MAX_BULK_TAG_TARGETS } from "./tags-bulk.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

export async function runDetectionState(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  action: "close" | "open" | "fixed set",
): Promise<LeafResult> {
  const invalid = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [`Run \`vectra-axi detection ${action} --help\``]);
  };
  const single = flags.get("id");
  const bulk = flags.get("ids");
  if ((single === undefined) === (bulk === undefined)) invalid("Specify exactly one of --id or --ids");
  const raw = single ?? bulk;
  if (typeof raw !== "string") invalid("Detection IDs must be positive integers");
  const entries = (raw as string).split(",").map((value) => value.trim());
  if (single !== undefined && entries.length !== 1
    || entries.some((value) => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
    invalid("Detection IDs must be positive integers");
  }
  const ids = [...new Set(entries.map(Number))].sort((a, b) => a - b);
  if (ids.length > MAX_BULK_TAG_TARGETS) invalid(`Accepts at most ${MAX_BULK_TAG_TARGETS} detection targets per run`);
  const reason = flags.get("reason");
  const fixed = action === "fixed set";
  const value = flags.get("value");
  if (fixed && value !== "true" && value !== "false") invalid("--value must be true or false");
  if (action === "close" && reason !== "remediated" && reason !== "benign") {
    invalid("--reason must be remediated or benign");
  }
  const release = session.profile.kind === "qux" ? session.profile.applianceRelease : undefined;
  if (!fixed && release !== undefined && /^\d+(?:\.\d+)*$/.test(release)) {
    const [major, minor = 0] = release.split(".").map(Number);
    if (major! < 9 || major === 9 && minor < 3) invalid(`detection ${action} requires appliance release 9.3 or later (profile reports ${release})`);
  }
  const target = single !== undefined ? `detection ${ids[0]}` : bulkTargetLabel("detection", ids);
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.detection.${fixed ? "fixed.set" : `${action}${single === undefined ? "-bulk" : ""}`}`,
    method: "PATCH",
    path: fixed
      ? `/api/v${session.profile.apiVersion}/detections${session.profile.kind === "rux" ? `/${single !== undefined ? `${ids[0]}/` : ""}` : ""}`
      : `/api/v${session.profile.apiVersion}/detections/${single !== undefined ? `${ids[0]}/` : ""}${action}${session.profile.kind === "rux" ? "/" : ""}`,
    effect: "write",
    requiresConfirmation: true,
    target,
    ...(fixed ? { payload: {
      ...(session.profile.kind === "qux" || single === undefined ? { detectionIdList: ids } : {}),
      mark_as_fixed: value === "true",
    } } : action === "close" || single === undefined ? { payload: {
      ...(single === undefined ? { detectionIdList: ids } : {}),
      ...(action === "close" ? { reason } : {}),
    } } : {}),
  };
  // Refuse disabled operations before reading any target.
  coordinator.preview(definition);
  let baseline: { id: number; state: string }[] | undefined;
  const desired = (state: string): boolean => fixed ? (state === "fixed") === (value === "true") : action === "close" ? state === "closed" : state !== "closed";
  const readState = async (): Promise<{ id: number; state: string }[]> => {
    const current = [];
    for (const id of ids) {
      const { body } = await session.request(`${session.profile.kind}.detection.show`, { pathParams: { id } });
      const row = body as { id?: unknown; state?: unknown } | null;
      if (!row || row.id !== id || typeof row.state !== "string" || !row.state) {
        throw new AxiError(`Cannot determine state of detection ${id}`, "MALFORMED_RESPONSE", [
          `Read back detection ${id} before retrying`,
        ]);
      }
      current.push({ id, state: row.state });
    }
    if (baseline && current.some((row, index) => row.state !== baseline![index]!.state && !desired(row.state))) {
      throw new AxiError("Detection state changed since preview", "VERSION_CONFLICT", [
        "Re-run without --execute to preview the current state",
      ]);
    }
    baseline ??= current;
    return current;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"),
    dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState,
    isNoop: (current) => (current as { state: string }[]).every((row) => desired(row.state)),
  });
  const common = { profile: session.profile.name, operation: definition.operation, target };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, current: baseline, desired: fixed ? value === "true" : action === "close" ? "closed" : "open",
    ...(fixed ? { warning: "Marking fixed zeroes detection scores. Detection close supersedes mark-fixed on release 9.3 and later." } : {}),
    ...(definition.payload ? { proposed: definition.payload } : {}),
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to ${action} ${target}`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, ...(fixed ? { mark_as_fixed: value === "true" } : { state: action === "close" ? "closed" : "opened" }), audit: result.auditId } };
  return { failed: true, output: {
    ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Detection ${action} rejected with status ${result.status}` : result.guidance,
    help: ["Read back every target with `vectra-axi detection show --profile <name> --id <id>` before doing anything else; never replay an unknown outcome"],
  } };
}
