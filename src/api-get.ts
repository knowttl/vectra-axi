import { AxiError } from "axi-sdk-js";
import { collect, DEFAULT_COLLECTION_LIMIT, resume } from "./collections.js";
import { inventory } from "./catalogue.js";
import type { CapabilityOperation } from "./inventory/schema.js";
import { fieldSelection, type Session } from "./session.js";

// API-01: reviewed raw-read surface over the operation catalogue. `api get`
// addresses an allowlisted GET read operation by its inventory ID and passes
// only that operation's recorded query keys, path template variables and
// fields. There is no URL/host argument, no custom header and no other
// method: the destination is always the configured profile's instance through
// the existing session seams. Reads use the same profile, auth, redaction,
// output-limit and truncation contracts as the named leaves.

// Longest inline string kept verbatim, matching the named detail leaves.
export const RAW_TRUNCATE_AT = 1200;

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

// The raw allowlist is exactly the reviewed named GET reads with collection
// or single-response paging. Checkpoint and date-window feeds keep their
// named leaves (returned-checkpoint semantics cannot be expressed as generic
// key/value filters); writes, credential exchanges, sensitive routes and
// unreviewed operations are never raw-addressable.
export function rawRecord(operation: string): CapabilityOperation {
  const record = inventory.operations.find((candidate) => candidate.id === operation);
  if (!record) {
    throw new AxiError(`Unknown Vectra operation: ${operation}`, "OPERATION_UNKNOWN", [
      "Use a reviewed operation ID from docs/coverage.md; QUX operations need an on-prem profile",
    ]);
  }
  if (record.disposition === "blocked") {
    throw new AxiError(`Refusing sensitive Vectra route: ${operation}`, "OPERATION_BLOCKED", [
      "Credential, token and secret routes stay blocked on every surface, including raw reads",
    ]);
  }
  if (record.disposition !== "named") {
    throw new AxiError(`Refusing unreviewed Vectra operation: ${operation}`, "OPERATION_BLOCKED", [
      "Raw reads serve reviewed operations only; this operation has no reviewed read contract yet",
    ]);
  }
  if (record.effect !== "read" || record.method !== "GET") {
    throw new AxiError(`Refusing non-read Vectra operation: ${operation}`, "OPERATION_BLOCKED", [
      "Raw reads are GET only; writes travel through their named gated leaves, never raw",
    ]);
  }
  if (record.paging !== "collection" && record.paging !== "none") {
    const leaf = record.command ?? "api get";
    throw new AxiError(`Operation ${operation} is not raw-addressable`, "VALIDATION_ERROR", [
      `Checkpoint and date-window feeds keep their named leaf; run \`vectra-axi ${leaf}\` instead`,
    ]);
  }
  if (record.fields.length === 0) {
    throw new AxiError(`Operation ${operation} has no reviewed raw field policy`, "OPERATION_BLOCKED", [
      `Run \`vectra-axi ${record.command}\` instead`,
    ]);
  }
  return record;
}

// Coverage and help derive raw availability from this predicate, so the
// capability map cannot drift from what the leaf enforces.
export function rawAllowed(operation: CapabilityOperation): boolean {
  try {
    return rawRecord(operation.id) === operation;
  } catch {
    return false;
  }
}

export function rawOperation(flags: ReadonlyMap<string, string | boolean>): CapabilityOperation {
  const raw = flags.get("operation");
  if (typeof raw !== "string" || !raw.trim()) {
    invalid("api get requires --operation <id>",
      "Pass a reviewed operation ID, for example --operation qux.detection.list",
      "See docs/coverage.md for the allowlisted operations");
  }
  return rawRecord(raw.trim());
}

const PAIR_KEY = /^[A-Za-z0-9_]+$/;

// One generic pair grammar for --path and --query: `name=value` pairs joined
// with `&`, mirroring a URL query string. Values pass through to the server;
// the server applies them, so no per-operation value enum is invented here.
function parsePairs(raw: string, flag: string): Array<[string, string]> {
  const pairs = raw.split("&").map((pair) => pair.trim()).filter(Boolean);
  if (pairs.length === 0) {
    invalid(`--${flag} needs at least one name=value pair`, `Example: --${flag} state=active`);
  }
  return pairs.map((pair) => {
    const cut = pair.indexOf("=");
    const name = (cut < 0 ? pair : pair.slice(0, cut)).trim();
    const value = cut < 0 ? "" : pair.slice(cut + 1).trim();
    if (!PAIR_KEY.test(name) || !value) {
      invalid(`Invalid --${flag} pair: ${pair}`, `Use --${flag} name=value pairs joined with &`);
    }
    try {
      return [name, decodeURIComponent(value)];
    } catch {
      invalid(`Invalid --${flag} value encoding: ${value}`, "Use valid percent-encoded values, for example R%26D");
    }
  });
}

function templateVars(record: CapabilityOperation): string[] {
  const vars = new Set<string>();
  for (const match of record.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)) vars.add(match[1]!);
  return [...vars];
}

// Path parameters bind the operation's route template variables by name.
// Missing or extra variables fail before any credential or HTTP work.
export function rawPathParams(
  record: CapabilityOperation, flags: ReadonlyMap<string, string | boolean>,
): Record<string, string> {
  const expected = templateVars(record);
  const raw = flags.get("path");
  if (raw === undefined) {
    if (expected.length > 0) {
      invalid(`api get ${record.id} requires --path <pairs>`,
        `Provide ${expected.map((name) => `${name}=<value>`).join(", ")} for the ${record.path} route`);
    }
    return {};
  }
  if (typeof raw !== "string") invalid("--path needs name=value pairs joined with &");
  const params: Record<string, string> = {};
  for (const [name, value] of parsePairs(raw, "path")) {
    if (!expected.includes(name)) {
      invalid(`Unsupported path parameter: ${name}`,
        `Operation ${record.id} accepts: ${expected.join(", ") || "no path parameters"}`);
    }
    if (Object.hasOwn(params, name)) invalid(`Repeated path parameter: ${name}`);
    params[name] = value;
  }
  const missing = expected.filter((name) => !Object.hasOwn(params, name));
  if (missing.length > 0) {
    invalid(`Missing path parameter: ${missing.join(", ")}`,
      `Provide ${missing.map((name) => `${name}=<value>`).join(", ")} for the ${record.path} route`);
  }
  return params;
}

// Query keys must belong to the operation's recorded query allowlist; the
// session re-checks every key before any credential is attached.
export function rawQuery(
  record: CapabilityOperation, flags: ReadonlyMap<string, string | boolean>,
): Record<string, string> {
  const raw = flags.get("query");
  if (raw === undefined) return {};
  if (typeof raw !== "string") invalid("--query needs name=value pairs joined with &");
  const query: Record<string, string> = {};
  for (const [name, value] of parsePairs(raw, "query")) {
    if (!record.query.includes(name)) {
      invalid(`Unsupported query parameter: ${name}`,
        `Operation ${record.id} supports: ${record.query.join(", ") || "no query parameters"}`);
    }
    if (Object.hasOwn(query, name)) invalid(`Repeated query parameter: ${name}`);
    query[name] = name === "fields" || name === "exclude_fields"
      ? fieldSelection(record, value, `--query ${name}`).join(",") : value;
  }
  return query;
}

export function rawFields(
  record: CapabilityOperation, flags: ReadonlyMap<string, string | boolean>,
): readonly string[] {
  const raw = flags.get("fields");
  if (raw === undefined) return record.fields;
  if (typeof raw !== "string") invalid("--fields needs a comma-separated field list");
  return fieldSelection(record, raw, "--fields");
}

export function rawLimit(
  record: CapabilityOperation, flags: ReadonlyMap<string, string | boolean>,
): number {
  const raw = flags.get("limit");
  if (record.paging !== "collection") {
    if (raw !== undefined) {
      invalid(`Operation ${record.id} returns one response and takes no --limit`,
        "Omit --limit; use --fields to narrow the returned body");
    }
    return DEFAULT_COLLECTION_LIMIT;
  }
  if (raw === undefined) return DEFAULT_COLLECTION_LIMIT;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--limit must be a positive integer row limit", "Example: --limit 20");
  }
  return Number(raw);
}

function rawCursor(
  record: CapabilityOperation, flags: ReadonlyMap<string, string | boolean>,
): string | undefined {
  const raw = flags.get("cursor");
  if (raw === undefined) return undefined;
  if (record.paging !== "collection") {
    invalid(`Operation ${record.id} returns one response and takes no --cursor`,
      "Omit --cursor; reissue the read for a fresh response");
  }
  if (typeof raw !== "string" || !raw.trim()) invalid("--cursor requires the cursor from a previous read");
  return raw;
}

// The collection reader decodes rows through this callback; scalar rows are
// malformed for a field-projected read, so they fail the window instead of
// returning short rows.
function decodeRow(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new AxiError("Vectra raw response is malformed: expected an object row",
      "RESPONSE_INVALID", ["Check the API contract for this operation; the response body was discarded"]);
  }
  return row as Record<string, unknown>;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
}

function truncateValue(value: unknown, full: boolean): unknown {
  if (typeof value === "string" && !full && value.length > RAW_TRUNCATE_AT) {
    return `${value.slice(0, RAW_TRUNCATE_AT)}\n... (truncated, ${value.length} chars total)`;
  }
  if (Array.isArray(value)) return value.map((entry) => truncateValue(entry, full));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, truncateValue(entry, full)]));
  }
  return value;
}

function truncatedHelp(truncated: boolean): string[] {
  return truncated ? ["Re-run with --full for the complete text"] : [];
}

function isTruncated(value: unknown): boolean {
  if (typeof value === "string") return value.includes("... (truncated, ");
  if (Array.isArray(value)) return value.some(isTruncated);
  if (typeof value === "object" && value !== null) return Object.values(value).some(isTruncated);
  return false;
}

// Runs one raw read: validates flags before any credential or HTTP work,
// then serves collection windows through the CORE-02 reader or single
// responses through the session. Generation mismatches surface from the
// session as OPERATION_UNKNOWN with generation guidance.
export async function runApiGet(session: Session, flags: ReadonlyMap<string, string | boolean>): Promise<LeafResult> {
  const record = rawOperation(flags);
  const pathParams = rawPathParams(record, flags);
  const query = rawQuery(record, flags);
  const fields = rawFields(record, flags);
  const limit = rawLimit(record, flags);
  const cursor = rawCursor(record, flags);
  const full = flags.has("full");
  const profile = session.profile.name;

  if (record.paging === "collection") {
    const result = cursor !== undefined
      ? await resume(session, record.id, cursor, { query, pathParams, limit, decodeRow })
      : await collect(session, record.id, { query, pathParams, limit, decodeRow });
    const rows = result.rows.map((row) => truncateValue(project(row, fields), full));
    const shown = rows.length;
    const count = result.total === null || result.total === shown
      ? `${shown} rows`
      : `${shown} of ${result.total} rows`;
    if (result.error) {
      const failure = result.error;
      return { failed: true, output: {
        profile,
        operation: record.id,
        total: result.total,
        count,
        rows,
        complete: false,
        error: failure.message,
        code: failure.code,
        ...(result.cursor ? { cursor: result.cursor } : {}),
        help: [...failure.suggestions,
          ...(result.cursor ? ["Pass --cursor <cursor> with the same operation and filters to resume"] : []),
          ...truncatedHelp(isTruncated(rows))],
      } };
    }
    if (shown === 0) {
      return { failed: false, output: {
        profile,
        operation: record.id,
        total: result.total,
        count,
        rows: `0 rows found for ${record.id}`,
        complete: true,
        help: ["Widen the filters or omit --query to read every row"],
      } };
    }
    const help = [
      ...(result.cursor ? ["Pass --cursor <cursor> with the same operation and filters for the next window"] : []),
      ...truncatedHelp(isTruncated(rows)),
    ];
    return { failed: false, output: {
      profile,
      operation: record.id,
      total: result.total,
      count,
      rows,
      complete: true,
      ...(result.cursor ? { cursor: result.cursor } : {}),
      ...(help.length > 0 ? { help } : {}),
    } };
  }

  const { body } = await session.request(record.id, {
    ...(Object.keys(pathParams).length > 0 ? { pathParams } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
  });
  if (Array.isArray(body)) {
    const rows = body.map((row) => truncateValue(project(decodeRow(row), fields), full));
    if (rows.length === 0) {
      return { failed: false, output: {
        profile,
        operation: record.id,
        total: 0,
        count: "0 rows",
        rows: `0 rows found for ${record.id}`,
        complete: true,
      } };
    }
    return { failed: false, output: {
      profile,
      operation: record.id,
      total: rows.length,
      count: `${rows.length} rows`,
      rows,
      complete: true,
      ...(isTruncated(rows) ? { help: truncatedHelp(true) } : {}),
    } };
  }
  if (typeof body !== "object" || body === null) {
    throw new AxiError("Vectra raw response is malformed: expected an object or array body",
      "RESPONSE_INVALID", ["Check the API contract for this operation; the response body was discarded"]);
  }
  const result = truncateValue(project(body as Record<string, unknown>, fields), full);
  return { failed: false, output: {
    profile,
    operation: record.id,
    result,
    complete: true,
    ...(isTruncated(result) ? { help: truncatedHelp(true) } : {}),
  } };
}
