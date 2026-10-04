import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { Session } from "./session.js";

// READ-08: QUX host/account lockdown status through the dedicated status
// routes on the CORE-01 session. Lockdown reads are paging:none single
// responses, so the runner uses session.request directly, never the CORE-02
// collection reader: there is no count/results/next page to resume and no
// cursor to bind. --type is required and selects one kind's status route,
// never a merged ranking. Status only: the catalogue declares no lockdown
// execution leaf, the inventory keeps lockdown execution unpromised, and the
// session authorizes read GETs only. Permission or licence denial propagates
// from the session as an error, never an empty healthy result.

export const LOCKDOWN_HOST_LIST_OPERATION = "qux.lockdown.host.list";
export const LOCKDOWN_ACCOUNT_LIST_OPERATION = "qux.lockdown.account.list";

export const LOCKDOWN_KINDS = ["host", "account"] as const;
export type LockdownKind = (typeof LOCKDOWN_KINDS)[number];

export const LOCKDOWN_STATUS_ONLY =
  "Lockdown status only; the CLI declares no lockdown execution leaf";

const LOCKDOWN_LIMITS: Record<LockdownKind, string> = {
  host: "Host lockdown status requires the configured Microsoft Defender ATP Lockdown integration",
  account: "Account lockdown status requires the configured AD Lockdown capability",
};

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

// The lockdown facade has no route of its own: --type selects the host or
// account status route before any credential or HTTP work. Anything else,
// including a missing --type, is rejected so no unverified lockdown action
// can be constructed from an untyped read.
export function lockdownKind(flags: ReadonlyMap<string, string | boolean>): LockdownKind {
  const raw = flags.get("type");
  if (raw === undefined) {
    invalid("lockdown list requires --type <host|account>",
      "QUX exposes separate host and account lockdown status routes; name one kind at a time",
      "Example: vectra-axi lockdown list --profile <name> --type host");
  }
  if (typeof raw !== "string" || !(LOCKDOWN_KINDS as readonly string[]).includes(raw)) {
    invalid("--type must be one of: host, account",
      "Example: vectra-axi lockdown list --profile <name> --type account");
  }
  return raw as LockdownKind;
}

function listOperation(kind: LockdownKind): string {
  return kind === "host" ? LOCKDOWN_HOST_LIST_OPERATION : LOCKDOWN_ACCOUNT_LIST_OPERATION;
}

// The kind ID is the join key every row must carry; lock metadata stays
// optional because the inventory's field subset is a caller aid, not a
// decoder. Unknown wire keys are stripped, never projected.
const hostLockdownSchema = z.object({
  host_id: z.number().int().positive(),
  lock_date: z.string().nullable().optional(),
  locked_by: z.string().nullable().optional(),
  unlock_date: z.string().nullable().optional(),
});
const accountLockdownSchema = z.object({
  account_id: z.number().int().positive(),
  lock_date: z.string().nullable().optional(),
  locked_by: z.string().nullable().optional(),
  unlock_date: z.string().nullable().optional(),
});

function decodeRow(kind: LockdownKind, row: unknown): Record<string, unknown> {
  const result = (kind === "host" ? hostLockdownSchema : accountLockdownSchema).safeParse(row);
  if (!result.success) {
    throw new AxiError("Vectra lockdown response is malformed: expected valid lockdown status fields",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  return result.data;
}

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

// Reads one kind's lockdown status. The wire carries no query: the kind
// selects the route itself. An empty status list is an explicit zero, not an
// error; denial propagates from the session as ACCESS_DENIED.
export async function runLockdownList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const kind = lockdownKind(flags);
  const { body } = await session.request(listOperation(kind));
  if (!Array.isArray(body)) {
    throw new AxiError("Vectra lockdown response is malformed: expected a list of lockdowns",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  const rows = body.map((row) => decodeRow(kind, row));
  const profile = session.profile.name;
  const noun = `${kind} lockdowns`;
  const help = [LOCKDOWN_STATUS_ONLY, LOCKDOWN_LIMITS[kind]];
  if (rows.length === 0) {
    return { failed: false, output: {
      profile,
      type: kind,
      count: `0 ${noun}`,
      lockdowns: `0 ${noun} found`,
      complete: true,
      help,
    } };
  }
  return { failed: false, output: {
    profile,
    type: kind,
    count: `${rows.length} ${noun}`,
    lockdowns: rows,
    complete: true,
    help,
  } };
}
