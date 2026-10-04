import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { Session } from "./session.js";

// RUX-03 shared checkpoint-feed machinery, extracted from part a
// (detection events) for reuse by the audit event feed rather than
// duplicating the engine per feed. The CORE-02 collection reader serves
// count/results/next collections only, so checkpoint feeds
// (paging:checkpoint) own this single-batch runner: one session request
// serves one read, continuation replays the returned checkpoint verbatim,
// and a --limit inside an upstream batch resumes mid-page through an
// opaque cursor. Checkpoints advance exactly as returned, never computed
// from page size; remaining_count is reported as returned, never as a
// stable total. Denial is a thrown error, never an empty result.

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

// Per-feed configuration: the runner owns cursor binding, fetching,
// batch validation and windowing, while each feed owns its flag grammar
// (validation, output-window parsing and wire mapping).
export type CheckpointFeedConfig = {
  // Inventory operation id: binds the session request, the cursor and its
  // mismatch message, so a cursor from one feed never resumes another.
  operation: string;
  // Singular event noun driving user-facing text: "detection event" reads
  // as "2 detection events", "audit event" as "2 audit events".
  noun: string;
  // Catalogue leaf driving continuation commands: "detection event list"
  // renders `vectra-axi detection event list ...`, "audit list" renders
  // `vectra-axi audit list ...`.
  leaf: string;
  // Flag names echoed verbatim into continuation commands when explicitly
  // passed, in order: timestamp bounds, date convenience flags, then limit.
  echoFlags: readonly string[];
  // Full per-feed flag validation, run first so bad input fails before
  // configuration, profile selection or HTTP on every entry point.
  validate(flags: ReadonlyMap<string, string | boolean>): void;
  // Output window for this read; validated above, never sent upstream.
  limit(flags: ReadonlyMap<string, string | boolean>): number;
  // Server-side wire filters, including `from` when --from is passed.
  // Deterministic in the flags, so a resume rebuilds the bound filters.
  query(flags: ReadonlyMap<string, string | boolean>): Record<string, string>;
};

// Numeric checkpoints only: the RUX v3.4 event feeds document integer
// `from` checkpoints and integer `next_checkpoint` values, so a
// non-integer wire checkpoint is malformed rather than normalized.
const feedSchema = z.object({
  next_checkpoint: z.number().int().nullable().optional(),
  remaining_count: z.number().int().nullable().optional(),
  events: z.array(z.record(z.string(), z.unknown())),
});

type CheckpointCursor = {
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

function cursorInvalid(noun: string, detail: string): AxiError {
  return new AxiError(`Invalid ${noun} cursor: ${detail}`, "VALIDATION_ERROR", [
    "Cursors are opaque; pass back the cursor exactly as returned and resume with the original filters",
  ]);
}

function decodeCursor(raw: string, noun: string): CheckpointCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    throw cursorInvalid(noun, "the cursor is not well-formed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw cursorInvalid(noun, "the cursor is not well-formed");
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
    throw cursorInvalid(noun, "the cursor binding is not intact");
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

function encodeCursor(cursor: CheckpointCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

// Reads one event batch and shapes the AXI output. One session request
// serves one read; continuation uses the returned checkpoint, either by the
// agent passing --from or by resuming a mid-batch cursor. The optional
// signal cancels the read cleanly with REQUEST_CANCELLED before any further
// HTTP work.
export async function runCheckpointFeed(
  session: Session, flags: ReadonlyMap<string, string | boolean>, config: CheckpointFeedConfig,
  options?: { signal?: AbortSignal },
): Promise<LeafResult> {
  config.validate(flags);
  const limit = config.limit(flags);
  const rawCursor = flags.get("cursor");
  let query = config.query(flags);
  let offset = 0;
  let remaining = limit;
  let expectedBatchHash: string | undefined;
  if (typeof rawCursor === "string") {
    const cursor = decodeCursor(rawCursor, config.noun);
    if (cursor.operation !== config.operation) {
      throw cursorInvalid(config.noun, `the cursor belongs to ${cursor.operation}, not ${config.operation}`);
    }
    const profile = session.profile;
    if (cursor.profile.name !== profile.name || cursor.profile.kind !== profile.kind
      || cursor.profile.origin !== profile.origin || cursor.profile.apiVersion !== profile.apiVersion) {
      throw cursorInvalid(config.noun, "the cursor belongs to a different profile");
    }
    // The cursor binds the checkpoint in its own field, so the flag query
    // (which cannot carry --from alongside --cursor) compares against the
    // bound filters only; the request replays the bound checkpoint.
    const { from: _rejected, ...resumeFilters } = query;
    if (canonicalQuery(resumeFilters) !== canonicalQuery(cursor.query)) {
      throw cursorInvalid(config.noun, "the query context changed since the cursor was issued");
    }
    query = cursor.from === undefined ? { ...cursor.query } : { ...cursor.query, from: cursor.from };
    offset = cursor.offset;
    remaining = flags.has("limit") ? limit : cursor.remaining;
    expectedBatchHash = cursor.batchHash;
  }
  const from = query.from;
  const { body } = await session.request(config.operation,
    { query, ...(options?.signal ? { signal: options.signal } : {}) });
  const parsed = feedSchema.safeParse(body);
  if (!parsed.success) {
    throw new AxiError(`Vectra ${config.noun} response is malformed: expected next_checkpoint, remaining_count and events`,
      "RESPONSE_INVALID", ["Check the RUX v3.4 API contract for this operation"]);
  }
  const { events, remaining_count: remainingCount = null } = parsed.data;
  const checkpoint = parsed.data.next_checkpoint ?? null;
  if (events.length > 0 && checkpoint === null) {
    throw new AxiError(`Vectra ${config.noun} response is malformed: returned events carry no checkpoint`,
      "RESPONSE_INVALID", ["Continuation follows the returned checkpoint; without one the window cannot resume"]);
  }
  const profileName = session.profile.name;
  const configFlag = flags.get("config");
  const context = `${typeof configFlag === "string" ? ` --config ${shellQuote(configFlag)}` : ""}`
    + ` --profile ${shellQuote(profileName)}`
    + config.echoFlags.map((flag) => {
      const value = flags.get(flag);
      return typeof value === "string" ? ` --${flag} ${shellQuote(value)}` : "";
    }).join("");
  const continuation = (flag: "from" | "cursor", value: string): string =>
    `vectra-axi ${config.leaf}${context} --${flag} ${shellQuote(value)}`;
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
    throw new AxiError(`Vectra ${config.noun} feed changed since the cursor was issued`,
      "RESPONSE_INVALID", [`Reissue ${config.leaf} without --cursor to read the current batch`]);
  }
  const window = events.slice(offset, offset + remaining);
  // A non-advancing checkpoint replays the same batch forever, so a batch
  // that returns rows without advancing fails with its rows retained instead
  // of handing back a resumption loop.
  if (from !== undefined && events.length > 0 && checkpoint === Number(from)) {
    const failure = new AxiError(
      `Vectra ${config.noun} feed did not advance past checkpoint ${from}`,
      "CONTINUATION_REPEATED",
      ["The server returned the requested checkpoint; validated rows were retained",
        "Reissue the read later instead of resuming, which would replay this batch"]);
    return { failed: true, output: {
      ...base,
      count: `${window.length} ${config.noun}s`,
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
      count: `0 ${config.noun}s`,
      events: `0 ${config.noun}s found${scope}`,
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
      operation: config.operation,
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
      count: `${window.length} ${config.noun}s`,
      events: window,
      complete: true,
      cursor,
      help: [`Run \`${continuation("cursor", cursor)}\` for the rest of this batch`],
    } };
  }
  return { failed: false, output: {
    ...base,
    count: `${window.length} ${config.noun}s`,
    events: window,
    complete: true,
    ...(checkpoint !== null
      ? { help: [`Run \`${continuation("from", String(checkpoint))}\` to continue from the returned checkpoint`] } : {}),
  } };
}
