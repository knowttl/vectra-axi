import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { collect, DEFAULT_COLLECTION_LIMIT, resume } from "./collections.js";
import type { Session } from "./session.js";

// READ-04: QUX assignments, assignment outcomes and users on the CORE-01
// session and CORE-02 collection reader. Assignments (the work item) and
// outcomes (the resolution taxonomy) are distinct resources: an assignment is
// unresolved exactly when date_resolved is null, never a missing or zero
// outcome, and each row keeps the host or account ID that names its target
// kind. No assignment mutation exists: resolve/reassign routes stay blocked
// and no PUT/POST/DELETE leaf is declared. Notes/tags stay READ-03.

export const ASSIGNMENT_LIST_OPERATION = "qux.assignment.list";
export const OUTCOME_LIST_OPERATION = "qux.assignment-outcome.list";
export const OUTCOME_SHOW_OPERATION = "qux.assignment-outcome.show";
export const USER_LIST_OPERATION = "qux.user.list";
export const USER_SHOW_OPERATION = "qux.user.show";

// Inventory fields name the wire subset; status is CLI-derived from
// date_resolved so unresolved rows read "unresolved" instead of a bare null.
export const ASSIGNMENT_LIST_FIELDS = ["id", "host_id", "account_id", "date_resolved", "status"] as const;
export const OUTCOME_LIST_FIELDS = ["id", "title", "category", "builtin"] as const;
export const USER_LIST_FIELDS = ["id", "username"] as const;

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

// Validates assignment list flags and maps singular CLI names to the
// inventory's server-side query keys. Values pass through; the server applies
// them, so no client-side outcome taxonomy or timestamp grammar is invented.
// Resuming with --cursor replays the bound query, so the original filters
// must be repeated; resume() rejects a changed query context explicitly.
export function assignmentQuery(flags: ReadonlyMap<string, string | boolean>): ListQuery {
  const query: ListQuery = {};
  for (const [flag, key] of [["account", "accounts"], ["host", "hosts"], ["assignee", "assignees"],
    ["resolution", "resolution"]] as const) {
    const parsed = integerFlag(flags, flag);
    if (parsed !== undefined) query[key] = parsed;
  }
  const resolved = flags.get("resolved");
  if (resolved !== undefined) {
    if (resolved !== "true" && resolved !== "false") {
      invalid("--resolved must be true or false", "Example: --resolved false");
    }
    query.resolved = resolved;
  }
  const createdAfter = flags.get("created-after");
  if (createdAfter !== undefined) {
    if (typeof createdAfter !== "string" || !createdAfter.trim()) {
      invalid("--created-after requires a non-empty value", "Example: --created-after 2026-09-01T00:00:00Z");
    }
    query.created_after = createdAfter;
  }
  return query;
}

export function userQuery(flags: ReadonlyMap<string, string | boolean>): ListQuery {
  const query: ListQuery = {};
  const username = flags.get("username");
  if (username !== undefined) query.username = username;
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

// Client-side projection over each leaf's field subset, including the derived
// assignment status. Unknown fields fail explicitly instead of silently
// returning short rows.
export function listFields(
  flags: ReadonlyMap<string, string | boolean>, allowed: readonly string[],
): readonly string[] {
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

const assignmentSchema = z.object({
  id: z.number().int().positive(),
  host_id: z.number().int().nullable().optional(),
  account_id: z.number().int().nullable().optional(),
  date_resolved: z.string().nullable(),
});
const outcomeSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  builtin: z.boolean().nullable().optional(),
});
const userSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().nullable().optional(),
});

function decode<T>(value: unknown, schema: z.ZodType<T>, noun: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AxiError(`Vectra ${noun} response is malformed: expected valid ${noun} fields`,
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  return result.data;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
}

function summarizeFilters(query: ListQuery): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return "with no filters";
  return `with ${entries.map(([key, value]) => `${key} ${value}`).join(", ")}`;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function contextFlags(flags: ReadonlyMap<string, string | boolean>, session: Session): string {
  const config = flags.get("config");
  return `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)}`;
}

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

type CollectionLeaf = {
  operation: string;
  noun: string;
  rowsKey: string;
  fields: readonly string[];
  emptyHint: string;
  showHint: (session: Session, flags: ReadonlyMap<string, string | boolean>, id: unknown) => string;
};

// Runs one bounded collection window and shapes the AXI output. Assignment
// rows gain their derived unresolved/resolved status before projection.
// Partial collection results keep their validated rows with complete:false,
// an inline error and a cursor; the caller reports them with a nonzero exit
// status. Permission or licence denial is an error disposition, never an
// empty healthy result.
async function runCollectionList(
  session: Session, flags: ReadonlyMap<string, string | boolean>, query: ListQuery, leaf: CollectionLeaf,
  decodeRow: (row: unknown) => Record<string, unknown>,
): Promise<LeafResult> {
  const limit = listLimit(flags);
  const fields = listFields(flags, leaf.fields);
  const cursor = flags.get("cursor");
  const result = typeof cursor === "string"
    ? await resume(session, leaf.operation, cursor, { query, limit, decodeRow })
    : await collect(session, leaf.operation, { query, limit, decodeRow });
  const rows = result.rows.map((row) => project(row, fields));
  const shown = rows.length;
  const count = result.total === null || result.total === shown
    ? `${shown} ${leaf.noun}`
    : `${shown} of ${result.total} ${leaf.noun}`;
  const profile = session.profile.name;
  if (result.error) {
    const failure = result.error;
    return { failed: true, output: {
      profile,
      total: result.total,
      count,
      [leaf.rowsKey]: rows,
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
      total: result.total,
      count,
      [leaf.rowsKey]: `0 ${leaf.noun} found ${summarizeFilters(query)}`,
      complete: true,
      help: [leaf.emptyHint],
    } };
  }
  const firstId = result.rows[0]!.id;
  return { failed: false, output: {
    profile,
    total: result.total,
    count,
    [leaf.rowsKey]: rows,
    complete: true,
    ...(result.cursor ? { cursor: result.cursor } : {}),
    help: [
      ...(result.cursor ? ["Pass --cursor <cursor> with the same filters for the next window"] : []),
      leaf.showHint(session, flags, firstId),
    ],
  } };
}

// date_resolved null means the assignment is still open; a set timestamp
// means it was resolved. The status string keeps that distinction explicit
// instead of leaving a bare null that reads as missing data.
function withStatus(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, status: row.date_resolved === null ? "unresolved" : "resolved" };
}

export async function runAssignmentList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const query = assignmentQuery(flags);
  return runCollectionList(session, flags, query, {
    operation: ASSIGNMENT_LIST_OPERATION,
    noun: "assignments",
    rowsKey: "assignments",
    fields: ASSIGNMENT_LIST_FIELDS,
    emptyHint: "Widen the filters or omit them to list every assignment",
    showHint: (owned, leafFlags) =>
      `Run \`vectra-axi assignment outcome list${contextFlags(leafFlags, owned)}\` for the resolution taxonomy`,
  }, (row) => withStatus(decode(row, assignmentSchema, "assignment")));
}

export async function runOutcomeList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  return runCollectionList(session, flags, {}, {
    operation: OUTCOME_LIST_OPERATION,
    noun: "assignment outcomes",
    rowsKey: "outcomes",
    fields: OUTCOME_LIST_FIELDS,
    emptyHint: "No assignment outcomes are defined on this instance",
    showHint: (owned, leafFlags, id) =>
      `Run \`vectra-axi assignment outcome show${contextFlags(leafFlags, owned)} --id ${shellQuote(String(id))}\` for full detail`,
  }, (row) => decode(row, outcomeSchema, "assignment outcome"));
}

export async function runUserList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const query = userQuery(flags);
  return runCollectionList(session, flags, query, {
    operation: USER_LIST_OPERATION,
    noun: "users",
    rowsKey: "users",
    fields: USER_LIST_FIELDS,
    emptyHint: "Widen the filters or omit them to list every user",
    showHint: (owned, leafFlags, id) =>
      `Run \`vectra-axi user show${contextFlags(leafFlags, owned)} --id ${shellQuote(String(id))}\` for full detail`,
  }, (row) => decode(row, userSchema, "user"));
}

export function outcomeId(flags: ReadonlyMap<string, string | boolean>): number {
  const raw = flags.get("id");
  if (raw === undefined) {
    invalid("assignment outcome show requires --id <id>",
      "Run `vectra-axi assignment outcome list` to find an outcome ID",
      "Example: vectra-axi assignment outcome show --profile <name> --id 1");
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--id must be a positive integer outcome ID", "Example: --id 1");
  }
  return Number(raw);
}

export function userId(flags: ReadonlyMap<string, string | boolean>): number {
  const raw = flags.get("id");
  if (raw === undefined) {
    invalid("user show requires --id <id>",
      "Run `vectra-axi user list` to find a user ID",
      "Example: vectra-axi user show --profile <name> --id 3");
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--id must be a positive integer user ID", "Example: --id 3");
  }
  return Number(raw);
}

// Shows one assignment outcome or user. IDs stay scoped to their resource:
// outcome 3 and user 3 are different objects.
async function runLeafShow<T extends Record<string, unknown>>(
  session: Session, id: number, operation: string, schema: z.ZodType<T>, noun: string,
): Promise<LeafResult> {
  const { body } = await session.request(operation, { pathParams: { id } });
  const detail = decode(body, schema, noun);
  return { failed: false, output: { profile: session.profile.name, ...detail } };
}

export async function runOutcomeShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  return runLeafShow(session, outcomeId(flags), OUTCOME_SHOW_OPERATION, outcomeSchema, "assignment outcome");
}

export async function runUserShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  return runLeafShow(session, userId(flags), USER_SHOW_OPERATION, userSchema, "user");
}
