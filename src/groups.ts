import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { collect, DEFAULT_COLLECTION_LIMIT, resume } from "./collections.js";
import type { Session } from "./session.js";

// READ-05: QUX groups, paged group members and triage rules on the CORE-01
// session and CORE-02 collection reader. Group `type` values pass through
// verbatim: the CLI keeps no kind allowlist, so host, account, IP, domain
// and release-dependent AD kinds (appliance 9.6+) all survive list and show.
// Membership always comes from the paged member route (9.2+), never from an
// embedded detail summary capped at 2000 rows; member windows stay scoped to
// their group ID and are never merged across groups. Triage rules describe
// automation only: rule output never claims a detection is benign.
// Group and rule mutations stay refused: no PUT/POST/DELETE leaf is declared
// and the session authorizes read GETs only. Assignments/users stay READ-04.

export const GROUP_LIST_OPERATION = "qux.group.list";
export const GROUP_SHOW_OPERATION = "qux.group.show";
export const GROUP_MEMBER_LIST_OPERATION = "qux.group.member.list";
export const RULE_LIST_OPERATION = "qux.triage-rule.list";
export const RULE_SHOW_OPERATION = "qux.triage-rule.show";

export const GROUP_LIST_FIELDS = ["id", "name", "type"] as const;
export const MEMBER_LIST_FIELDS = ["id", "name"] as const;
export const RULE_LIST_FIELDS = ["id", "enabled", "triage_category"] as const;

export const BENIGN_DISCLAIMER =
  "Rules describe triage automation; a matching rule is not evidence a detection is benign";

type ListQuery = Record<string, string | number | boolean>;

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

function namedFlag(flags: ReadonlyMap<string, string | boolean>, name: string): string | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    invalid(`--${name} requires a non-empty value`, `Example: --${name} synthetic-value`);
  }
  return raw;
}

function booleanFlag(flags: ReadonlyMap<string, string | boolean>, name: string): string | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (raw !== "true" && raw !== "false") {
    invalid(`--${name} must be true or false`, `Example: --${name} true`);
  }
  return raw;
}

// Validates group list flags and maps them to the inventory's server-side
// query keys. Type values pass through to the server untouched, so current
// and future group kinds (including release-dependent AD groups) are never
// filtered by a client-side allowlist. Resuming with --cursor replays the
// bound query, so the original filters must be repeated; resume() rejects a
// changed query context explicitly.
export function groupQuery(flags: ReadonlyMap<string, string | boolean>): ListQuery {
  const query: ListQuery = {};
  const name = namedFlag(flags, "name");
  if (name !== undefined) query.name = name;
  const type = namedFlag(flags, "type");
  if (type !== undefined) query.type = type;
  const includeMembers = booleanFlag(flags, "include-members");
  if (includeMembers !== undefined) query.include_members = includeMembers;
  return query;
}

// Validates member list flags against the qux.group.member.list query keys.
// The group ID travels as a path parameter, not a query filter, so member
// windows always stay scoped to one group.
export function memberQuery(flags: ReadonlyMap<string, string | boolean>): ListQuery {
  const query: ListQuery = {};
  const name = namedFlag(flags, "name");
  if (name !== undefined) query.name = name;
  const ordering = namedFlag(flags, "ordering");
  if (ordering !== undefined) query.ordering = ordering;
  const keyAsset = flags.get("is-key-asset");
  if (keyAsset !== undefined) {
    if (keyAsset !== "true" && keyAsset !== "false") {
      invalid("--is-key-asset must be true or false", "Example: --is-key-asset true");
    }
    query.is_key_asset = keyAsset;
  }
  return query;
}

// Validates triage rule list flags against the qux.triage-rule.list query
// keys. The wire `fields` selector has no CLI flag: rows arrive whole and
// the CLI projects its recorded subset client-side like every other leaf.
export function ruleQuery(flags: ReadonlyMap<string, string | boolean>): ListQuery {
  const query: ListQuery = {};
  const contains = namedFlag(flags, "contains");
  if (contains !== undefined) query.contains = contains;
  const ordering = namedFlag(flags, "ordering");
  if (ordering !== undefined) query.ordering = ordering;
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

// Client-side projection over each leaf's recorded field subset. Unknown
// fields fail explicitly instead of silently returning short rows.
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

// Group, member and rule IDs stay scoped to their resource: group 8, its
// members and rule 8 are different objects on different routes.
export function groupId(flags: ReadonlyMap<string, string | boolean>, leaf: string): number {
  const raw = flags.get("id");
  if (raw === undefined) {
    invalid(`${leaf} requires --id <id>`,
      `Run \`vectra-axi ${leaf.replace(/ (show|member list)$/, " list")}\` to find a group ID`,
      "Example: vectra-axi group show --profile <name> --id 8");
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--id must be a positive integer group ID", "Example: --id 8");
  }
  return Number(raw);
}

export function ruleId(flags: ReadonlyMap<string, string | boolean>): number {
  const raw = flags.get("id");
  if (raw === undefined) {
    invalid("triage rule show requires --id <id>",
      "Run `vectra-axi triage rule list` to find a rule ID",
      "Example: vectra-axi triage rule show --profile <name> --id 7");
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--id must be a positive integer rule ID", "Example: --id 7");
  }
  return Number(raw);
}

const groupSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
  type: z.string(),
});
const memberSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
});
const ruleSchema = z.object({
  id: z.number().int().positive(),
  enabled: z.boolean(),
  triage_category: z.string().nullable().optional(),
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
  pathParams?: Readonly<Record<string, string | number>>;
  extra?: Record<string, unknown>;
  showHint: (session: Session, flags: ReadonlyMap<string, string | boolean>, id: unknown) => string[];
};

// Runs one bounded collection window and shapes the AXI output. Group and
// rule rows are projected verbatim, so kinds survive list reads exactly as
// the server returned them. Partial collection results keep their validated
// rows with complete:false, an inline error and a cursor; the caller reports
// them with a nonzero exit status. Permission or licence denial is an error
// disposition, never an empty healthy result.
async function runCollectionList(
  session: Session, flags: ReadonlyMap<string, string | boolean>, query: ListQuery, leaf: CollectionLeaf,
  decodeRow: (row: unknown) => Record<string, unknown>,
): Promise<LeafResult> {
  const limit = listLimit(flags);
  const fields = listFields(flags, leaf.fields);
  const cursor = flags.get("cursor");
  const window = typeof cursor === "string"
    ? await resume(session, leaf.operation, cursor, { query, limit, decodeRow, ...(leaf.pathParams ? { pathParams: leaf.pathParams } : {}) })
    : await collect(session, leaf.operation, { query, limit, decodeRow, ...(leaf.pathParams ? { pathParams: leaf.pathParams } : {}) });
  const rows = window.rows.map((row) => project(row, fields));
  const shown = rows.length;
  const count = window.total === null || window.total === shown
    ? `${shown} ${leaf.noun}`
    : `${shown} of ${window.total} ${leaf.noun}`;
  const profile = session.profile.name;
  if (window.error) {
    const failure = window.error;
    return { failed: true, output: {
      profile,
      ...(leaf.extra ?? {}),
      total: window.total,
      count,
      [leaf.rowsKey]: rows,
      complete: false,
      error: failure.message,
      code: failure.code,
      ...(window.cursor ? { cursor: window.cursor } : {}),
      help: [...failure.suggestions,
        ...(window.cursor ? ["Pass --cursor <cursor> with the same filters to resume the pending page"] : [])],
    } };
  }
  if (shown === 0) {
    return { failed: false, output: {
      profile,
      ...(leaf.extra ?? {}),
      total: window.total,
      count,
      [leaf.rowsKey]: `0 ${leaf.noun} found ${summarizeFilters(query)}`,
      complete: true,
      help: [leaf.emptyHint],
    } };
  }
  const firstId = window.rows[0]!.id;
  return { failed: false, output: {
    profile,
    ...(leaf.extra ?? {}),
    total: window.total,
    count,
    [leaf.rowsKey]: rows,
    complete: true,
    ...(window.cursor ? { cursor: window.cursor } : {}),
    help: [
      ...(window.cursor ? ["Pass --cursor <cursor> with the same filters for the next window"] : []),
      ...leaf.showHint(session, flags, firstId),
    ],
  } };
}

export async function runGroupList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const query = groupQuery(flags);
  return runCollectionList(session, flags, query, {
    operation: GROUP_LIST_OPERATION,
    noun: "groups",
    rowsKey: "groups",
    fields: GROUP_LIST_FIELDS,
    emptyHint: "Widen the filters or omit them to list every group",
    showHint: (owned, leafFlags, id) =>
      [`Run \`vectra-axi group member list${contextFlags(leafFlags, owned)} --id ${shellQuote(String(id))}\` for paged membership`],
  }, (row) => decode(row, groupSchema, "group"));
}

// Shows one group with its kind intact. Detail bodies may carry embedded
// members capped at 2000 rows, so the hint always points at the paged member
// route for complete membership instead of presenting the detail as complete.
export async function runGroupShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const id = groupId(flags, "group show");
  const { body } = await session.request(GROUP_SHOW_OPERATION, { pathParams: { id } });
  const detail = decode(body, groupSchema, "group");
  return { failed: false, output: {
    profile: session.profile.name,
    ...project(detail, GROUP_LIST_FIELDS),
    help: [`Run \`vectra-axi group member list${contextFlags(flags, session)} --id ${shellQuote(String(id))}\` for complete paged membership`],
  } };
}

// Lists one group's members through the dedicated member route. The group ID
// stays in the output so windows from different groups can never be mistaken
// for one merged ranking.
export async function runGroupMemberList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const id = groupId(flags, "group member list");
  const query = memberQuery(flags);
  return runCollectionList(session, flags, query, {
    operation: GROUP_MEMBER_LIST_OPERATION,
    noun: "members",
    rowsKey: "members",
    fields: MEMBER_LIST_FIELDS,
    emptyHint: `Group ${id} has no members returned for these filters`,
    pathParams: { id },
    extra: { group: id },
    showHint: (owned, leafFlags) =>
      [`Run \`vectra-axi group show${contextFlags(leafFlags, owned)} --id ${shellQuote(String(id))}\` for the group detail`],
  }, (row) => decode(row, memberSchema, "group member"));
}

export async function runRuleList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const query = ruleQuery(flags);
  return runCollectionList(session, flags, query, {
    operation: RULE_LIST_OPERATION,
    noun: "triage rules",
    rowsKey: "rules",
    fields: RULE_LIST_FIELDS,
    emptyHint: "Widen the filters or omit them to list every triage rule",
    showHint: (owned, leafFlags, id) => [
      `Run \`vectra-axi triage rule show${contextFlags(leafFlags, owned)} --id ${shellQuote(String(id))}\` for full detail`,
      BENIGN_DISCLAIMER,
    ],
  }, (row) => decode(row, ruleSchema, "triage rule"));
}

export async function runRuleShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const id = ruleId(flags);
  const { body } = await session.request(RULE_SHOW_OPERATION, { pathParams: { id } });
  const detail = decode(body, ruleSchema, "triage rule");
  return { failed: false, output: {
    profile: session.profile.name,
    ...project(detail, RULE_LIST_FIELDS),
    help: [BENIGN_DISCLAIMER],
  } };
}
