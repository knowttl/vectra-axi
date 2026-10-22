import { AxiError } from "axi-sdk-js";
import type { EntityKind } from "./entities.js";
import { noteOwnerId, type LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

function invalidResponse(): never {
  throw new AxiError("Malformed entity close read: expected an entity detection_set and detection states",
    "RESPONSE_INVALID", ["Inspect the entity and its detections before closing it"]);
}

export async function runEntityClose(
  session: Session, coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>, kind: EntityKind,
): Promise<LeafResult> {
  const id = noteOwnerId(flags, `${kind} close`, kind);
  const reason = flags.get("reason");
  if (reason !== "remediated" && reason !== "benign") {
    throw new AxiError("--reason must be remediated or benign", "VALIDATION_ERROR",
      [`Run \`vectra-axi ${kind} close --help\``]);
  }
  const { profile } = session;
  if (profile.kind === "qux" && profile.applianceRelease !== undefined) {
    const [major, minor] = profile.applianceRelease.split(".").map(Number);
    if (major! < 9 || major === 9 && minor! < 3) {
      throw new AxiError(`${kind} close requires appliance release 9.3 or later (profile reports ${profile.applianceRelease})`,
        "VALIDATION_ERROR", ["Upgrade the appliance before closing entities"]);
    }
  }
  const target = `${kind} ${id}`;
  const definition: MutationDefinition = {
    operation: `${profile.kind}.${kind}.close`, method: "PATCH",
    path: `/api/v${profile.apiVersion}/${kind}s/${id}/close${profile.kind === "rux" && kind === "host" ? "/" : ""}`,
    effect: "disruptive", requiresConfirmation: true, target, payload: { reason },
  };
  // Check scope before reads, and extract IDs only. Upstream detection URLs
  // may name older API versions; they never become authenticated destinations.
  coordinator.preview(definition);
  let initial: string | undefined;
  let activeDetections = 0;
  const readState = async (): Promise<unknown> => {
    const { body } = await session.request(`${profile.kind}.${kind}.show`, { pathParams: { id } });
    const entity = body as { id?: unknown; detection_set?: unknown } | null;
    if (!entity || entity.id !== id || !Array.isArray(entity.detection_set)) invalidResponse();
    if (entity.detection_set.length > 100) {
      throw new AxiError("Entity close preview is limited to 100 detections; refusing an incomplete count",
        "VALIDATION_ERROR", ["Inspect this entity's detections before closing it through another reviewed workflow"]);
    }
    const ids = entity.detection_set.map((entry: unknown) => {
      const match = typeof entry === "string" ? /\/detections\/(\d+)\/?$/.exec(entry) : null;
      const value = match ? Number(match[1]) : entry;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalidResponse();
      return value as number;
    });
    const active: number[] = [];
    for (const detectionId of [...new Set(ids)].sort((a, b) => a - b)) {
      const { body: detectionBody } = await session.request(`${profile.kind}.detection.show`, { pathParams: { id: detectionId } });
      const detection = detectionBody as { id?: unknown; state?: unknown } | null;
      if (!detection || detection.id !== detectionId || typeof detection.state !== "string" || !detection.state) invalidResponse();
      if (detection.state === "active") active.push(detectionId);
    }
    const snapshot = JSON.stringify(active);
    if (initial !== undefined && snapshot !== initial) {
      throw new AxiError("Active detections changed during entity close", "VERSION_CONFLICT",
        ["Preview again and review the affected detections before confirming"]);
    }
    initial = snapshot;
    activeDetections = active.length;
    return { activeDetections, detectionIds: active };
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState,
  });
  const output = {
    profile: profile.name, type: kind, id, operation: definition.operation,
    effect: definition.effect, reason, activeDetections,
    warning: "Closes all active detections on this entity; there is no single inverse",
  };
  if (result.kind === "dry-run") return { failed: false, output: { ...output,
    help: [`Re-run with --execute --confirm '${target}' to close ${target}`] } };
  if (result.kind === "success") return { failed: false, output: { ...output, audit: result.auditId } };
  if (result.kind === "noop") return { failed: false, output };
  return { failed: true, output: { ...output, audit: result.auditId,
    error: result.kind === "failed" ? `Close for ${target} was rejected with status ${result.status}` : result.guidance } };
}
