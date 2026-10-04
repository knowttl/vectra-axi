import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { collect, DEFAULT_COLLECTION_LIMIT, resume } from "./collections.js";
import { embeddedNoteSummary } from "./notes.js";
import type { Session } from "./session.js";

// READ-02: QUX host/account lookup plus the type-qualified entity facade, on
// the CORE-01 session and CORE-02 collection reader. QUX has no merged entity
// route: `entity list`/`entity show` require --type and run through the
// matching qux.entity.* inventory record. An untyped entity
// read is rejected rather than merged into an artificial cross-kind ranking.
// Numeric IDs stay scoped to their kind: host 7 and account 7 are different
// objects. Display fields keep the QUX threat/certainty labels while CLI
// score filters map to the wire t_score_gte/c_score_gte keys. Notes/tags stay
// READ-03.

export const HOST_LIST_OPERATION = "qux.host.list";
export const HOST_SHOW_OPERATION = "qux.host.show";
export const ACCOUNT_LIST_OPERATION = "qux.account.list";
export const ACCOUNT_SHOW_OPERATION = "qux.account.show";
// RUX-02: the same caller operations run against the documented v3.4 routes
// on a cloud profile. Host/account threat/certainty keep their QUX labels;
// the entities route instead returns urgency_score/importance as distinct
// fields that are never folded into threat/certainty. Cloud IDs stay scoped
// to their cloud profile: no on-prem identity translation in any show.
export const RUX_HOST_LIST_OPERATION = "rux.host.list";
export const RUX_HOST_SHOW_OPERATION = "rux.host.show";
export const RUX_ACCOUNT_LIST_OPERATION = "rux.account.list";
export const RUX_ACCOUNT_SHOW_OPERATION = "rux.account.show";
export const RUX_ENTITY_LIST_OPERATION = "rux.entity.list";
export const RUX_ENTITY_SHOW_OPERATION = "rux.entity.show";
export const ENTITY_HOST_LIST_OPERATION = "qux.entity.host.list";
export const ENTITY_HOST_SHOW_OPERATION = "qux.entity.host.show";
export const ENTITY_ACCOUNT_LIST_OPERATION = "qux.entity.account.list";
export const ENTITY_ACCOUNT_SHOW_OPERATION = "qux.entity.account.show";

export const ENTITY_KINDS = ["host", "account"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const HOST_LIST_FIELDS = ["id", "name", "state", "threat", "certainty"] as const;
export const ENTITY_LIST_FIELDS = ["id", "name", "threat", "certainty"] as const;
// The v3.4 entities route returns urgency/importance instead of scores, so
// the RUX facade projects its own recorded field subset.
export const RUX_ENTITY_LIST_FIELDS = ["id", "name", "type", "urgency_score", "importance"] as const;
const RUX_ENTITY_DETAIL_FIELDS = ["id", "name", "urgency_score", "importance"] as const;

type ListQuery = Record<string, string | number | boolean>;

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

function integerFlag(flags: ReadonlyMap<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    invalid(`--${name} must be a non-negative integer`, `Example: --${name} 42`);
  }
  return Number(raw);
}

function numberFlag(flags: ReadonlyMap<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(Number(raw))) {
    invalid(`--${name} must be a number`, `Example: --${name} 70`);
  }
  return Number(raw);
}

// The entity facade has no route of its own: --type selects the host or
// account operation before any credential or HTTP work. Anything else,
// including a missing --type, is rejected so no merged host/account ranking
// can be constructed.
export function entityKind(flags: ReadonlyMap<string, string | boolean>): EntityKind {
  const raw = flags.get("type");
  if (raw === undefined) {
    invalid("entity reads require --type <host|account>",
      "QUX has no merged entity route; name one kind at a time",
      "Example: vectra-axi entity list --profile <name> --type host");
  }
  if (typeof raw !== "string" || !(ENTITY_KINDS as readonly string[]).includes(raw)) {
    invalid(`--type must be one of: ${ENTITY_KINDS.join(", ")}`,
      "Example: vectra-axi entity list --profile <name> --type host");
  }
  return raw as EntityKind;
}

function listOperation(kind: EntityKind, facade: boolean, rux: boolean): string {
  if (rux) {
    if (facade) return RUX_ENTITY_LIST_OPERATION;
    return kind === "host" ? RUX_HOST_LIST_OPERATION : RUX_ACCOUNT_LIST_OPERATION;
  }
  if (facade) return kind === "host" ? ENTITY_HOST_LIST_OPERATION : ENTITY_ACCOUNT_LIST_OPERATION;
  return kind === "host" ? HOST_LIST_OPERATION : ACCOUNT_LIST_OPERATION;
}

function showOperation(kind: EntityKind, facade: boolean, rux: boolean): string {
  if (rux) {
    if (facade) return RUX_ENTITY_SHOW_OPERATION;
    return kind === "host" ? RUX_HOST_SHOW_OPERATION : RUX_ACCOUNT_SHOW_OPERATION;
  }
  if (facade) return kind === "host" ? ENTITY_HOST_SHOW_OPERATION : ENTITY_ACCOUNT_SHOW_OPERATION;
  return kind === "host" ? HOST_SHOW_OPERATION : ACCOUNT_SHOW_OPERATION;
}

// Validates list flags and maps them to server-side query keys. Score filters
// keep their display names at the CLI while the wire uses t_score/c_score on
// both generations (the v3.4 host/account routes document the same keys).
// The entities route exposes no score query: on a cloud facade the score
// flags are refused explicitly instead of silently listing unfiltered rows.
// Resuming with --cursor replays the bound query, so the original filters
// must be repeated; resume() rejects a changed query context explicitly.
export function listQuery(flags: ReadonlyMap<string, string | boolean>, facade = false, rux = false): ListQuery {
  const query: ListQuery = {};
  if (facade && rux) {
    for (const flag of ["threat-gte", "certainty-gte"] as const) {
      if (flags.has(flag)) {
        invalid(`Unsupported RUX v3.4 entity filter: --${flag}`,
          "The entities route has no threat/certainty score query; urgency_score and importance arrive as response fields",
          "Omit the score filter, or filter host/account scores through host list and account list on a cloud profile");
      }
    }
    query.type = entityKind(flags);
  }
  const tags = flags.get("tags");
  if (tags !== undefined) query.tags = tags;
  for (const [flag, key] of [["min-id", "min_id"], ["max-id", "max_id"]] as const) {
    if (facade && flags.has(flag)) {
      invalid(`Unsupported entity filter: ${key}`, "Use host list or account list for min/max ID filters");
    }
    const parsed = integerFlag(flags, flag);
    if (parsed !== undefined) query[key] = parsed;
  }
  for (const [flag, key] of [["threat-gte", "t_score_gte"], ["certainty-gte", "c_score_gte"]] as const) {
    const parsed = numberFlag(flags, flag);
    if (parsed !== undefined) query[key] = parsed;
  }
  return query;
}

export function listLimit(flags: ReadonlyMap<string, string | boolean>): number {
  const raw = flags.get("limit");
  if (raw === undefined) return DEFAULT_COLLECTION_LIMIT;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--limit must be a positive integer row limit", "Example: --limit 20");
  }
  return Number(raw);
}

// Client-side projection over the inventory's field subset: the direct
// host/account leaves keep state on both generations, the QUX facade keeps
// scores, and the RUX facade keeps the entity type with urgency/importance.
// Unknown fields fail explicitly instead of silently returning short rows.
export function listFields(flags: ReadonlyMap<string, string | boolean>, facade = false, rux = false): readonly string[] {
  const allowed: readonly string[] = !facade ? HOST_LIST_FIELDS
    : rux ? RUX_ENTITY_LIST_FIELDS : ENTITY_LIST_FIELDS;
  const raw = flags.get("fields");
  if (raw === undefined) return allowed;
  const fields = String(raw).split(",").map((field) => field.trim()).filter(Boolean);
  const unknown = fields.filter((field) => !allowed.includes(field));
  if (fields.length === 0 || unknown.length > 0) {
    invalid(`Unknown --fields value: ${unknown.join(", ") || "(empty)"}`,
      `Supported fields: ${allowed.join(", ")}`);
  }
  return [...new Set(fields)];
}

const entitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  threat: z.number().nullable().optional(),
  certainty: z.number().nullable().optional(),
});

function decodeEntity<T>(value: unknown, schema: z.ZodType<T>, contract = "QUX v2.5", what = "host/account"): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AxiError(`Vectra entity response is malformed: expected valid ${what} fields`,
      "RESPONSE_INVALID", [`Check the ${contract} API contract for this operation`]);
  }
  return result.data;
}

// The v3.4 entity record carries urgency/importance as its scoring fields:
// urgency_score is an integer priority, importance an integer value score.
// Both stay distinct from threat/certainty and preserve nulls like scores do.
const ruxEntitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  urgency_score: z.number().nullable().optional(),
  importance: z.number().nullable().optional(),
});

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
}

function plural(kind: EntityKind): string {
  return kind === "host" ? "hosts" : "accounts";
}

function summarizeFilters(query: ListQuery): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return "with no filters";
  return `with ${entries.map(([key, value]) => `${key} ${value}`).join(", ")}`;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function showCommand(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: EntityKind, id: unknown, facade: boolean,
): string {
  const config = flags.get("config");
  const where = facade ? "entity" : kind;
  const type = facade ? ` --type ${shellQuote(kind)}` : "";
  return `vectra-axi ${where} show${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)}${type} --id ${shellQuote(String(id))}`;
}

function noteListCommand(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: EntityKind, id: unknown,
): string {
  const config = flags.get("config");
  return `vectra-axi ${kind} note list${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --id ${shellQuote(String(id))}`;
}

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

// Runs one kind's bounded list window and shapes the AXI output. Partial
// collection results keep their validated rows with complete:false, an inline
// error and a cursor; the caller reports them with a nonzero exit status.
async function runKindList(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: EntityKind, facade: boolean,
): Promise<LeafResult> {
  const rux = session.profile.kind === "rux";
  const query = listQuery(flags, facade, rux);
  const limit = listLimit(flags);
  const fields = listFields(flags, facade, rux);
  const cursor = flags.get("cursor");
  const operation = listOperation(kind, facade, rux);
  const decodeRow = (row: unknown): Record<string, unknown> => rux && facade
    ? decodeEntity(row, ruxEntitySchema, "RUX v3.4", "entity")
    : decodeEntity(row, entitySchema, rux ? "RUX v3.4" : "QUX v2.5");
  const result = typeof cursor === "string"
    ? await resume(session, operation, cursor, { query, limit, decodeRow })
    : await collect(session, operation, { query, limit, decodeRow });
  const rows = result.rows.map((row) => project(row, fields));
  const nouns = plural(kind);
  const shown = rows.length;
  const count = result.total === null || result.total === shown
    ? `${shown} ${nouns}`
    : `${shown} of ${result.total} ${nouns}`;
  const profile = session.profile.name;
  const rowsKey = facade ? "entities" : nouns;
  if (result.error) {
    const failure = result.error;
    return { failed: true, output: {
      profile,
      ...(facade ? { type: kind } : {}),
      total: result.total,
      count,
      [rowsKey]: rows,
      complete: false,
      error: failure.message,
      code: failure.code,
      ...(result.cursor ? { cursor: result.cursor } : {}),
      help: [...failure.suggestions,
        ...(result.cursor ? ["Pass --cursor <cursor> with the same filters to resume the pending page"] : [])],
    } };
  }
  if (shown === 0) {
    return { failed: false, output: {
      profile,
      ...(facade ? { type: kind } : {}),
      total: result.total,
      count,
      [rowsKey]: `0 ${nouns} found ${summarizeFilters(query)}`,
      complete: true,
      help: ["Widen the filters or omit them to list every entity of this kind"],
    } };
  }
  const firstId = result.rows[0]!.id;
  return { failed: false, output: {
    profile,
    ...(facade ? { type: kind } : {}),
    total: result.total,
    count,
    [rowsKey]: rows,
    complete: true,
    ...(result.cursor ? { cursor: result.cursor } : {}),
    help: [
      ...(result.cursor ? ["Pass --cursor <cursor> with the same filters for the next window"] : []),
      `Run \`${showCommand(session, flags, kind, firstId, facade)}\` for full detail`,
    ],
  } };
}

export async function runHostList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  return runKindList(session, flags, "host", false);
}

export async function runAccountList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  return runKindList(session, flags, "account", false);
}

export async function runEntityList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  return runKindList(session, flags, entityKind(flags), true);
}

export function showId(flags: ReadonlyMap<string, string | boolean>, leaf: string): number {
  const raw = flags.get("id");
  if (raw === undefined) {
    invalid(`${leaf} requires --id <id>`,
      `Run \`vectra-axi ${leaf.replace(" show", " list")}\` to find an ID`,
      "Example: vectra-axi host show --profile <name> --id 19");
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--id must be a positive integer entity ID", "Example: --id 19");
  }
  return Number(raw);
}

// Shows one host or account. The output retains the resource kind alongside
// the decoded detail, so the next command can name the same kind and ID.
// An embedded note summary is surfaced under its own key with a pointer to
// the full notes resource; show output never presents it as full notes.
async function runKindShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: EntityKind, leaf: string, facade: boolean,
): Promise<LeafResult> {
  const rux = session.profile.kind === "rux";
  const id = showId(flags, leaf);
  // The entities detail route requires its type selector; host/account
  // detail routes take none. The cloud ID stays scoped to its profile.
  const { body } = await session.request(showOperation(kind, facade, rux),
    rux && facade ? { pathParams: { id }, query: { type: kind } } : { pathParams: { id } });
  if (rux && facade) {
    const entity = decodeEntity(body, ruxEntitySchema, "RUX v3.4", "entity");
    return { failed: false, output: {
      profile: session.profile.name,
      type: kind,
      ...project(entity, RUX_ENTITY_DETAIL_FIELDS),
    } };
  }
  const detail = decodeEntity(body, entitySchema, rux ? "RUX v3.4" : "QUX v2.5");
  const fields = facade ? ENTITY_LIST_FIELDS : HOST_LIST_FIELDS;
  const summary = embeddedNoteSummary(body);
  return { failed: false, output: {
    profile: session.profile.name,
    type: kind,
    ...project(detail, fields),
    // RUX notes/tags arrive in RUX-04: the embedded summary stays visible
    // under its own key, but no note-list hint points at a leaf the cloud
    // profile cannot serve yet.
    ...(summary !== undefined ? { note_summary: summary } : {}),
    ...(summary !== undefined && !rux
      ? { help: [`Run \`${noteListCommand(session, flags, kind, id)}\` for the full notes`] }
      : {}),
  } };
}

export async function runHostShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  return runKindShow(session, flags, "host", "host show", false);
}

export async function runAccountShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  return runKindShow(session, flags, "account", "account show", false);
}

export async function runEntityShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const kind = entityKind(flags);
  return runKindShow(session, flags, kind, "entity show", true);
}
