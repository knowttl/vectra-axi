import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { DEFAULT_COLLECTION_LIMIT } from "./collections.js";
import type { Session } from "./session.js";

// READ-07: QUX health snapshots and health checkpoint events on the CORE-01
// session. Snapshots (paging:none) use session.request directly; the event
// feed (paging:checkpoint) owns its own single-batch runner because the
// CORE-02 collection reader serves count/results/next collections only.
// Snapshots report cached versus fresh from the request flags, never from
// invented fields; the event feed follows returned checkpoints, never a
// computed next ID. Denial is a thrown error, never an empty healthy result.
// Lockdown status stays READ-08; RUX health stays RUX-06.

export const HEALTH_LIST_OPERATION = "qux.health.list";
export const HEALTH_SHOW_OPERATION = "qux.health.show";
export const HEALTH_EVENT_LIST_OPERATION = "qux.health.event.list";

// Accepted health selectors from the qux.health.show inventory record
// (guide pp46-51; VAT get_health_check). Anything else fails before HTTP.
export const HEALTH_CHECKS = ["cpu", "disk", "network", "memory", "power", "sensors",
  "system", "hostid", "connectivity", "trafficdrop"] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];

// Health events arrived in appliance release 9.4 (guide change log); the
// snapshots carry no release prerequisite.
const HEALTH_EVENT_MINIMUM_RELEASE = "9.4";

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

// Snapshot freshness: --fresh sends cache=false for a live check, otherwise
// the query omits cache and the upstream cached default applies (its body
// carries updated_at). --no-vlans sends vlans=false to omit VLAN detail.
export function healthQuery(flags: ReadonlyMap<string, string | boolean>): {
  query: Record<string, string | number | boolean>; cached: boolean;
} {
  const query: Record<string, string | number | boolean> = {};
  const cached = !flags.has("fresh");
  if (!cached) query.cache = false;
  if (flags.has("no-vlans")) query.vlans = false;
  return { query, cached };
}

// The show leaf names its check up front; an unsupported selector fails
// before configuration, profile selection or any HTTP call.
export function healthCheck(flags: ReadonlyMap<string, string | boolean>): HealthCheck {
  const raw = flags.get("check");
  if (raw === undefined) {
    invalid("health show requires --check <name>",
      `Supported checks: ${HEALTH_CHECKS.join(", ")}`,
      "Example: vectra-axi health show --profile <name> --check cpu");
  }
  if (typeof raw !== "string" || !(HEALTH_CHECKS as readonly string[]).includes(raw)) {
    invalid(`Unsupported health check: ${String(raw)}`,
      `Supported checks: ${HEALTH_CHECKS.join(", ")}`,
      "Check availability also depends on enabled products/subscriptions");
  }
  return raw as HealthCheck;
}

function decodeSnapshot(body: unknown, operation: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AxiError(`Vectra health response is malformed: expected a ${operation} snapshot object`,
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  return body as Record<string, unknown>;
}

// Reads one health snapshot. The returned body passes through untouched:
// its sections vary with enabled products/subscriptions, so no fixed schema
// is projected and no availability is synthesized. Denial propagates.
export async function runHealthList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const { query, cached } = healthQuery(flags);
  const { body } = await session.request(HEALTH_LIST_OPERATION, { query });
  return { failed: false, output: {
    profile: session.profile.name,
    cached,
    health: decodeSnapshot(body, "health list"),
  } };
}

export async function runHealthShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const check = healthCheck(flags);
  const { query, cached } = healthQuery(flags);
  const { body } = await session.request(HEALTH_SHOW_OPERATION, { pathParams: { check }, query });
  return { failed: false, output: {
    profile: session.profile.name,
    check,
    cached,
    health: decodeSnapshot(body, "health show"),
  } };
}

// Compares dotted releases numerically segment by segment, so 9.10 counts as
// newer than 9.4. Non-numeric segments never match a real release gate.
function releaseBelow(actual: string, minimum: string): boolean {
  const parts = actual.split(".");
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const wanted = minimum.split(".").map(Number);
  for (let index = 0; index < wanted.length; index++) {
    const have = index < parts.length ? Number(parts[index]) : 0;
    if (have !== wanted[index]) return have < wanted[index]!;
  }
  return false;
}

// Release gate for the event feed: a profile that declares an appliance
// release older than 9.4 fails before any HTTP. A profile without
// applianceRelease cannot be checked, so the read proceeds and the server
// decides; an older appliance then answers with its own error.
export function healthEventRelease(profile: { applianceRelease?: string }): void {
  const release = profile.applianceRelease;
  if (release !== undefined && releaseBelow(release, HEALTH_EVENT_MINIMUM_RELEASE)) {
    invalid(`health event list requires appliance release ${HEALTH_EVENT_MINIMUM_RELEASE} or later`
      + ` (profile reports ${release})`,
      "Health events arrived in appliance release 9.4; upgrade the appliance or drop this leaf",
      "health list and health show snapshots carry no release prerequisite");
  }
}

export function healthEventLimit(flags: ReadonlyMap<string, string | boolean>): number {
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

// Validates event flags and maps them to server-side query keys. Values pass
// through; the server applies them. The CLI --limit is an output window only
// and is never sent as the upstream batch limit, so a limit inside an
// upstream batch exercises the mid-batch cursor path.
export function healthEventQuery(flags: ReadonlyMap<string, string | boolean>): Record<string, string> {
  const query: Record<string, string> = {};
  const from = nonemptyFlag(flags, "from", "from");
  if (from !== undefined) query.from = from;
  for (const [flag, wire] of [["ordering", "ordering"], ["status", "status"],
    ["health-check-name", "health_check_name"], ["entity-type", "entity_type"],
    ["entity-name", "entity_name"]] as const) {
    const value = nonemptyFlag(flags, flag, wire);
    if (value !== undefined) query[wire] = value;
  }
  return query;
}

const healthEventSchema = z.object({
  next_checkpoint: z.string().nullable().optional(),
  remaining_count: z.number().int().nullable().optional(),
  events: z.array(z.record(z.string(), z.unknown())),
});

type HealthEventCursor = {
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
  return new AxiError(`Invalid health event cursor: ${detail}`, "VALIDATION_ERROR", [
    "Cursors are opaque; pass back the cursor exactly as returned and resume with the original filters",
  ]);
}

function decodeCursor(raw: string): HealthEventCursor {
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

function encodeCursor(cursor: HealthEventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

// Validates event flags without a session, so cli.ts rejects bad input
// before configuration or profile selection. The runner calls it again
// first, keeping one validation path for both entry points.
export function healthEventFlags(flags: ReadonlyMap<string, string | boolean>): void {
  healthEventQuery(flags);
  healthEventLimit(flags);
  const rawCursor = flags.get("cursor");
  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    invalid("--cursor requires the opaque cursor value from a capped read",
      "Pass --cursor <cursor> with the original filters to resume the pending window");
  }
  if (typeof rawCursor === "string" && flags.has("from")) {
    invalid("health event list cannot combine --from with --cursor",
      "The cursor already binds the checkpoint; resume with the original filters and no --from");
  }
}

// Reads one event batch and shapes the AXI output. One session request
// serves one read; continuation uses the returned checkpoint, either by the
// agent passing --from or by resuming a mid-batch cursor.
export async function runHealthEventList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  healthEventFlags(flags);
  healthEventRelease(session.profile);
  const limit = healthEventLimit(flags);
  const rawCursor = flags.get("cursor");
  let query = healthEventQuery(flags);
  let offset = 0;
  let remaining = limit;
  let expectedBatchHash: string | undefined;
  if (typeof rawCursor === "string") {
    const cursor = decodeCursor(rawCursor);
    if (cursor.operation !== HEALTH_EVENT_LIST_OPERATION) {
      throw cursorInvalid(`the cursor belongs to ${cursor.operation}, not ${HEALTH_EVENT_LIST_OPERATION}`);
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
  const { body } = await session.request(HEALTH_EVENT_LIST_OPERATION, { query });
  const parsed = healthEventSchema.safeParse(body);
  if (!parsed.success) {
    throw new AxiError("Vectra health event response is malformed: expected next_checkpoint, remaining_count and events",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  const { events, remaining_count: remainingCount = null } = parsed.data;
  const checkpoint = parsed.data.next_checkpoint ?? null;
  if (events.length > 0 && (typeof checkpoint !== "string" || !checkpoint)) {
    throw new AxiError("Vectra health event response is malformed: returned events carry no checkpoint",
      "RESPONSE_INVALID", ["Continuation follows the returned checkpoint; without one the window cannot resume"]);
  }
  const profileName = session.profile.name;
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
    throw new AxiError("Vectra health event feed changed since the cursor was issued",
      "RESPONSE_INVALID", ["Reissue health event list without --cursor to read the current batch"]);
  }
  const window = events.slice(offset, offset + remaining);
  // A non-advancing checkpoint replays the same batch forever, so a batch
  // that returns rows without advancing fails with its rows retained instead
  // of handing back a resumption loop.
  if (from !== undefined && events.length > 0 && checkpoint === from) {
    const failure = new AxiError(
      `Vectra health event feed did not advance past checkpoint ${from}`,
      "CONTINUATION_REPEATED",
      ["The server returned the requested checkpoint; validated rows were retained",
        "Reissue the read later instead of resuming, which would replay this batch"]);
    return { failed: true, output: {
      ...base,
      count: `${window.length} health events`,
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
      count: "0 health events",
      events: `0 health events found${scope}`,
      complete: true,
      ...(typeof checkpoint === "string" && checkpoint
        ? { help: [`Pass --from ${checkpoint} to continue from the returned checkpoint`] } : {}),
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
      operation: HEALTH_EVENT_LIST_OPERATION,
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
      count: `${window.length} health events`,
      events: window,
      complete: true,
      cursor,
      help: ["Pass --cursor <cursor> with the same filters for the rest of this batch",
        ...(typeof checkpoint === "string" && checkpoint
          ? [`Pass --from ${checkpoint} to continue past this batch`] : [])],
    } };
  }
  return { failed: false, output: {
    ...base,
    count: `${window.length} health events`,
    events: window,
    complete: true,
    ...(typeof checkpoint === "string" && checkpoint
      ? { help: [`Pass --from ${checkpoint} to continue from the returned checkpoint`] } : {}),
  } };
}
