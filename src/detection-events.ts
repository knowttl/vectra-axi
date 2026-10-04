import { AxiError } from "axi-sdk-js";
import { DEFAULT_COLLECTION_LIMIT } from "./collections.js";
import { runCheckpointFeed, type LeafResult } from "./event-feed.js";
import type { Session } from "./session.js";

// RUX-03 (part a): RUX v3.4 detection checkpoint events on the CORE-01
// session. The feed (paging:checkpoint) runs on the shared checkpoint-feed
// runner because the CORE-02 collection reader serves count/results/next
// collections only; READ-07's QUX health event feed is the nearest pattern.
// The runner follows returned checkpoints, never a computed next ID, and
// reports remaining_count as returned, never as a stable total. Denial is a
// thrown error, never an empty result. Generation gating comes from the
// session: the operation is inventoried for RUX only, so an on-prem profile
// fails with OPERATION_UNKNOWN before any credential or HTTP work.
// Entity-scoring and audit events stay later RUX-03 parts.

export const DETECTION_EVENT_LIST_OPERATION = "rux.detection.event.list";

export type { LeafResult };

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

export function detectionEventLimit(flags: ReadonlyMap<string, string | boolean>): number {
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
export function detectionEventQuery(flags: ReadonlyMap<string, string | boolean>): Record<string, string> {
  const query: Record<string, string> = {};
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

// Validates event flags without a session, so cli.ts rejects bad input
// before configuration or profile selection. The runner calls it again
// first, keeping one validation path for both entry points.
export function detectionEventFlags(flags: ReadonlyMap<string, string | boolean>): void {
  detectionEventQuery(flags);
  detectionEventLimit(flags);
  const rawCursor = flags.get("cursor");
  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    invalid("--cursor requires the opaque cursor value from a capped read",
      "Pass --cursor <cursor> with the original filters to resume the pending window");
  }
  if (typeof rawCursor === "string" && flags.has("from")) {
    invalid("detection event list cannot combine --from with --cursor",
      "The cursor already binds the checkpoint; resume with the original filters and no --from");
  }
}

// Reads one event batch and shapes the AXI output. One session request
// serves one read; continuation uses the returned checkpoint, either by the
// agent passing --from or by resuming a mid-batch cursor. The optional
// signal cancels the read cleanly with REQUEST_CANCELLED before any further
// HTTP work.
export async function runDetectionEventList(
  session: Session, flags: ReadonlyMap<string, string | boolean>, options?: { signal?: AbortSignal },
): Promise<LeafResult> {
  return runCheckpointFeed(session, flags, {
    operation: DETECTION_EVENT_LIST_OPERATION,
    noun: "detection event",
    leaf: "detection event list",
    echoFlags: ["event-timestamp-gte", "event-timestamp-lte", "limit"],
    validate: detectionEventFlags,
    limit: detectionEventLimit,
    query: detectionEventQuery,
  }, options);
}
