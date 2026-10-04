import { AxiError } from "axi-sdk-js";
import { collect, DEFAULT_COLLECTION_LIMIT, resume } from "./collections.js";
import type { Session } from "./session.js";

// READ-01: QUX detection list/show on the CORE-01 session and CORE-02
// collection reader. Later slices reuse this file's shape: catalogue flags map
// to the inventory's server-side query keys, rows are decoded and projected to
// the inventory's field subset, and every leaf validates before any credential
// or HTTP work. Hosts/accounts stay READ-02; notes/tags stay READ-03.

export const DETECTION_LIST_OPERATION = "qux.detection.list";
export const DETECTION_SHOW_OPERATION = "qux.detection.show";

// Longest description kept inline, following the az-axi truncation convention.
export const DETECTION_TRUNCATE_AT = 1200;

// CLI flag to server-side query key, covering the inventory's conservative
// query subset for qux.detection.list. Values pass through; the server applies
// them, so no client-side state enum or range is invented here.
const FILTER_FLAGS = {
  state: "state",
  "detection-type": "detection_type",
  "detection-category": "detection_category",
  "host-id": "host_id",
  tags: "tags",
  "certainty-gte": "certainty_gte",
  "threat-gte": "threat_gte",
  ordering: "ordering",
  "min-id": "min_id",
  "max-id": "max_id",
} as const;

export const DETECTION_LIST_FIELDS = ["id", "detection_type", "state", "threat", "certainty"] as const;

type ListQuery = Record<string, string | number | boolean>;

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

function integerFlag(flags: ReadonlyMap<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    invalid(`--${name} must be a non-negative integer`, `Example: --${name} 42`);
  }
  return Number(raw);
}

function numberFlag(flags: ReadonlyMap<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(Number(raw))) {
    invalid(`--${name} must be a number`, `Example: --${name} 70`);
  }
  return Number(raw);
}

// Validates list flags and maps them to server-side query keys. Resuming
// with --cursor replays the bound query, so the original filters must be
// repeated; resume() rejects a changed query context explicitly.
export function listQuery(flags: ReadonlyMap<string, string | boolean>): ListQuery {
  const query: ListQuery = {};
  for (const [flag, key] of Object.entries(FILTER_FLAGS)) {
    const raw = flags.get(flag);
    if (raw !== undefined) query[key] = raw;
  }
  for (const [flag, key] of [["host-id", "host_id"], ["min-id", "min_id"], ["max-id", "max_id"]] as const) {
    const parsed = integerFlag(flags, flag);
    if (parsed !== undefined) query[key] = parsed;
  }
  for (const [flag, key] of [["certainty-gte", "certainty_gte"], ["threat-gte", "threat_gte"]] as const) {
    const parsed = numberFlag(flags, flag);
    if (parsed !== undefined) query[key] = parsed;
  }
  return query;
}

export function listLimit(flags: ReadonlyMap<string, string | boolean>): number {
  const raw = flags.get("limit");
  if (raw === undefined) return DEFAULT_COLLECTION_LIMIT;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--limit must be a positive integer row limit", "Example: --limit 20");
  }
  return Number(raw);
}

// Client-side projection over the inventory's field subset. Unknown fields
// fail explicitly instead of silently returning short rows.
export function listFields(flags: ReadonlyMap<string, string | boolean>): readonly string[] {
  const raw = flags.get("fields");
  if (raw === undefined) return DETECTION_LIST_FIELDS;
  const fields = String(raw).split(",").map((field) => field.trim()).filter(Boolean);
  const unknown = fields.filter((field) => !(DETECTION_LIST_FIELDS as readonly string[]).includes(field));
  if (fields.length === 0 || unknown.length > 0) {
    invalid(`Unknown --fields value: ${unknown.join(", ") || "(empty)"}`,
      `Supported fields: ${DETECTION_LIST_FIELDS.join(", ")}`);
  }
  return [...new Set(fields)];
}

function decodeRow(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new AxiError("Vectra detection page is malformed: expected each row to be an object",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  const source = row as Record<string, unknown>;
  return {
    id: source.id ?? "",
    detection_type: source.detection_type ?? "",
    state: source.state ?? "",
    threat: source.threat ?? "",
    certainty: source.certainty ?? "",
  };
}

function summarizeFilters(query: ListQuery): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return "with no filters";
  return `with ${entries.map(([key, value]) => `${key} ${value}`).join(", ")}`;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function showCommand(session: Session, flags: ReadonlyMap<string, string | boolean>, id: unknown): string {
  const config = flags.get("config");
  return `vectra-axi detection show${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --id ${shellQuote(String(id))}`;
}

export type LeafResult = { output: Record<string, unknown>; failed: boolean };

// Runs the bounded list window and shapes the AXI output. Partial collection
// results keep their validated rows with complete:false, an inline error and a
// cursor; the caller reports them with a nonzero exit status.
export async function runDetectionList(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const query = listQuery(flags);
  const limit = listLimit(flags);
  const fields = listFields(flags);
  const cursor = flags.get("cursor");
  const result = typeof cursor === "string"
    ? await resume(session, DETECTION_LIST_OPERATION, cursor, { query, limit, decodeRow })
    : await collect(session, DETECTION_LIST_OPERATION, { query, limit, decodeRow });
  const rows = result.rows.map((row) =>
    Object.fromEntries(fields.map((field) => [field, row[field] ?? ""])));
  const shown = rows.length;
  const count = result.total === null || result.total === shown
    ? `${shown} detections`
    : `${shown} of ${result.total} detections`;
  const profile = session.profile.name;
  if (result.error) {
    const failure = result.error;
    return { failed: true, output: {
      profile,
      total: result.total,
      count,
      detections: rows,
      complete: false,
      error: failure.message,
      code: failure.code,
      ...(result.cursor ? { cursor: result.cursor } : {}),
      help: [...failure.suggestions,
        ...(result.cursor ? ["Pass --cursor <cursor> with the same filters to resume the pending page"] : [])],
    } };
  }
  if (shown === 0) {
    return { failed: false, output: {
      profile,
      total: result.total,
      count,
      detections: `0 detections found ${summarizeFilters(query)}`,
      complete: true,
      help: ["Widen the filters or omit them to list every detection"],
    } };
  }
  const firstId = result.rows[0]!.id;
  return { failed: false, output: {
    profile,
    total: result.total,
    count,
    detections: rows,
    complete: true,
    ...(result.cursor ? { cursor: result.cursor } : {}),
    help: [
      ...(result.cursor ? ["Pass --cursor <cursor> with the same filters for the next window"] : []),
      `Run \`${showCommand(session, flags, firstId)}\` for full detail`,
    ],
  } };
}

export function showId(flags: ReadonlyMap<string, string | boolean>): number {
  const raw = flags.get("id");
  if (raw === undefined) {
    invalid("detection show requires --id <id>",
      "Run `vectra-axi detection list` to find a detection ID",
      "Example: vectra-axi detection show --profile <name> --id 42");
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    invalid("--id must be a positive integer detection ID", "Example: --id 42");
  }
  return Number(raw);
}

function cell(value: unknown): unknown {
  return value ?? "";
}

// Shows one detection. --full prints the complete returned description;
// otherwise long text is previewed with its total and a --full hint. --full
// only reveals what the server returned, never content the response omits.
export async function runDetectionShow(
  session: Session, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  const id = showId(flags);
  const full = flags.has("full");
  const { body } = await session.request(DETECTION_SHOW_OPERATION, { pathParams: { id } });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AxiError("Vectra detection detail is malformed: expected an object",
      "RESPONSE_INVALID", ["Check the QUX v2.5 API contract for this operation"]);
  }
  const detail = body as Record<string, unknown>;
  const description = typeof detail.description === "string" ? detail.description : "";
  const truncated = !full && description.length > DETECTION_TRUNCATE_AT;
  const profile = session.profile.name;
  return { failed: false, output: {
    profile,
    id: cell(detail.id),
    detection_type: cell(detail.detection_type),
    state: cell(detail.state),
    threat: cell(detail.threat),
    certainty: cell(detail.certainty),
    description: truncated
      ? `${description.slice(0, DETECTION_TRUNCATE_AT)}\n... (truncated, ${description.length} chars total)`
      : description,
    ...(truncated
      ? { help: [`Run \`${showCommand(session, flags, id)} --full\` for the complete text`] }
      : {}),
  } };
}
