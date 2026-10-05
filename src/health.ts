import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { DEFAULT_COLLECTION_LIMIT } from "./collections.js";
import type { SelectedProfile } from "./profiles.js";
import { HEALTH_CHECKS, type Session } from "./session.js";

// READ-07: QUX health snapshots and health checkpoint events on the CORE-01
// session. Snapshots (paging:none) use session.request directly; the event
// feed (paging:checkpoint) owns its own single-batch runner because the
// CORE-02 collection reader serves count/results/next collections only.
// Snapshots report cached versus fresh from the request flags, never from
// invented fields; the event feed follows returned checkpoints, never a
// computed next ID. Denial is a thrown error, never an empty healthy result.
// Lockdown status stays READ-08. RUX-06 maps the same leaves to the
// documented v3.4 routes on a cloud profile: subscription-sensitive bodies
// pass through untouched and integer event checkpoints normalize to their
// decimal form. Generation-specific connector/EDR/network-brain routes ship
// as RUX-only `health show` selectors (RUX-06b) with their recorded filter
// flags; QUX profiles refuse them with generation guidance.

export const HEALTH_LIST_OPERATION = "qux.health.list";
export const HEALTH_SHOW_OPERATION = "qux.health.show";
export const HEALTH_EVENT_LIST_OPERATION = "qux.health.event.list";
// RUX-06: the same caller leaves run against the documented v3.4 routes
// on a cloud profile. The v3.4 check_type enum matches the ten QUX checks
// exactly, so the selector needs no per-generation allowlist.
export const RUX_HEALTH_LIST_OPERATION = "rux.health.list";
export const RUX_HEALTH_SHOW_OPERATION = "rux.health.show";
export const RUX_HEALTH_EVENT_LIST_OPERATION = "rux.health.event.list";
// RUX-06b: fixed-route connector/EDR/network-brain checks. Each selector
// names its own operation because the v3.4 routes carry no check_type path
// parameter; the inventory query keys are the only filter contract.
export const RUX_HEALTH_EXTERNAL_CONNECTORS_OPERATION = "rux.health.external-connectors.show";
export const RUX_HEALTH_EXTERNAL_CONNECTORS_DETAILS_OPERATION = "rux.health.external-connectors.details.show";
export const RUX_HEALTH_EDR_OPERATION = "rux.health.edr.show";
export const RUX_HEALTH_EDR_DETAILS_OPERATION = "rux.health.edr.details.show";
export const RUX_HEALTH_NETWORK_BRAIN_PING_OPERATION = "rux.health.network-brain.ping.show";

// The v3.4 health routes state that responses vary with Network, AWS and
// M365 subscriptions, so cloud snapshot output carries the variance note
// instead of projecting a fixed schema. QUX output carries no help key.
export const RUX_HEALTH_SUBSCRIPTION_NOTE =
  "Health response varies with Network, AWS and M365 subscriptions";

// Shared check_type selectors from the qux.health.show inventory record
// (guide pp46-51; VAT get_health_check). RUX fixed-route selectors are separate.
export { HEALTH_CHECKS } from "./session.js";
export type HealthCheck = (typeof HEALTH_CHECKS)[number];

// RUX-only selectors, kebab-cased from their v3.4 route segments. They
// share the `health show` leaf but never the QUX check_type route: a QUX
// profile refuses them with generation guidance before any HTTP.
export const RUX_CONNECTOR_CHECKS = ["external-connectors", "external-connectors-details",
  "edr", "edr-details", "network-brain-ping"] as const;
export type RuxConnectorCheck = (typeof RUX_CONNECTOR_CHECKS)[number];

const RUX_CONNECTOR_OPERATIONS: Readonly<Record<RuxConnectorCheck, string>> = {
  "external-connectors": RUX_HEALTH_EXTERNAL_CONNECTORS_OPERATION,
  "external-connectors-details": RUX_HEALTH_EXTERNAL_CONNECTORS_DETAILS_OPERATION,
  "edr": RUX_HEALTH_EDR_OPERATION,
  "edr-details": RUX_HEALTH_EDR_DETAILS_OPERATION,
  "network-brain-ping": RUX_HEALTH_NETWORK_BRAIN_PING_OPERATION,
};

export function isRuxConnectorCheck(check: string): check is RuxConnectorCheck {
  return (RUX_CONNECTOR_CHECKS as readonly string[]).includes(check);
}

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
// before configuration, profile selection or any HTTP call. The RUX-only
// selectors pass this gate on either generation so the runner can refuse
// them on QUX with generation guidance instead of an unsupported-check
// error; truly unknown names still fail here.
export function healthCheck(flags: ReadonlyMap<string, string | boolean>): HealthCheck | RuxConnectorCheck {
  const raw = flags.get("check");
  if (raw === undefined) {
    invalid("health show requires --check <name>",
      `Supported checks: ${HEALTH_CHECKS.join(", ")}`,
      `RUX-only checks: ${RUX_CONNECTOR_CHECKS.join(", ")}`,
      "Example: vectra-axi health show --profile <name> --check cpu");
  }
  if (typeof raw !== "string"
    || (!(HEALTH_CHECKS as readonly string[]).includes(raw) && !isRuxConnectorCheck(raw))) {
    invalid(`Unsupported health check: ${String(raw)}`,
      `Supported checks: ${HEALTH_CHECKS.join(", ")}`,
      `RUX-only checks: ${RUX_CONNECTOR_CHECKS.join(", ")}`,
      "Check availability also depends on enabled products/subscriptions");
  }
  return raw as HealthCheck | RuxConnectorCheck;
}

function nonemptyShowFlag(flags: ReadonlyMap<string, string | boolean>, name: string, wire: string): string | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    invalid(`--${name} requires a non-empty value`, `Example: --${name} <value> (sent as ${wire})`);
  }
  return raw;
}

// Validates `health show` flag/check compatibility without a session, so
// cli.ts rejects bad input before configuration or profile selection. The
// runner calls it again first, keeping one validation path for both entry
// points. Generation gating stays in the runner, which owns the profile.
export function healthShowFlags(flags: ReadonlyMap<string, string | boolean>): void {
  const check = healthCheck(flags);
  if (!isRuxConnectorCheck(check)) {
    for (const name of ["connector-type", "edr-type", "data-type", "live"] as const) {
      if (flags.has(name)) {
        invalid(`--${name} applies only to the RUX connector/EDR checks`,
          "external-connectors accepts --connector-type, --data-type and --live;"
          + " edr accepts --edr-type, --data-type and --live",
          "Example: vectra-axi health show --profile <name> --check edr --edr-type <type>");
      }
    }
    return;
  }
  if (flags.has("fresh") || flags.has("no-vlans")) {
    invalid(`Health check '${check}' uses its fixed upstream query`,
      "The connector/EDR routes declare no cache or vlans parameter;"
      + " drop --fresh and --no-vlans for this check");
  }
  const connectorType = nonemptyShowFlag(flags, "connector-type", "connector_type");
  if (connectorType !== undefined && check !== "external-connectors" && check !== "external-connectors-details") {
    invalid("--connector-type applies only to --check external-connectors or --check external-connectors-details",
      "Example: vectra-axi health show --profile <name> --check external-connectors"
      + " --connector-type <type>");
  }
  const edrType = nonemptyShowFlag(flags, "edr-type", "edr_type");
  if (edrType !== undefined && check !== "edr" && check !== "edr-details") {
    invalid("--edr-type applies only to --check edr or --check edr-details",
      "Example: vectra-axi health show --profile <name> --check edr --edr-type <type>");
  }
  const dataType = nonemptyShowFlag(flags, "data-type", "data_type");
  if (dataType !== undefined && check !== "external-connectors" && check !== "edr") {
    invalid("--data-type applies only to --check external-connectors or --check edr",
      "The details and ping routes do not accept data_type");
  }
  if (flags.has("live") && check === "network-brain-ping") {
    invalid("--live applies only to the RUX connector/EDR checks",
      "The ping route takes no query parameters");
  }
}

// Maps the validated show flags to the operation's declared query keys.
export function healthConnectorQuery(
  flags: ReadonlyMap<string, string | boolean>, check: RuxConnectorCheck,
): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {};
  if (check === "external-connectors" || check === "external-connectors-details") {
    const connectorType = nonemptyShowFlag(flags, "connector-type", "connector_type");
    if (connectorType !== undefined) query.connector_type = connectorType;
  } else if (check === "edr" || check === "edr-details") {
    const edrType = nonemptyShowFlag(flags, "edr-type", "edr_type");
    if (edrType !== undefined) query.edr_type = edrType;
  }
  if (check === "external-connectors" || check === "edr") {
    const dataType = nonemptyShowFlag(flags, "data-type", "data_type");
    if (dataType !== undefined) query.data_type = dataType;
  }
  if (check !== "network-brain-ping" && flags.has("live")) query.live = true;
  return query;
}

function decodeSnapshot(body: unknown, operation: string, rux: boolean): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AxiError(`Vectra health response is malformed: expected a ${operation} snapshot object`,
      "RESPONSE_INVALID", [rux
        ? "Check the RUX v3.4 API contract for this operation"
        : "Check the QUX v2.5 API contract for this operation"]);
  }
  return body as Record<string, unknown>;
}

// Reads one health snapshot. The returned body passes through untouched:
// its sections vary with enabled products/subscriptions, so no fixed schema
// is projected and no availability is synthesized. Denial propagates.
export async function runHealthList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const rux = session.profile.kind === "rux";
  const { query, cached } = healthQuery(flags);
  const { body } = await session.request(rux ? RUX_HEALTH_LIST_OPERATION : HEALTH_LIST_OPERATION, { query });
  return { failed: false, output: {
    profile: session.profile.name,
    cached,
    health: decodeSnapshot(body, "health list", rux),
    ...(rux ? { help: [RUX_HEALTH_SUBSCRIPTION_NOTE] } : {}),
  } };
}

export async function runHealthShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  healthShowFlags(flags);
  const check = healthCheck(flags);
  const rux = session.profile.kind === "rux";
  // RUX-only checks name fixed v3.4 routes with no cache or vlans parameter,
  // so the body passes through with the
  // subscription note and no cached/fresh claim. Denial propagates.
  if (isRuxConnectorCheck(check)) {
    if (!rux) {
      invalid(`Health check '${check}' requires a RUX v3.4 cloud profile`,
        "QUX exposes cpu, disk, network, memory, power, sensors, system, hostid,"
        + " connectivity and trafficdrop checks only",
        "Create a RUX profile for connector/EDR health, or rerun with a QUX-supported --check");
    }
    const { body } = await session.request(RUX_CONNECTOR_OPERATIONS[check],
      { query: healthConnectorQuery(flags, check) });
    return { failed: false, output: {
      profile: session.profile.name,
      check,
      health: decodeSnapshot(body, "health show", true),
      help: [RUX_HEALTH_SUBSCRIPTION_NOTE],
    } };
  }
  const { query, cached } = healthQuery(flags);
  // The v3.4 check route names its path selector check_type and keeps the
  // trailing slash from the documented route; the ten check names match.
  const { body } = await session.request(rux ? RUX_HEALTH_SHOW_OPERATION : HEALTH_SHOW_OPERATION,
    rux ? { pathParams: { check_type: check }, query } : { pathParams: { check }, query });
  return { failed: false, output: {
    profile: session.profile.name,
    check,
    cached,
    health: decodeSnapshot(body, "health show", rux),
    ...(rux ? { help: [RUX_HEALTH_SUBSCRIPTION_NOTE] } : {}),
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
export function healthEventRelease(profile: SelectedProfile | Session["profile"] | { applianceRelease?: string }): void {
  // RUX-01: cloud profiles carry no appliance release; undeclared means the
  // read proceeds and the server decides, the same as a QUX profile without one.
  const release = "applianceRelease" in profile ? profile.applianceRelease : undefined;
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

// The v3.4 events route returns integer checkpoints (QUX uses strings),
// so the decoder accepts both and normalizes to the decimal form. The
// checkpoint stays an opaque continuation token either way: continuation
// replays it verbatim and never computes a next ID from page size.
const healthEventSchema = z.object({
  next_checkpoint: z.union([z.string(), z.number().int()]).nullable().optional(),
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
  const rux = session.profile.kind === "rux";
  const limit = healthEventLimit(flags);
  // RUX checkpoints are integer event IDs, so a non-numeric --from can
  // never match and fails here with guidance instead of a server 400.
  // QUX checkpoints keep their own shape and pass through untouched.
  const rawFrom = flags.get("from");
  if (rux && typeof rawFrom === "string" && !/^\d+$/.test(rawFrom)) {
    invalid("RUX health events use numeric checkpoints: --from must be a positive integer",
      "Pass --from <checkpoint> with a checkpoint from a returned batch",
      "Example: vectra-axi health event list --profile <name> --from 101");
  }
  const rawCursor = flags.get("cursor");
  let query = healthEventQuery(flags);
  let offset = 0;
  let remaining = limit;
  let expectedBatchHash: string | undefined;
  // A cursor binds its generation's operation, so a QUX cursor never
  // resumes a cloud read and vice versa.
  const operation = rux ? RUX_HEALTH_EVENT_LIST_OPERATION : HEALTH_EVENT_LIST_OPERATION;
  if (typeof rawCursor === "string") {
    const cursor = decodeCursor(rawCursor);
    if (cursor.operation !== operation) {
      throw cursorInvalid(`the cursor belongs to ${cursor.operation}, not ${operation}`);
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
  const { body } = await session.request(operation, { query });
  const parsed = healthEventSchema.safeParse(body);
  if (!parsed.success) {
    throw new AxiError("Vectra health event response is malformed: expected next_checkpoint, remaining_count and events",
      "RESPONSE_INVALID", [rux
        ? "Check the RUX v3.4 API contract for this operation"
        : "Check the QUX v2.5 API contract for this operation"]);
  }
  const { events, remaining_count: remainingCount = null } = parsed.data;
  const rawCheckpoint = parsed.data.next_checkpoint ?? null;
  const checkpoint = rawCheckpoint === null ? null : String(rawCheckpoint);
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
      operation,
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
