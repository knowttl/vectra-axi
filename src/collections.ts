import { AxiError } from "axi-sdk-js";
import { inventory } from "./catalogue.js";
import type { CapabilityOperation } from "./inventory/schema.js";
import { failedRead, parseRetryAfter, type Session, type SessionRequestOptions } from "./session.js";

// CORE-02: bounded collection reads over the CORE-01 session.
//
// Callers never see backend page mechanics: they pass a row limit and receive
// validated rows, a known-or-unknown total, completeness and an opaque cursor.
// Every page goes through the session's same-operation authorization, and every
// server-returned link is re-validated before it is followed. Detection
// list/show stays READ-01; checkpoint and date-window feeds stay with their
// slices, which reuse this module's clock, retry and cancellation shape.

export type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  }),
};

export type CollectionPolicy = {
  // Requested page_size where the operation's query allowlist supports it.
  pageSize: number;
  // Total session requests, counting the initial read and every retry.
  maxRequests: number;
  // Cumulative decoded-body ceiling in bytes across fetched pages.
  maxBytes: number;
  // Wall-clock budget in milliseconds, read through the injected clock.
  deadlineMs: number;
  // Attempts per single page fetch, including the initial attempt.
  maxAttempts: number;
  // Backoff base and cap for transient retries without Retry-After.
  baseDelayMs: number;
  maxDelayMs: number;
};

// One default covers every collection operation. No reviewed per-endpoint
// request/byte/deadline evidence exists yet, so none is invented; endpoint
// deviations land here when evidenced. QUX detection/host/account pages can
// reach 5000 rows upstream (design.md), but those routes accept no page_size
// parameter, so the reader consumes whole pages there.
const DEFAULT_POLICY: CollectionPolicy = {
  pageSize: 100,
  maxRequests: 10,
  maxBytes: 8 * 1024 * 1024,
  deadlineMs: 60_000,
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

// Default normal list output, per design.md.
export const DEFAULT_COLLECTION_LIMIT = 100;

// Reviewed transient conditions for read retries, following the az-axi
// reference (429/503 retried, 504 surfaced) plus 502 as an equally transient
// gateway signal. Anything else fails fast into partial results.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

// Thrown before any HTTP call, so the outer catch rethrows these unchanged.
const PRE_HTTP_CODES = new Set(["OPERATION_UNKNOWN", "OPERATION_BLOCKED", "VALIDATION_ERROR"]);

export type CollectionResult = {
  rows: unknown[];
  // Known server count, or null when the pages carry no usable count.
  // remaining_count is never treated as a stable total.
  total: number | null;
  // False means partial: validated rows retained, error explains the stop.
  complete: boolean;
  // Present when resumption may return more rows, including after failures.
  cursor?: string;
  error?: AxiError;
};

export type CollectionArgs = {
  query?: SessionRequestOptions["query"];
  pathParams?: SessionRequestOptions["pathParams"];
  limit?: number;
  signal?: AbortSignal;
  clock?: Clock;
  policy?: Partial<CollectionPolicy>;
};

type Scalar = string | number | boolean;

type CollectionCursor = {
  v: 2;
  profile: { name: string; kind: string; origin: string; apiVersion: string };
  operation: string;
  query: Record<string, Scalar>;
  pathParams: Record<string, string | number>;
  // Query that refetches the pending page through the session; offset skips
  // rows already returned when a limit split that page.
  page: Record<string, Scalar>;
  offset: number;
  remaining: number;
  // Last known server count, so a resumed read keeps a known total even when
  // later pages carry no count of their own.
  total: number | null;
  visited: string[];
};

function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AxiError(`Invalid collection limit: ${limit}`, "VALIDATION_ERROR", [
      "Pass a positive integer row limit; the default list output is 100",
    ]);
  }
  return limit;
}

// Unknown operations fall through to the session, which reports
// OPERATION_UNKNOWN before any credential or HTTP call. Anything inventoried
// without collection paging is rejected here so checkpoint and date-window
// feeds cannot be misread as count/results/next collections.
function collectionRecord(session: Session, operation: string): CapabilityOperation | undefined {
  const record = inventory.operations.find((candidate) => candidate.id === operation);
  if (record && record.deployment === session.profile.kind && record.paging !== "collection") {
    throw new AxiError(`Operation ${operation} does not use collection paging`, "VALIDATION_ERROR", [
      "The collection reader serves collection-paged reads; checkpoint and date-window feeds arrive with their slices",
    ]);
  }
  return record;
}

function withPageSize(
  record: CapabilityOperation | undefined, query: Record<string, Scalar>, pageSize: number,
): Record<string, Scalar> {
  if (!record || !record.query.includes("page_size") || "page_size" in query) return query;
  return { ...query, page_size: pageSize };
}

function canonical(value: Record<string, Scalar> | Record<string, string | number>): string {
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, String(value[key])]));
}

function cursorInvalid(detail: string): AxiError {
  return new AxiError(`Invalid collection cursor: ${detail}`, "VALIDATION_ERROR", [
    "Cursors are opaque; pass back the cursor exactly as returned and resume with the original query context",
  ]);
}

function isScalarRecord(value: unknown): value is Record<string, Scalar> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => ["string", "number", "boolean"].includes(typeof entry));
}

function isPathRecord(value: unknown): value is Record<string, string | number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number");
}

function decodeCursor(raw: string): CollectionCursor {
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
  if (cursor.v !== 2
    || typeof profile !== "object" || profile === null
    || ["name", "kind", "origin", "apiVersion"].some((key) => typeof profile[key] !== "string")
    || typeof cursor.operation !== "string" || !cursor.operation
    || !isScalarRecord(cursor.query) || !isPathRecord(cursor.pathParams) || !isScalarRecord(cursor.page)
    || !Array.isArray(cursor.visited) || !cursor.visited.every((key) => typeof key === "string")
    || typeof cursor.offset !== "number" || !Number.isInteger(cursor.offset) || cursor.offset < 0
    || typeof cursor.remaining !== "number" || !Number.isInteger(cursor.remaining) || cursor.remaining < 1
    || (cursor.total !== null
      && (typeof cursor.total !== "number" || !Number.isInteger(cursor.total) || cursor.total < 0))) {
    throw cursorInvalid("the cursor binding is not intact");
  }
  return {
    v: 2,
    profile: {
      name: profile.name as string, kind: profile.kind as string,
      origin: profile.origin as string, apiVersion: profile.apiVersion as string,
    },
    operation: cursor.operation,
    query: cursor.query,
    pathParams: cursor.pathParams,
    page: cursor.page,
    offset: cursor.offset,
    remaining: cursor.remaining,
    total: cursor.total,
    visited: cursor.visited,
  };
}

function encodeCursor(cursor: CollectionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function cancelledError(): AxiError {
  return new AxiError("Collection read was cancelled", "REQUEST_CANCELLED", [
    "Reissue the read or resume it with the returned cursor",
  ]);
}

function deadlineError(deadlineMs: number): AxiError {
  return new AxiError(`Collection read exceeded its ${deadlineMs}ms deadline`, "DEADLINE_EXCEEDED", [
    "Narrow the read with a smaller limit or filters, then resume from the returned cursor",
  ]);
}

function ensureLive(signal: AbortSignal | undefined, clock: Clock, deadlineAt: number, deadlineMs: number): void {
  if (signal?.aborted) throw cancelledError();
  if (clock.now() >= deadlineAt) throw deadlineError(deadlineMs);
}

function cancellableSleep(clock: Clock, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return clock.sleep(ms);
  if (signal.aborted) throw cancelledError();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(cancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    clock.sleep(ms, signal).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function transientWait(error: unknown, nowMs: number): { waitMs?: number } | undefined {
  if (error instanceof AxiError && error.code === "REQUEST_FAILED") {
    const info = failedRead(error);
    if (info && TRANSIENT_STATUSES.has(info.status)) {
      return { waitMs: parseRetryAfter(info.retryAfter, nowMs) };
    }
  }
  return undefined;
}

async function fetchPageWithRetry(args: {
  session: Session;
  operation: string;
  pathParams: Record<string, string | number>;
  pageQuery: Record<string, Scalar>;
  policy: CollectionPolicy;
  clock: Clock;
  signal: AbortSignal | undefined;
  deadlineAt: number;
  counter: { count: number };
}): Promise<unknown> {
  const { session, operation, pathParams, pageQuery, policy, clock, signal, deadlineAt, counter } = args;
  let attempt = 0;
  for (;;) {
    ensureLive(signal, clock, deadlineAt, policy.deadlineMs);
    if (counter.count >= policy.maxRequests) {
      throw new AxiError(`Collection read exceeded its ${policy.maxRequests} request budget`, "REQUEST_BUDGET_EXCEEDED", [
        "Resume the read with the returned cursor to fetch the remaining pages",
      ]);
    }
    counter.count += 1;
    try {
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await Promise.race([
          session.request(operation, { pathParams, query: pageQuery, signal: controller.signal }),
          cancellableSleep(clock, deadlineAt - clock.now(), controller.signal).then(() => {
            throw deadlineError(policy.deadlineMs);
          }),
        ]);
        ensureLive(signal, clock, deadlineAt, policy.deadlineMs);
        return response.body;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        controller.abort();
      }
    } catch (error) {
      ensureLive(signal, clock, deadlineAt, policy.deadlineMs);
      const transient = transientWait(error, clock.now());
      if (transient === undefined || attempt + 1 >= policy.maxAttempts) throw error;
      const backoff = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
      const wait = transient.waitMs ?? backoff;
      const remaining = deadlineAt - clock.now();
      if (wait > remaining) {
        throw new AxiError(
          `Retry-After delay of ${wait}ms exceeds the remaining ${Math.max(0, remaining)}ms budget`,
          "DEADLINE_EXCEEDED",
          ["Resume the read with the returned cursor inside a larger deadline"],
        );
      }
      attempt += 1;
      await cancellableSleep(clock, wait, signal);
    }
  }
}

function decodePage(body: unknown, operation: string): { rows: unknown[]; total: number | null; next: string | null } {
  const invalid = (detail: string): AxiError => new AxiError(
    `Vectra collection page for ${operation} is malformed: ${detail}`,
    "RESPONSE_INVALID",
    ["Check the QUX v2.5 API contract for this operation; validated rows were retained"],
  );
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("expected a JSON object");
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.results)) throw invalid("expected a results array");
  let total: number | null = null;
  if (page.count !== undefined && page.count !== null) {
    if (typeof page.count !== "number" || !Number.isInteger(page.count) || page.count < 0) {
      throw invalid("expected count to be a non-negative integer when present");
    }
    total = page.count;
  }
  const next = page.next ?? null;
  if (next !== null && (typeof next !== "string" || !next.trim())) {
    throw invalid("expected next to be a URL string when present");
  }
  return { rows: page.results, total, next };
}

function parseQuery(validated: string): Record<string, string> {
  const query: Record<string, string> = {};
  new URL(validated).searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return query;
}

// A later-page advance failed after at least one page exchange. The outer
// catch always converts this to a partial result: rows may already be
// retained, and the pending page is still refetchable.
class AdvanceFailed extends Error {
  readonly failure: unknown;
  constructor(failure: unknown) {
    super("Collection advance failed");
    this.failure = failure;
  }
}

type PageRun = {
  session: Session;
  operation: string;
  record: CapabilityOperation | undefined;
  pathParams: Record<string, string | number>;
  contextQuery: Record<string, Scalar>;
  startQuery: Record<string, Scalar>;
  offset: number;
  remaining: number;
  startTotal: number | null;
  visited: string[];
  policy: CollectionPolicy;
  clock: Clock;
  signal: AbortSignal | undefined;
};

async function runPages(run: PageRun): Promise<CollectionResult> {
  const { session, operation, pathParams, contextQuery, policy, clock, signal } = run;
  const deadlineAt = clock.now() + policy.deadlineMs;
  const profile = session.profile;
  const rows: unknown[] = [];
  let total: number | null = run.startTotal;
  let totalKnown = run.startTotal !== null;
  let usedBytes = 0;
  let pagesFetched = 0;
  const seen = new Set(run.visited);
  const counter = { count: 0 };
  let pageQuery = run.startQuery;
  let offset = run.offset;
  let remaining = run.remaining;
  let pending = { page: pageQuery, offset };
  const cursorFor = (page: Record<string, Scalar>, at: number, left: number): string => encodeCursor({
    v: 2,
    profile: { name: profile.name, kind: profile.kind, origin: profile.origin, apiVersion: profile.apiVersion },
    operation,
    query: contextQuery,
    pathParams,
    page,
    offset: at,
    remaining: left,
    total,
    visited: [...seen],
  });
  const partial = (error: unknown): CollectionResult => {
    const failure = error instanceof AxiError
      ? error
      : new AxiError(`Collection read failed: ${error instanceof Error ? error.message : String(error)}`, "REQUEST_FAILED", [
        "Resume the read with the returned cursor",
      ]);
    // A zero remainder means the limit was already satisfied when the advance
    // failed; default a resumed read to a fresh standard window instead of an
    // unusable cursor.
    const left = remaining === 0 ? DEFAULT_COLLECTION_LIMIT : remaining;
    return { rows, total, complete: false, cursor: cursorFor(pending.page, pending.offset, left), error: failure };
  };
  try {
    for (;;) {
      pending = { page: pageQuery, offset };
      ensureLive(signal, clock, deadlineAt, policy.deadlineMs);
      const key = canonical(pageQuery);
      const body = await fetchPageWithRetry({
        session, operation, pathParams, pageQuery, policy, clock, signal, deadlineAt, counter,
      });
      seen.add(key);
      pagesFetched += 1;
      const page = decodePage(body, operation);
      if (!totalKnown && page.total !== null) {
        total = page.total;
        totalKnown = true;
      }
      usedBytes += Buffer.byteLength(JSON.stringify(body), "utf8");
      if (usedBytes > policy.maxBytes) {
        throw new AxiError(
          `Collection read exceeded its ${policy.maxBytes} byte budget`,
          "BYTE_BUDGET_EXCEEDED",
          ["Resume the read with the returned cursor inside a larger byte budget"],
        );
      }
      const available = page.rows.slice(offset);
      const take = Math.min(available.length, remaining);
      rows.push(...available.slice(0, take));
      offset += take;
      pending.offset = offset;
      remaining -= take;
      if (remaining === 0) {
        const rest = available.length - take;
        // The limit is satisfied; a resumed read defaults to a fresh window.
        if (rest > 0) {
          return { rows, total, complete: true,
            cursor: cursorFor(pageQuery, page.rows.length - rest, DEFAULT_COLLECTION_LIMIT) };
        }
      }
      if (page.next === null) return { rows, total, complete: true };
      let validated: string;
      try {
        validated = session.resolveContinuation(operation, page.next, { pathParams });
      } catch (error) {
        throw new AdvanceFailed(error);
      }
      const nextQuery = parseQuery(validated);
      if (seen.has(canonical(nextQuery))) {
        throw new AxiError(`Collection page repeated its continuation for ${operation}`, "CONTINUATION_REPEATED", [
          "The server returned a page already seen in this read; validated rows were retained",
          "Resume the read with the returned cursor after the collection settles",
        ]);
      }
      if (remaining === 0) {
        return { rows, total, complete: true, cursor: cursorFor(nextQuery, 0, DEFAULT_COLLECTION_LIMIT) };
      }
      pageQuery = nextQuery;
      offset = 0;
    }
  } catch (error) {
    if (error instanceof AdvanceFailed) return partial(error.failure);
    if (pagesFetched === 0 && error instanceof AxiError && PRE_HTTP_CODES.has(error.code)) throw error;
    return partial(error);
  }
}

export async function collect(session: Session, operation: string, args: CollectionArgs = {}): Promise<CollectionResult> {
  const record = collectionRecord(session, operation);
  const policy = { ...DEFAULT_POLICY, ...args.policy };
  const query = { ...(args.query ?? {}) };
  const pathParams = { ...(args.pathParams ?? {}) };
  return runPages({
    session,
    operation,
    record,
    pathParams,
    contextQuery: query,
    startQuery: withPageSize(record, query, policy.pageSize),
    offset: 0,
    remaining: checkLimit(args.limit ?? DEFAULT_COLLECTION_LIMIT),
    startTotal: null,
    visited: [],
    policy,
    clock: args.clock ?? realClock,
    signal: args.signal,
  });
}

export async function resume(
  session: Session, operation: string, raw: string, args: CollectionArgs = {},
): Promise<CollectionResult> {
  const cursor = decodeCursor(raw);
  if (cursor.operation !== operation) {
    throw cursorInvalid(`the cursor belongs to ${cursor.operation}, not ${operation}`);
  }
  const profile = session.profile;
  if (cursor.profile.name !== profile.name || cursor.profile.kind !== profile.kind
    || cursor.profile.origin !== profile.origin || cursor.profile.apiVersion !== profile.apiVersion) {
    throw cursorInvalid("the cursor belongs to a different profile");
  }
  const query = { ...(args.query ?? {}) };
  const pathParams = { ...(args.pathParams ?? {}) };
  if (canonical(query) !== canonical(cursor.query)) {
    throw cursorInvalid("the query context changed since the cursor was issued");
  }
  if (canonical(pathParams) !== canonical(cursor.pathParams)) {
    throw cursorInvalid("the path context changed since the cursor was issued");
  }
  const record = collectionRecord(session, operation);
  const policy = { ...DEFAULT_POLICY, ...args.policy };
  return runPages({
    session,
    operation,
    record,
    pathParams,
    contextQuery: cursor.query,
    startQuery: cursor.page,
    offset: cursor.offset,
    remaining: checkLimit(args.limit ?? cursor.remaining),
    startTotal: cursor.total,
    visited: cursor.visited,
    policy,
    clock: args.clock ?? realClock,
    signal: args.signal,
  });
}
