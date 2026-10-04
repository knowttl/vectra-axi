import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { Session } from "./session.js";

// READ-03: QUX detection/host/account notes and tags through their actual
// versioned routes. Notes come only from the dedicated notes resource; the
// embedded note summary on detail bodies is decoded separately (see
// embeddedNoteSummary) and never presented as full notes. Tag reads come
// from the /tagging routes. Both families are paging:none single responses,
// so runners use session.request directly. The session authorizes read GETs
// only; tag replaces use the separate coordinator in src/tags.ts and note
// appends in src/note-add.ts.

export const NOTE_KINDS = ["detection", "host", "account"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// RUX-04 (part a): the same note/tag leaves run against the documented v3.4
// routes on a cloud profile. Notes select the plural tvui_types segment
// (detections/hosts/accounts); tags select the singular table segment
// (detection/host/account). Both keep the recorded trailing slash and carry
// no query keys. Cloud IDs stay scoped to their cloud profile: no on-prem
// identity translation happens in any leaf.
export const RUX_NOTE_OPERATIONS: Readonly<Record<NoteKind, string>> = {
  detection: "rux.detection.note.list",
  host: "rux.host.note.list",
  account: "rux.account.note.list",
};
export const RUX_TAG_OPERATIONS: Readonly<Record<NoteKind, string>> = {
  detection: "rux.detection.tag.list",
  host: "rux.host.tag.list",
  account: "rux.account.tag.list",
};

// Longest note text kept inline, following the detection truncation convention.
export const NOTE_TRUNCATE_AT = 1200;

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

function listLeaf(kind: NoteKind): string {
  return kind === "detection" ? "detection list" : `${kind} list`;
}

// Every note/tag leaf names its owner up front; a missing or non-positive
// --id fails before configuration, profile selection or any HTTP call.
export function noteOwnerId(flags: ReadonlyMap<string, string | boolean>, leaf: string, kind: NoteKind): number {
  const raw = flags.get("id");
  if (raw === undefined) {
    invalid(`${leaf} requires --id <id>`,
      `Run \`vectra-axi ${listLeaf(kind)}\` to find an ID`,
      `Example: vectra-axi ${leaf} --profile <name> --id 42`);
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--id must be a positive integer owner ID", "Example: --id 42");
  }
  return Number(raw);
}

// The v3.4 note list answers an array of NoteSerializerV2_2 entries, which
// carry the same id/note pair as QUX plus author/timestamp metadata
// (created_by, date_created, date_modified, modified_by). The shared decoder
// keeps the recorded id/note projection on both generations and ignores the
// extra RUX fields, so no generation invents note content.
const noteSchema = z.object({
  id: z.number().int().positive(),
  note: z.string().nullable().optional(),
});

const tagBodySchema = z.object({ tags: z.string().array() });

// Shared tag-body decoder: the single source for the tagging response
// shape, used by the tag list read and the WRITE-01 desired-state write.
// The v3.4 TaggingSerializerV3 answers the same tags array alongside
// status/tag_id metadata; the decoder keeps the tags on both generations.
export function decodeTags(body: unknown): string[] {
  const result = tagBodySchema.safeParse(body);
  if (!result.success) {
    throw new AxiError("Vectra tags response is malformed: expected a tags list",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  return result.data.tags;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function leafCommand(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: NoteKind, family: "note" | "tag", id: unknown,
): string {
  const config = flags.get("config");
  return `vectra-axi ${kind} ${family} list`
    + `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --id ${shellQuote(String(id))}`;
}

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

// Reads the full notes resource for one owner. Long note text is previewed
// with its total and a --full hint; --full prints the complete returned text
// but cannot restore content the upstream response never returned.
export async function runNoteList(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: NoteKind,
): Promise<LeafResult> {
  const leaf = `${kind} note list`;
  const id = noteOwnerId(flags, leaf, kind);
  const full = flags.has("full");
  const operation = session.profile.kind === "rux" ? RUX_NOTE_OPERATIONS[kind] : `qux.${kind}.note.list`;
  const { body } = await session.request(operation, { pathParams: { id } });
  if (!Array.isArray(body)) {
    throw new AxiError("Vectra notes response is malformed: expected a list of notes",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  const notes = body.map((entry) => {
    const result = noteSchema.safeParse(entry);
    if (!result.success) {
      throw new AxiError("Vectra notes response is malformed: expected valid note fields",
        "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
    }
    return result.data;
  });
  const profile = session.profile.name;
  if (notes.length === 0) {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      count: "0 notes",
      notes: `0 notes found for ${kind} ${id}`,
      complete: true,
    } };
  }
  let truncated = false;
  const rows = notes.map((entry) => {
    const text = entry.note;
    const preview = !full && typeof text === "string" && text.length > NOTE_TRUNCATE_AT;
    if (preview) truncated = true;
    return {
      id: entry.id,
      ...(text === undefined ? {} : { note: preview ? `${text.slice(0, NOTE_TRUNCATE_AT)}\n... (truncated, ${text.length} chars total)` : text }),
    };
  });
  return { failed: false, output: {
    profile,
    type: kind,
    id,
    count: `${notes.length} notes`,
    notes: rows,
    complete: true,
    ...(truncated
      ? { help: [`Run \`${leafCommand(session, flags, kind, "note", id)} --full\` for the complete returned text`] }
      : {}),
  } };
}

// Reads the tags resource for one owner. The response carries the complete
// tag set in one body, so the output is self-contained with no follow-up.
export async function runTagList(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: NoteKind,
): Promise<LeafResult> {
  const leaf = `${kind} tag list`;
  const id = noteOwnerId(flags, leaf, kind);
  const operation = session.profile.kind === "rux" ? RUX_TAG_OPERATIONS[kind] : `qux.${kind}.tag.list`;
  const { body } = await session.request(operation, { pathParams: { id } });
  const tags = decodeTags(body);
  const profile = session.profile.name;
  return { failed: false, output: {
    profile,
    type: kind,
    id,
    count: `${tags.length} tags`,
    tags: tags.length === 0 ? `0 tags found for ${kind} ${id}` : tags,
    complete: true,
  } };
}

// Decodes the embedded note summary some detail bodies carry. It is an
// upstream-truncated summary, not the notes resource: callers surface it
// under a distinct key with a pointer to the note list leaf, and never imply
// that show --full can recover the full notes.
export function embeddedNoteSummary(body: unknown): string | undefined {
  const result = z.object({ note: z.string().nullable().optional() }).safeParse(body);
  if (!result.success) {
    throw new AxiError("Vectra detail response is malformed: expected a valid embedded note summary",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  return typeof result.data.note === "string" ? result.data.note : undefined;
}
