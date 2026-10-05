import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { NOTE_TRUNCATE_AT, noteOwnerId, type LeafResult, type NoteKind } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

// WRITE-N (2a): desired-state note edit and note delete for one detection,
// host or account through the WRITE-00 gate pipeline.
//
// The upstream contracts are version-specific. On QUX v2.5, VAT
// update_*_note/delete_*_note on the pinned commit send PATCH and DELETE to
// /{plural-kind}/{id}/notes/{note_id} with a {"note"} payload for the edit
// (detection and account gated to the v2 API family, host to v2 or v3.3+,
// so all three hold on a v2.5 profile); the QUX guide's resource sections
// (p17/p24/p30, Appendix A notes) establish the same notes collection the
// item routes extend. On RUX v3.4 the live spec names PATCH
// /api/v3.4/{tvui_types}/{type_id}/notes/{note_id}/ (v3.4_notes_partial_update,
// NotesBodyV3 requires {"note"}) and DELETE on the same item route
// (v3.4_notes_delete); VAT's platform client independently sends PATCH and
// DELETE to .../notes/{note_id} with a {"note"} edit payload. Both
// generations evidence edit and delete routes, so no generation refuses
// either action; profile validation already rejects unknown generations.
//
// Reads come from the READ-03/RUX-04 note list routes (the pre-send state
// source): the item is addressed by owner ID plus note ID, the preview
// shows bounded before/after text (edit) or the note being removed (delete),
// and the pre-send re-read refuses changed text with VERSION_CONFLICT
// unless the fresh state already matches the desired state, which is an
// exit-0 no-op. There is no evidenced ETag contract, so the comparison is
// client-side like WRITE-01/WRITE-03. See docs/implementation-plan.md for
// separately commissioned mutation families.

const noteEntrySchema = z.object({
  id: z.number().int().positive(),
  note: z.string().nullable().optional(),
});

type NoteEntry = { id: number; note?: string | null };

function leaf(kind: NoteKind, action: "edit" | "delete"): string {
  return `${kind} note ${action}`;
}

// The mutation addresses one note exactly: owner plus note ID. Typed
// confirmation must repeat this target verbatim.
function target(kind: NoteKind, id: number, noteId: number): string {
  return `${kind} ${id} note ${noteId}`;
}

// The plural resource segment is identical on both generations:
// detections, hosts, accounts. RUX keeps its documented trailing slash.
function notePath(session: Session, kind: NoteKind, id: number, noteId: number): string {
  const route = `/api/v${session.profile.apiVersion}/${kind}s/${id}/notes/${noteId}`;
  return session.profile.kind === "rux" ? `${route}/` : route;
}

function operation(session: Session, kind: NoteKind, action: "edit" | "delete"): string {
  return `${session.profile.kind}.${kind}.note.${action}`;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function listCommand(
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

// Every note edit/delete names its note up front; a missing or
// non-positive --note-id fails before configuration, profile selection or
// any HTTP call, like --id does for the owner.
export function noteEntryId(flags: ReadonlyMap<string, string | boolean>, command: string): number {
  const raw = flags.get("note-id");
  if (raw === undefined) {
    invalid(`${command} requires --note-id <id>`,
      `Run \`vectra-axi ${command.split(" ").slice(0, 2).join(" ")} list\` to find a note ID`,
      `Example: vectra-axi ${command} --profile <name> --id 42 --note-id 7 --note <text>`);
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--note-id must be a positive integer note ID", "Example: --note-id 7");
  }
  return Number(raw);
}

// The replacement text comes from exactly one of --note (inline text) or
// --note-file (a file path, `-` reads stdin). File content is used exactly
// as read. Empty or whitespace-only text is rejected: clearing is not an
// edit, and deletes have their own leaf. No upstream note length grammar
// is evidenced (VAT type-checks a string only), so no maximum is invented;
// long text is preview-truncated at the READ-03 limit with its total.
export function desiredEditText(
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): string {
  const command = leaf(kind, "edit");
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
      "Use --note-file - to read the replacement text from stdin",
      `Run \`vectra-axi ${command} --help\``);
  }
  if (!note!.trim()) {
    invalid(`${command} requires non-empty replacement text`,
      `To remove the note instead, run \`vectra-axi ${leaf(kind, "delete")}\``,
      `Run \`vectra-axi ${command} --help\``);
  }
  return note!;
}

// Long note text keeps the READ-03 preview shape: the first 1200
// characters with the total, so before/after previews stay bounded.
export function previewNoteText(text: string): string {
  return text.length > NOTE_TRUNCATE_AT
    ? `${text.slice(0, NOTE_TRUNCATE_AT)}\n... (truncated, ${text.length} chars total)`
    : text;
}

async function readNoteEntries(session: Session, kind: NoteKind, id: number): Promise<NoteEntry[]> {
  const { body } = await session.request(`${session.profile.kind}.${kind}.note.list`, { pathParams: { id } });
  if (!Array.isArray(body)) {
    throw new AxiError("Vectra notes response is malformed: expected a list of notes",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  return body.map((entry) => {
    const result = noteEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new AxiError("Vectra notes response is malformed: expected valid note fields",
        "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
    }
    return result.data;
  });
}

function findNote(entries: readonly NoteEntry[], noteId: number): NoteEntry | null {
  return entries.find((entry) => entry.id === noteId) ?? null;
}

function missingNote(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: NoteKind, id: number, noteId: number,
): never {
  throw new AxiError(`note ${noteId} was not found for ${kind} ${id}`,
    "VALIDATION_ERROR",
    [`Read back \`${listCommand(session, flags, kind, id)}\` to find the current note IDs`]);
}

export async function runNoteEdit(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): Promise<LeafResult> {
  const command = leaf(kind, "edit");
  const id = noteOwnerId(flags, command, kind);
  const noteId = noteEntryId(flags, command);
  const desired = desiredEditText(flags, kind, readStdin);
  if (flags.has("execute") && flags.has("dry-run")) {
    throw new AxiError("--dry-run cannot be combined with --execute", "VALIDATION_ERROR", [
      "Omit --execute to preview the mutation without sending it",
    ]);
  }
  const owner = target(kind, id, noteId);
  // The routing read runs before the coordinator: an edit needs the
  // current text for its before/after preview, so a missing note is
  // refused before any preview rather than sent blind. The coordinator's
  // preview read reuses it, and the pre-send re-read repeats it for the
  // conflict check.
  const routed = findNote(await readNoteEntries(session, kind, id), noteId);
  if (routed === null) missingNote(session, flags, kind, id, noteId);
  const definition: MutationDefinition = {
    operation: operation(session, kind, "edit"),
    method: "PATCH",
    path: notePath(session, kind, id, noteId),
    effect: "write",
    requiresConfirmation: true,
    target: owner,
    payload: { note: desired },
  };
  let baseline: NoteEntry | undefined;
  const readState = async (): Promise<NoteEntry | null> => {
    if (baseline === undefined) {
      baseline = routed;
      return routed;
    }
    const fresh = findNote(await readNoteEntries(session, kind, id), noteId);
    if (fresh === null) {
      throw new AxiError(
        `blocked: note ${noteId} for ${kind} ${id} was deleted since the preview; re-run to preview the new state`,
        "VERSION_CONFLICT",
        [`Read back \`${listCommand(session, flags, kind, id)}\` to find the current note IDs`],
      );
    }
    if (fresh.note !== baseline.note && fresh.note !== desired) {
      throw new AxiError(
        `blocked: note ${noteId} for ${kind} ${id} changed since the preview; re-run to preview the new state`,
        "VERSION_CONFLICT",
        [`Read back \`${listCommand(session, flags, kind, id)}\` to inspect the current text`],
      );
    }
    return fresh;
  };
  const result = await coordinator.execute(definition, {
    ...(flags.has("execute") ? { execute: true } : {}),
    ...(flags.has("dry-run") ? { dryRun: true } : {}),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState,
    isNoop: (current: unknown) =>
      typeof current === "object" && current !== null && (current as NoteEntry).note === desired,
  });
  const profile = session.profile.name;
  const before = routed.note ?? null;
  if (result.kind === "dry-run") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      noteId,
      operation: definition.operation,
      before: before === null ? null : previewNoteText(before),
      after: previewNoteText(desired),
      ...(result.preview.noop
        ? { state: `note ${noteId} for ${kind} ${id} already matches (no-op)` }
        : { help: [`Re-run with --execute --confirm '${owner}' to replace the text of note ${noteId} for ${kind} ${id}`] }),
    } };
  }
  if (result.kind === "noop") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      noteId,
      operation: definition.operation,
      note: `note ${noteId} for ${kind} ${id} already matches (no-op)`,
    } };
  }
  if (result.kind === "success") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      noteId,
      operation: definition.operation,
      after: desired,
      audit: result.auditId,
    } };
  }
  if (result.kind === "failed") {
    return { failed: true, output: {
      profile,
      type: kind,
      id,
      noteId,
      operation: definition.operation,
      error: `note edit for ${owner} was rejected with status ${result.status}`,
      audit: result.auditId,
      help: [`Read back \`${listCommand(session, flags, kind, id)}\` before doing anything else`],
    } };
  }
  return { failed: true, output: {
    profile,
    type: kind,
    id,
    noteId,
    operation: definition.operation,
    error: result.guidance,
    audit: result.auditId,
  } };
}

export async function runNoteDelete(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
): Promise<LeafResult> {
  const command = leaf(kind, "delete");
  const id = noteOwnerId(flags, command, kind);
  const noteId = noteEntryId(flags, command);
  const owner = target(kind, id, noteId);
  const definition: MutationDefinition = {
    operation: operation(session, kind, "delete"),
    method: "DELETE",
    path: notePath(session, kind, id, noteId),
    effect: "write",
    requiresConfirmation: true,
    target: owner,
  };
  // The coordinator reads once for the preview and re-reads before the
  // single send. A missing note is already-deleted state: the preview
  // reports a no-op and execution sends nothing. A note whose text moved
  // since the preview refuses the send rather than removing text that was
  // never previewed; the refusal is recorded as NOT_SENT.
  let baseline: NoteEntry | null | undefined;
  const readState = async (): Promise<NoteEntry | null> => {
    const current = findNote(await readNoteEntries(session, kind, id), noteId);
    if (baseline === undefined) {
      baseline = current;
      return current;
    }
    if (current !== null && (baseline === null || current.note !== baseline.note)) {
      throw new AxiError(
        `blocked: note ${noteId} for ${kind} ${id} changed since the preview; re-run to preview the new state`,
        "VERSION_CONFLICT",
        [`Read back \`${listCommand(session, flags, kind, id)}\` to inspect the current text`],
      );
    }
    return current;
  };
  const result = await coordinator.execute(definition, {
    ...(flags.has("execute") ? { execute: true } : {}),
    ...(flags.has("dry-run") ? { dryRun: true } : {}),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState,
    isNoop: (current: unknown) => current === null,
  });
  const profile = session.profile.name;
  const removed = baseline ?? null;
  if (result.kind === "dry-run") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      noteId,
      operation: definition.operation,
      ...(removed === null
        ? { state: `note ${noteId} for ${kind} ${id} is already deleted (no-op)` }
        : { note: removed.note === undefined || removed.note === null ? null : previewNoteText(removed.note),
          help: [`Re-run with --execute --confirm '${owner}' to delete note ${noteId} for ${kind} ${id}`] }),
    } };
  }
  if (result.kind === "noop") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      noteId,
      operation: definition.operation,
      note: `note ${noteId} for ${kind} ${id} is already deleted (no-op)`,
    } };
  }
  if (result.kind === "success") {
    const text = removed?.note ?? null;
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      noteId,
      operation: definition.operation,
      note: text === null ? null : previewNoteText(text),
      audit: result.auditId,
    } };
  }
  if (result.kind === "failed") {
    return { failed: true, output: {
      profile,
      type: kind,
      id,
      noteId,
      operation: definition.operation,
      error: `note delete for ${owner} was rejected with status ${result.status}`,
      audit: result.auditId,
      help: [`Read back \`${listCommand(session, flags, kind, id)}\` before doing anything else`],
    } };
  }
  return { failed: true, output: {
    profile,
    type: kind,
    id,
    noteId,
    operation: definition.operation,
    error: result.guidance,
    audit: result.auditId,
  } };
}
