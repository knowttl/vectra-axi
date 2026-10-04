import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { DEFAULT_COLLECTION_LIMIT } from "./collections.js";
import type { Session } from "./session.js";

// RUX-03 (part b): RUX v3.4 entity-scoring checkpoint events on the CORE-01
// session. The feed (paging:checkpoint) owns its own single-batch runner
// because the CORE-02 collection reader serves count/results/next
// collections only; RUX-03 (part a) detection events are the nearest
// pattern and this runner follows the same grammar. The runner follows
// returned checkpoints, never a computed next ID, and reports
// remaining_count as returned, never as a stable total. The type selector
// is required (host or account) and travels as the wire `type` key;
// omitting it fails before any credential or HTTP work instead of letting
// the server answer 400. Scores pass through untouched: no urgency,
// importance or score conversion happens here. Denial is a thrown error,
// never an empty result. Generation gating comes from the session: the
// operation is inventoried for RUX only, so an on-prem profile fails with
// OPERATION_UNKNOWN before any credential or HTTP work. Audit events stay
// the separate RUX-03 part c.

export const ENTITY_SCORING_LIST_OPERATION = "rux.entity.scoring.list";

export const ENTITY_SCORING_TYPES = ["host", "account"] as const;
export type EntityScoringType = (typeof ENTITY_SCORING_TYPES)[number];

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

// Require --type before profile selection so the request never reaches the
// server without the selector the v3.4 route mandates. Values pass through
// verbatim; only the two recorded kinds are accepted.
export function entityScoringType(flags: ReadonlyMap<string, string | boolean>): EntityScoringType {
  const raw = flags.get("type");
  if (raw === undefined) {
    invalid("entity scoring list requires --type <host|account>",
      "The v3.4 entity-scoring route mandates the type selector; omitting it returns HTTP 400",
      "Example: vectra-axi entity scoring list --profile <name> --type host");
  }
  if (typeof raw !== "string" || !(ENTITY_SCORING_TYPES as readonly string[]).includes(raw)) {
    invalid(`--type must be one of: ${ENTITY_SCORING_TYPES.join(", ")}`,
      "Example: vectra-axi entity scoring list --profile <name> --type host");
  }
  return raw as EntityScoringType;
}

export function entityScoringLimit(flags: ReadonlyMap<string, string | boolean>): number {
  const raw = flags.get("limit");
  if (raw === undefined) return DEFAULT_COLLECTION_LIMIT;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--limit must be a positive integer row limit", "Example: --limit 20");
  }
  return Number(raw);
}

function nonemptyFlag(flags: ReadonlyMap<string, string | boolean>, name: string, wire: string): string | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    invalid(`--${name} requires a non-empty value`, `Example: --${name} <value> (sent as ${wire})`);
  }
  return raw;
}

// Validates event flags and maps them to server-side query keys. Timestamp
// bounds pass through for the server to apply inclusively; the CLI performs
// no client-side boundary filtering, so boundary rows arrive as returned.
// The CLI --limit is an output window only and is never sent as the upstream
// batch limit, so a limit inside an upstream batch exercises the mid-batch
// cursor path.
export function entityScoringQuery(flags: ReadonlyMap<string, string | boolean>): Record<string, string> {
  const query: Record<string, string> = { type: entityScoringType(flags) };
  const from = nonemptyFlag(flags, "from", "from");
  if (from !== undefined) {
    if (!/^-?\d+$/.test(from) || !Number.isSafeInteger(Number(from))) {
      invalid("--from must be an integer checkpoint", "Example: --from 2");
    }
    query.from = String(Number(from));
  }
  for (const [flag, wire] of [["event-timestamp-gte", "event_timestamp_gte"],
    ["event-timestamp-lte", "event_timestamp_lte"]] as const) {
    const value = nonemptyFlag(flags, flag, wire);
    if (value !== undefined) query[wire] = value;
  }
  return query;
}

const entityScoringEventSchema = z.object({
  next_checkpoint: z.number().int().nullable().optional(),
  remaining_count: z.number().int().nullable().optional(),
  events: z.array(z.record(z.string(), z.unknown())),
});

type EntityScoringCursor = {
  v: 1;
  profile: { name: string; kind: string; origin: string; apiVersion: string };
  operation: string;
  query: Record<string, string>;
  // Checkpoint and row offset of the pending window: resume re-requests the
  // same checkpoint and skips rows already returned. Checkpoints are never
  // computed from page size.
  from: string | undefined;
  offset: number;
  remaining: number;
  batchHash: string;
};

function canonicalQuery(query: Record<string, string>): string {
  return JSON.stringify(Object.keys(query).sort().map((key) => [key, query[key]]));
}

function cursorInvalid(detail: string): AxiError {
  return new AxiError(`Invalid entity scoring event cursor: ${detail}`, "VALIDATION_ERROR", [
    "Cursors are opaque; pass back the cursor exactly as returned and resume with the original filters",
  ]);
}

function decodeCursor(raw: string): EntityScoringCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    throw cursorInvalid("the cursor is not well-formed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw cursorInvalid("the cursor is not well-formed");
  }
  const cursor = parsed as Record<string, unknown>;
  const profile = cursor.profile as Record<string, unknown> | undefined;
  if (cursor.v !== 1
    || typeof profile !== "object" || profile === null
    || ["name", "kind", "origin", "apiVersion"].some((key) => typeof profile[key] !== "string")
    || typeof cursor.operation !== "string" || !cursor.operation
    || typeof cursor.query !== "object" || cursor.query === null || Array.isArray(cursor.query)
    || !Object.values(cursor.query as Record<string, unknown>).every((entry) => typeof entry === "string")
    || (cursor.from !== undefined && typeof cursor.from !== "string")
    || typeof cursor.offset !== "number" || !Number.isInteger(cursor.offset) || cursor.offset < 0
    || typeof cursor.remaining !== "number" || !Number.isInteger(cursor.remaining) || cursor.remaining < 1
    || typeof cursor.batchHash !== "string" || !/^[a-f0-9]{64}$/.test(cursor.batchHash)) {
    throw cursorInvalid("the cursor binding is not intact");
  }
  return {
    v: 1,
    profile: {
      name: profile.name as string, kind: profile.kind as string,
      origin: profile.origin as string, apiVersion: profile.apiVersion as string,
    },
    operation: cursor.operation,
    query: cursor.query as Record<string, string>,
    from: cursor.from as string | undefined,
    offset: cursor.offset,
    remaining: cursor.remaining,
    batchHash: cursor.batchHash,
  };
}

function encodeCursor(cursor: EntityScoringCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

// Validates event flags without a session, so cli.ts rejects bad input
// before configuration or profile selection. The runner calls it again
// first, keeping one validation path for both entry points.
export function entityScoringFlags(flags: ReadonlyMap<string, string | boolean>): void {
  entityScoringQuery(flags);
  entityScoringLimit(flags);
  const rawCursor = flags.get("cursor");
  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    invalid("--cursor requires the opaque cursor value from a capped read",
      "Pass --cursor <cursor> with the original filters to resume the pending window");
  }
  if (typeof rawCursor === "string" && flags.has("from")) {
    invalid("entity scoring list cannot combine --from with --cursor",
      "The cursor already binds the checkpoint; resume with the original filters and no --from");
  }
}

// Reads one event batch and shapes the AXI output. One session request
// serves one read; continuation uses the returned checkpoint, either by the
// agent passing --from or by resuming a mid-batch cursor. The optional
// signal cancels the read cleanly with REQUEST_CANCELLED before any further
// HTTP work.
export async function runEntityScoringList(
  session: Session, flags: ReadonlyMap<string, string | boolean>, options?: { signal?: AbortSignal },
): Promise<LeafResult> {
  entityScoringFlags(flags);
  const limit = entityScoringLimit(flags);
  const rawCursor = flags.get("cursor");
  let query = entityScoringQuery(flags);
  let offset = 0;
  let remaining = limit;
  let expectedBatchHash: string | undefined;
  if (typeof rawCursor === "string") {
    const cursor = decodeCursor(rawCursor);
    if (cursor.operation !== ENTITY_SCORING_LIST_OPERATION) {
      throw cursorInvalid(`the cursor belongs to ${cursor.operation}, not ${ENTITY_SCORING_LIST_OPERATION}`);
    }
    const profile = session.profile;
    if (cursor.profile.name !== profile.name || cursor.profile.kind !== profile.kind
      || cursor.profile.origin !== profile.origin || cursor.profile.apiVersion !== profile.apiVersion) {
      throw cursorInvalid("the cursor belongs to a different profile");
    }
    // The cursor binds the checkpoint in its own field, so the flag query
    // (which cannot carry --from alongside --cursor) compares against the
    // bound filters only; the request replays the bound checkpoint.
    const { from: _rejected, ...resumeFilters } = query;
    if (canonicalQuery(resumeFilters) !== canonicalQuery(cursor.query)) {
      throw cursorInvalid("the query context changed since the cursor was issued");
    }
    query = cursor.from === undefined ? { ...cursor.query } : { ...cursor.query, from: cursor.from };
    offset = cursor.offset;
    remaining = flags.has("limit") ? limit : cursor.remaining;
    expectedBatchHash = cursor.batchHash;
  }
  const from = query.from;
  const { body } = await session.request(ENTITY_SCORING_LIST_OPERATION, { query, ...(options?.signal ? { signal: options.signal } : {}) });
  const parsed = entityScoringEventSchema.safeParse(body);
  if (!parsed.success) {
    throw new AxiError("Vectra entity scoring event response is malformed: expected next_checkpoint, remaining_count and events",
      "RESPONSE_INVALID", ["Check the RUX v3.4 API contract for this operation"]);
  }
  const { events, remaining_count: remainingCount = null } = parsed.data;
  const checkpoint = parsed.data.next_checkpoint ?? null;
  if (events.length > 0 && checkpoint === null) {
    throw new AxiError("Vectra entity scoring event response is malformed: returned events carry no checkpoint",
      "RESPONSE_INVALID", ["Continuation follows the returned checkpoint; without one the window cannot resume"]);
  }
  const profileName = session.profile.name;
  const config = flags.get("config");
  const context = `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(profileName)}`
    + (["type", "event-timestamp-gte", "event-timestamp-lte", "limit"] as const).map((flag) => {
      const value = flags.get(flag);
      return typeof value === "string" ? ` --${flag} ${shellQuote(value)}` : "";
    }).join("");
  const continuation = (flag: "from" | "cursor", value: string): string =>
    `vectra-axi entity scoring list${context} --${flag} ${shellQuote(value)}`;
  const base = {
    profile: profileName,
    checkpoint,
    remaining_count: remainingCount,
  };
  const batchHash = createHash("sha256").update(JSON.stringify(events, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  })).digest("hex");
  if (offset > events.length || (expectedBatchHash !== undefined && expectedBatchHash !== batchHash)) {
    throw new AxiError("Vectra entity scoring event feed changed since the cursor was issued",
      "RESPONSE_INVALID", ["Reissue entity scoring list without --cursor to read the current batch"]);
  }
  const window = events.slice(offset, offset + remaining);
  // A non-advancing checkpoint replays the same batch forever, so a batch
  // that returns rows without advancing fails with its rows retained instead
  // of handing back a resumption loop.
  if (from !== undefined && events.length > 0 && checkpoint === Number(from)) {
    const failure = new AxiError(
      `Vectra entity scoring event feed did not advance past checkpoint ${from}`,
      "CONTINUATION_REPEATED",
      ["The server returned the requested checkpoint; validated rows were retained",
        "Reissue the read later instead of resuming, which would replay this batch"]);
    return { failed: true, output: {
      ...base,
      count: `${window.length} entity scoring events`,
      events: window,
      complete: false,
      error: failure.message,
      code: failure.code,
      help: [...failure.suggestions],
    } };
  }
  const skipped = events.length - offset - window.length;
  if (window.length === 0) {
    const scope = from !== undefined ? ` from checkpoint ${from}` : "";
    return { failed: false, output: {
      ...base,
      count: "0 entity scoring events",
      events: `0 entity scoring events found${scope}`,
      complete: true,
      ...(checkpoint !== null
        ? { help: [`Run \`${continuation("from", String(checkpoint))}\` to continue from the returned checkpoint`] } : {}),
    } };
  }
  const viewer = session.profile;
  const encode = (at: number, left: number): string => {
    // Bound filters exclude the checkpoint, which travels in its own field
    // so a later resume compares flag filters without --from.
    const bound = { ...query };
    delete bound.from;
    return encodeCursor({
      v: 1,
      profile: { name: viewer.name, kind: viewer.kind, origin: viewer.origin, apiVersion: viewer.apiVersion },
      operation: ENTITY_SCORING_LIST_OPERATION,
      query: bound,
      from,
      offset: at,
      remaining: left,
      batchHash,
    });
  };
  if (skipped > 0) {
    // The resumed read replays the same batch and skips returned rows, so
    // its window is the original limit again, not a shrinking remainder.
    const cursor = encode(offset + window.length, remaining);
    return { failed: false, output: {
      ...base,
      count: `${window.length} entity scoring events`,
      events: window,
      complete: true,
      cursor,
      help: [`Run \`${continuation("cursor", cursor)}\` for the rest of this batch`],
    } };
  }
  return { failed: false, output: {
    ...base,
    count: `${window.length} entity scoring events`,
    events: window,
    complete: true,
    ...(checkpoint !== null
      ? { help: [`Run \`${continuation("from", String(checkpoint))}\` to continue from the returned checkpoint`] } : {}),
  } };
}
