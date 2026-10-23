import { AxiError } from "axi-sdk-js";
import { desiredNote } from "./note-add.js";
import type { LeafResult, NoteKind } from "./notes.js";
import type { Session } from "./session.js";
import { bulkTargetLabel } from "./tags-bulk.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

export async function runNoteBulk(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
): Promise<LeafResult> {
  const command = `${kind} note bulk-add`;
  const invalid = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [`Run \`vectra-axi ${command} --help\``]);
  };
  if (session.profile.kind !== "rux") invalid(`${command} requires a RUX v3.4 profile`);
  const raw = flags.get("ids");
  if (typeof raw !== "string") invalid("--ids must list positive integer IDs");
  const entries = (raw as string).split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !/^\d+$/.test(entry) || !Number.isSafeInteger(Number(entry)) || Number(entry) < 1)) {
    invalid("--ids must list positive integer IDs");
  }
  const ids = [...new Set(entries.map(Number))].sort((a, b) => a - b);
  if (ids.length > 100) invalid("Accepts at most 100 targets per run; split larger sets into separately confirmed runs");
  const note = desiredNote(flags, kind, undefined, command);
  const target = bulkTargetLabel(kind, ids);
  const definition: MutationDefinition = {
    operation: `rux.${kind}.note.bulk-add`,
    method: "POST",
    path: `/api/v3.4/${kind}s/notes/`,
    effect: "write",
    requiresConfirmation: true,
    target,
    payload: { note, objectIds: ids },
  };
  const readState = async (): Promise<void> => {
    for (const id of ids) {
      const { body } = await session.request(`rux.${kind}.note.list`, { pathParams: { id } });
      if (!Array.isArray(body)) {
        throw new AxiError("Vectra notes response is malformed: expected a list of notes", "RESPONSE_INVALID");
      }
    }
  };
  // Appends are compatible with concurrent appends and never collapse into a no-op.
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"),
    dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState,
    isNoop: () => false,
  });
  const common = { profile: session.profile.name, operation: definition.operation, target, count: ids.length };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, note,
    help: [`Re-run with --execute --confirm '${target}' to append the note to ${target}`],
  } };
  if (result.kind === "success") return { failed: false, output: { ...common, note, audit: result.auditId } };
  if (result.kind === "noop") throw new Error("Bulk note appends never report no-op");
  return { failed: true, output: {
    ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Bulk note append was rejected with status ${result.status}` : result.guidance,
  } };
}
