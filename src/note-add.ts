import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { noteOwnerId, type LeafResult, type NoteKind } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

// WRITE-02: action-shaped note append for one detection, host or account.
// The upstream contract (VAT set_*_note on the pinned commit) is POST
// /{plural-kind}/{id}/notes with a {"note"} payload, so "append this exact
// note" maps directly: read the current notes through the READ-03 route to
// confirm the target exists and is permitted, preview the exact note text as
// the dry run, and send exactly once. Every execution appends one note;
// repeated identical notes each send and are never collapsed into a no-op.
// There is no evidenced ETag contract, and a concurrent append between the
// preview read and the pre-send re-read is compatible, so no conflict
// comparison is invented. Note edits and deletes have no evidenced contract
// and no leaf here.

function leaf(kind: NoteKind): string {
  return `${kind} note add`;
}

function target(kind: NoteKind, id: number): string {
  return `${kind} ${id}`;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function noteListCommand(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: NoteKind, id: number,
): string {
  const config = flags.get("config");
  return `vectra-axi ${kind} note list`
    + `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --id ${id}`;
}

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

// The note comes from exactly one of --note (inline text) or --note-file
// (a file path, `-` reads stdin). File content is appended exactly as read.
// Empty or whitespace-only notes are rejected: clearing, editing and
// deleting notes have no evidenced contract and no leaf. No upstream note
// length grammar is evidenced (VAT type-checks a string only), so no maximum
// is invented here.
export function desiredNote(
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): string {
  const command = leaf(kind);
  const inline = flags.get("note");
  const file = flags.get("note-file");
  if (inline !== undefined && file !== undefined) {
    invalid("--note cannot be combined with --note-file",
      `Run \`vectra-axi ${command} --help\``);
  }
  let note: string;
  if (typeof inline === "string") {
    note = inline;
  } else if (typeof file === "string" && file) {
    note = file === "-" ? readStdin() : readFileSync(file, "utf8");
  } else {
    invalid(`${command} requires --note <text> or --note-file <path>`,
      "Use --note-file - to read the note from stdin",
      `Run \`vectra-axi ${command} --help\``);
  }
  if (!note!.trim()) {
    invalid(`${command} requires a non-empty note`,
      "Note edits and deletes are not implemented; only appending is supported",
      `Run \`vectra-axi ${command} --help\``);
  }
  return note!;
}

export async function runNoteAdd(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): Promise<LeafResult> {
  const command = leaf(kind);
  const id = noteOwnerId(flags, command, kind);
  const note = desiredNote(flags, kind, readStdin);
  const owner = target(kind, id);
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.${kind}.note.add`,
    method: "POST",
    path: `/api/v${session.profile.apiVersion}/${kind}s/${id}/notes`,
    effect: "write",
    requiresConfirmation: true,
    target: owner,
    payload: { note },
  };
  // The coordinator reads once for the preview and re-reads before the
  // single send. The read confirms the target exists and stays permitted;
  // its entries are never compared, so a concurrent append never blocks
  // this one and a repeated note is never dropped as already-desired.
  const readState = async (): Promise<unknown> => {
    const { body } = await session.request(`qux.${kind}.note.list`, { pathParams: { id } });
    if (!Array.isArray(body)) {
      throw new AxiError("Vectra notes response is malformed: expected a list of notes",
        "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
    }
    return body;
  };
  const result = await coordinator.execute(definition, {
    ...(flags.has("execute") ? { execute: true } : {}),
    ...(flags.has("dry-run") ? { dryRun: true } : {}),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState,
    isNoop: () => false,
  });
  const profile = session.profile.name;
  if (result.kind === "dry-run") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      note,
      help: [`Re-run with --execute --confirm '${owner}' to append the note to ${owner}`],
    } };
  }
  if (result.kind === "noop") {
    throw new Error(`Unreachable note-add no-op for ${owner}: action-shaped appends never report no-op`);
  }
  if (result.kind === "success") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      note,
      audit: result.auditId,
    } };
  }
  if (result.kind === "failed") {
    return { failed: true, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      error: `note append for ${owner} was rejected with status ${result.status}`,
      audit: result.auditId,
      help: [`Read back \`${noteListCommand(session, flags, kind, id)}\` before doing anything else`],
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
