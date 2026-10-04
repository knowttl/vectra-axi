import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { RESPONSE_BODY_LIMIT_BYTES, type Session } from "./session.js";

// READ-06: QUX audit reads over bounded inclusive UTC date windows on the
// CORE-01 session. Audits are paging:date-window single responses, so the
// runner uses session.request directly, never the CORE-02 collection reader:
// there is no count/results/next page to resume and no cursor to bind.
// Both dates are required ISO calendar days; the CLI never falls back to the
// API's unbounded date defaults, and an oversized window fails with a
// smaller-range suggestion instead of a silent truncation. RUX checkpoint
// audits stay RUX-03.

export const AUDIT_LIST_OPERATION = "qux.audit.list";

// Inventory fields name the wire subset; rows project exactly these keys.
export const AUDIT_LIST_FIELDS = ["user", "role", "vectra_timestamp", "result", "message"] as const;

// Response-byte ceiling for one decoded audit window. Unbounded upstream
// audits can reach 200 MB (design.md); the production transport already caps
// raw bodies at 8 MB, and this module re-checks the decoded body so oversized
// windows fail truthfully on every transport, including test fakes.
export const AUDIT_MAX_BYTES = RESPONSE_BODY_LIMIT_BYTES;

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Parses one YYYY-MM-DD flag into its wire value. The pattern alone cannot
// reject impossible days, so a UTC round-trip confirms the date is real.
function parseDay(raw: unknown, flag: "start-date" | "end-date"): string {
  const example = `Example: vectra-axi audit list --profile <name> --start-date 2026-10-01 --end-date 2026-10-02`;
  if (typeof raw !== "string" || !DAY_PATTERN.test(raw)) {
    invalid(`--${flag} must be a YYYY-MM-DD UTC calendar day`, example);
  }
  const [year, month, day] = raw.split("-").map(Number);
  const at = Date.UTC(year!, month! - 1, day!);
  const check = new Date(at);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day) {
    invalid(`--${flag} is not a real calendar day: ${raw}`, example);
  }
  return raw;
}

// Validates the bounded window before any configuration, profile selection
// or HTTP call. Both dates are required: omitting either would start from
// the API's unbounded defaults, which the slice forbids.
export function auditWindow(flags: ReadonlyMap<string, string | boolean>): { start: string; end: string } {
  const example = "Example: vectra-axi audit list --profile <name> --start-date 2026-10-01 --end-date 2026-10-02";
  if (flags.get("start-date") === undefined) {
    invalid("audit list requires --start-date <YYYY-MM-DD>",
      "The API defaults to an unbounded window; always pass an explicit start date", example);
  }
  if (flags.get("end-date") === undefined) {
    invalid("audit list requires --end-date <YYYY-MM-DD>",
      "The API defaults to an unbounded window; always pass an explicit end date", example);
  }
  const start = parseDay(flags.get("start-date"), "start-date");
  const end = parseDay(flags.get("end-date"), "end-date");
  if (start > end) {
    invalid(`--start-date ${start} is after --end-date ${end}`,
      `Swap the dates or pick a window where the start is on or before the end`, example);
  }
  return { start, end };
}

const auditRowSchema = z.object({
  user: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  vectra_timestamp: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});

function decodeRow(row: unknown): Record<string, unknown> {
  const result = auditRowSchema.safeParse(row);
  if (!result.success) {
    throw new AxiError("Vectra audit response is malformed: expected valid audit fields",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  return result.data;
}

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

function oversizedWindow(start: string, end: string): never {
  throw new AxiError(
    `Vectra audit window ${start} to ${end} exceeded the ${AUDIT_MAX_BYTES}-byte ceiling`,
    "BYTE_BUDGET_EXCEEDED",
    [`Narrow the window with a smaller date range, for example --start-date ${end} --end-date ${end}`,
      "The CLI never truncates an oversized audit window and claims completion"],
  );
}

// Reads one bounded audit window. The wire carries the ISO calendar days
// unchanged (VAT get_audits passes datetime.date isoformat as start/end);
// the server applies them inclusively. Malformed and oversized bodies throw
// instead of claiming completion; denial propagates from the session.
export async function runAuditList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const { start, end } = auditWindow(flags);
  const { body } = await session.request(AUDIT_LIST_OPERATION, { query: { start, end } }).catch((error: unknown) => {
    if (error instanceof AxiError && error.code === "BYTE_BUDGET_EXCEEDED") oversizedWindow(start, end);
    throw error;
  });
  if (!Array.isArray(body)) {
    throw new AxiError("Vectra audit response is malformed: expected a list of audits",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bytes > AUDIT_MAX_BYTES) oversizedWindow(start, end);
  const rows = body.map(decodeRow);
  const profile = session.profile.name;
  const window = `${start} to ${end} (inclusive UTC days)`;
  if (rows.length === 0) {
    return { failed: false, output: {
      profile,
      window,
      count: "0 audits",
      audits: `0 audits found from ${start} to ${end}`,
      complete: true,
    } };
  }
  return { failed: false, output: {
    profile,
    window,
    count: `${rows.length} audits`,
    audits: rows,
    complete: true,
  } };
}
