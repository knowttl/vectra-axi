import { AxiError } from "axi-sdk-js";
import { auditFlagShapes, parseAuditDay } from "./audits.js";
import { DEFAULT_COLLECTION_LIMIT } from "./collections.js";
import { runCheckpointFeed, type LeafResult } from "./event-feed.js";
import type { Session } from "./session.js";

// RUX-03 (part c): RUX v3.4 audit checkpoint events on the CORE-01 session.
// The feed (paging:checkpoint) runs on the shared checkpoint-feed runner
// from part a, so checkpoints advance exactly as returned, mid-page reads
// resume losslessly from a saved cursor, and remaining_count is reported as
// returned, never as a stable total. Denial is a thrown error, never an
// empty result. Generation gating comes from the session: the operation is
// inventoried for RUX only, so an on-prem profile fails with
// OPERATION_UNKNOWN before any credential or HTTP work. QUX date-windowed
// audits stay in src/audits.ts; their behavior and output are unchanged.
// Entity-scoring events are the separate part b.

export const AUDIT_EVENT_LIST_OPERATION = "rux.audit.list";

export type { LeafResult };

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

export function auditEventLimit(flags: ReadonlyMap<string, string | boolean>): number {
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
// The --start-date/--end-date convenience flags expand to the documented
// timestamp contract: whole inclusive UTC calendar days become
// event_timestamp_gte at day start and event_timestamp_lte at day end, so
// --start-date 2026-10-01 --end-date 2026-10-02 reads the full two-day
// window. The CLI --limit is an output window only and is never sent as the
// upstream batch limit, so a limit inside an upstream batch exercises the
// mid-batch cursor path.
export function auditEventQuery(flags: ReadonlyMap<string, string | boolean>): Record<string, string> {
  const query: Record<string, string> = {};
  const from = nonemptyFlag(flags, "from", "from");
  if (from !== undefined) {
    if (!/^-?\d+$/.test(from) || !Number.isSafeInteger(Number(from))) {
      invalid("--from must be an integer checkpoint", "Example: --from 2");
    }
    query.from = String(Number(from));
  }
  const start = flags.has("start-date") ? parseAuditDay(flags.get("start-date"), "start-date") : undefined;
  const end = flags.has("end-date") ? parseAuditDay(flags.get("end-date"), "end-date") : undefined;
  if (start !== undefined) query.event_timestamp_gte = `${start}T00:00:00Z`;
  if (end !== undefined) query.event_timestamp_lte = `${end}T23:59:59.999999Z`;
  for (const [flag, wire] of [["event-timestamp-gte", "event_timestamp_gte"],
    ["event-timestamp-lte", "event_timestamp_lte"]] as const) {
    const value = nonemptyFlag(flags, flag, wire);
    if (value !== undefined) query[wire] = value;
  }
  return query;
}

// Validates event flags without a session, so cli.ts rejects bad shapes
// before configuration or profile selection. The runner calls it again
// first, keeping one validation path for both entry points. QUX presence
// (the required date window) stays in src/audits.ts: this validator owns
// only the RUX feed contract.
export function auditEventFlags(flags: ReadonlyMap<string, string | boolean>): void {
  auditFlagShapes(flags);
  const hasStart = flags.has("start-date");
  const hasEnd = flags.has("end-date");
  if (hasStart !== hasEnd) {
    const missing = hasStart ? "end-date" : "start-date";
    const present = hasStart ? "start-date" : "end-date";
    invalid(`audit list requires --${missing} <YYYY-MM-DD> alongside --${present}`,
      "Date flags expand to a whole-day timestamp window; pass both inclusive UTC days",
      "Or filter with --event-timestamp-gte/--event-timestamp-lte instead of date flags",
      "Example: vectra-axi audit list --profile <name> --start-date 2026-10-01 --end-date 2026-10-02");
  }
  if (hasStart && (flags.has("event-timestamp-gte") || flags.has("event-timestamp-lte"))) {
    invalid("audit list cannot combine date flags with explicit timestamp filters",
      "Use --start-date/--end-date for whole UTC days or --event-timestamp-gte/--event-timestamp-lte for exact bounds, not both");
  }
  if (hasStart && hasEnd) {
    const start = parseAuditDay(flags.get("start-date"), "start-date");
    const end = parseAuditDay(flags.get("end-date"), "end-date");
    if (start > end) {
      invalid(`--start-date ${start} is after --end-date ${end}`,
        "Swap the dates or pick a window where the start is on or before the end",
        "Example: vectra-axi audit list --profile <name> --start-date 2026-10-01 --end-date 2026-10-02");
    }
  }
}

// Reads one event batch and shapes the AXI output. One session request
// serves one read; continuation uses the returned checkpoint, either by the
// agent passing --from or by resuming a mid-batch cursor. The optional
// signal cancels the read cleanly with REQUEST_CANCELLED before any further
// HTTP work.
export async function runAuditEventList(
  session: Session, flags: ReadonlyMap<string, string | boolean>, options?: { signal?: AbortSignal },
): Promise<LeafResult> {
  return runCheckpointFeed(session, flags, {
    operation: AUDIT_EVENT_LIST_OPERATION,
    noun: "audit event",
    leaf: "audit list",
    echoFlags: ["start-date", "end-date", "event-timestamp-gte", "event-timestamp-lte", "limit"],
    validate: auditEventFlags,
    limit: auditEventLimit,
    query: auditEventQuery,
  }, options);
}
