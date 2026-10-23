import { AxiError } from "axi-sdk-js";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

export async function runHostKeyAsset(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const rawId = flags.get("id");
  const value = flags.get("value");
  if (typeof rawId !== "string" || !/^\d+$/.test(rawId)
    || !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 1
    || value !== "true" && value !== "false") {
    throw new AxiError("--id must be a positive integer and --value must be true or false", "VALIDATION_ERROR", [
      "Run `vectra-axi host key-asset set --help`",
    ]);
  }
  const id = Number(rawId);
  const desired = value === "true";
  const target = `host ${id}`;
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.host.key-asset.set`,
    method: "PATCH",
    path: `/api/v${session.profile.apiVersion}/hosts/${id}${session.profile.kind === "rux" ? "/" : ""}`,
    effect: "write",
    requiresConfirmation: true,
    target,
    payload: { key_asset: session.profile.kind === "qux" ? desired ? "True" : "False" : value },
  };
  coordinator.preview(definition);
  let current: boolean | undefined;
  const readState = async (): Promise<boolean> => {
    const { body } = await session.request(`${session.profile.kind}.host.show`, { pathParams: { id } });
    const row = body as { id?: unknown; key_asset?: unknown } | null;
    const state = row?.key_asset;
    if (!row || row.id !== id || ![true, false, "true", "false", "True", "False"].includes(state as boolean | string)) {
      throw new AxiError(`Cannot determine key-asset state of ${target}`, "MALFORMED_RESPONSE", [
        `Read back ${target} before retrying`,
      ]);
    }
    current = state === true || state === "true" || state === "True";
    return current;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"),
    dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState,
    isNoop: (state) => state === desired,
  });
  const common = { profile: session.profile.name, operation: definition.operation, target };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, current, desired, proposed: definition.payload,
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to set its key-asset state`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, key_asset: desired, audit: result.auditId } };
  return { failed: true, output: {
    ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Host key-asset change rejected with status ${result.status}` : result.guidance,
    help: [`Read back with \`vectra-axi host show --profile ${session.profile.name} --id ${id}\` before doing anything else; never replay an unknown outcome`],
  } };
}
