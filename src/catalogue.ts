import { existsSync, readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { inventorySchema } from "./inventory/schema.js";

export const DESCRIPTION = "Vectra AI QUX and RUX CLI for agents and the humans running them, with bounded reads and gated writes.";

// Inventory evidence never enables a runtime leaf. Endpoint slices bind IDs explicitly.
// This module loads both from source (src/catalogue.ts under Vitest) and packaged
// (dist/src/catalogue.js), so locate the package root instead of assuming depth.
function inventoryUrl(): URL {
  let dir = new URL("./", import.meta.url);
  for (;;) {
    if (existsSync(new URL("package.json", dir))) return new URL("inventory/capabilities.json", dir);
    const parent = new URL("../", dir);
    if (parent.href === dir.href) throw new Error("Cannot locate package root for inventory");
    dir = parent;
  }
}
export const inventory = inventorySchema.parse(JSON.parse(readFileSync(inventoryUrl(), "utf8")));

type Flag = { description: string } & (
  { kind: "boolean" } | { kind: "value"; valueName: string }
);
const globals: Readonly<Record<string, Flag>> = {
  help: { kind: "boolean", description: "Show concise help; default false" },
  profile: { kind: "value", valueName: "name", description: "Select a profile by name; default environment, config default, then sole profile" },
  config: { kind: "value", valueName: "path", description: "Read an explicit config; default VECTRA_AXI_CONFIG or the platform config directory" },
};
const exclusiveFlags = [["help", "profile"], ["all", "limit"]] as const;

export const catalogue: Readonly<Record<string, {
  description: string;
  flags: Readonly<Record<string, Flag>>;
  examples: readonly string[];
}>> = {
  home: {
    description: "Show up to five live active detections for the selected QUX/RUX profile; also the no-arguments view",
    flags: globals,
    examples: ["vectra-axi", "vectra-axi home", "vectra-axi home --profile <name>"],
  },
  setup: {
    description: "Show setup availability without installing or changing configuration",
    flags: globals,
    examples: ["vectra-axi setup", "vectra-axi setup --help"],
  },
  "setup hooks": {
    // AXI principle 7 ambient context: explicit opt-in installer for the
    // SessionStart hook. The hook runs the vectra-axi-hook entry point (a
    // local-only config summary from src/hook.ts), never the home view and
    // never the network.
    description: "Install or repair agent SessionStart hooks for vectra-axi ambient context",
    flags: globals,
    examples: [
      "vectra-axi setup hooks",
    ],
  },
  doctor: {
    // See README.md#doctor for generation-specific checks and safety
    // constraints; src/doctor.ts implements the leaf: one bounded detection
    // read per QUX profile, the named OAuth exchange alone per RUX profile.
    description: "Check profile configuration with one bounded detection read per QUX profile or OAuth exchange per RUX profile",
    flags: globals,
    examples: [
      "vectra-axi doctor",
      "vectra-axi doctor --profile <name>",
    ],
  },
  "auth status": {
    description: "Check local credentials and permissions without a network request; never print secrets",
    flags: globals,
    examples: ["vectra-axi auth status", "vectra-axi auth status --profile <name>"],
  },
  "profile list": {
    description: "List configured profiles without resolving secrets",
    flags: globals,
    examples: ["vectra-axi profile list", "vectra-axi profile list --config <path>"],
  },
  "config path": {
    description: "Show the selected configuration path",
    flags: globals,
    examples: ["vectra-axi config path", "vectra-axi config path --config <path>"],
  },
  "detection list": {
    // Filter flags cover the inventory's conservative qux.detection.list
    // query subset. Kebab-case names map to snake_case keys in
    // src/detections.ts; values pass through to the server.
    description: "List detections on QUX v2.5 or RUX v3.4 with server-side filters and a bounded window",
    flags: {
      ...globals,
      state: { kind: "value", valueName: "state", description: "Filter by server-side detection state" },
      "detection-type": { kind: "value", valueName: "type", description: "Filter by server-side detection type" },
      "detection-category": { kind: "value", valueName: "category", description: "Filter by server-side detection category" },
      "host-id": { kind: "value", valueName: "id", description: "Filter by server-side host ID (positive integer); cannot combine with --host-name" },
      "host-name": { kind: "value", valueName: "text", description: "Resolve a server-side host name search before listing detections; requires one unique ID in a complete bounded lookup, shares traversal budgets; cannot combine with --host-id" },
      tags: { kind: "value", valueName: "tags", description: "Filter by server-side tags" },
      "certainty-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum certainty" },
      "threat-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum threat" },
      ordering: { kind: "value", valueName: "ordering", description: "Server-side result ordering" },
      "min-id": { kind: "value", valueName: "id", description: "Server-side minimum detection ID (positive integer)" },
      "max-id": { kind: "value", valueName: "id", description: "Server-side maximum detection ID (positive integer)" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated detection fields, including first_timestamp,last_timestamp,src_ip,src_host,summary,grouped_details,is_triaged,triage_rule_id,triage_category,assigned_to,assigned_date,filtered_by_rule,filtered_by_user,filtered_by_ai,is_marked_custom; default id,detection_type,state,threat,certainty" },
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi detection list --profile <name> --state active --limit 100",
      "vectra-axi detection list --profile <name> --host-name web-01 --fields id,summary,grouped_details",
      "vectra-axi detection list --profile <name> --threat-gte 70 --fields id,state,threat",
      "vectra-axi detection list --profile <name> --cursor <cursor>",
    ],
  },
  "detection show": {
    description: "Show one QUX v2.5 or RUX v3.4 detection's scores, timing, source, description, summary, grouped target details, triage and assignment",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID to show (positive integer, required)" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,detection_type,state,threat,certainty,description,first_timestamp,last_timestamp,src_ip,src_host,summary,grouped_details,is_triaged,triage_rule_id,triage_category,assigned_to,assigned_date,filtered_by_rule,filtered_by_user,filtered_by_ai,is_marked_custom" },
      full: { kind: "boolean", description: "Show the complete description; default previews long text" },
    },
    examples: [
      "vectra-axi detection show --profile <name> --id 42",
      "vectra-axi detection show --profile <name> --id 42 --full",
    ],
  },
  "detection event list": {
    // RUX-03 (part a): checkpoint feed on the RUX v3.4 detection-events
    // route. --from starts at a returned checkpoint, --limit is an output
    // window only (never the upstream batch limit), timestamp bounds pass
    // through for the server to apply inclusively, and --cursor resumes a
    // capped batch with its original filters. remaining_count is reported
    // as returned, never as a stable total.
    description: "List RUX detection events from a checkpoint with a bounded window",
    flags: {
      ...globals,
      from: { kind: "value", valueName: "checkpoint", description: "Start from a returned checkpoint; default reads the earliest batch" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      "event-timestamp-gte": { kind: "value", valueName: "timestamp", description: "Filter by server-side minimum event timestamp, applied inclusively" },
      "event-timestamp-lte": { kind: "value", valueName: "timestamp", description: "Filter by server-side maximum event timestamp, applied inclusively" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped batch with its original filters" },
    },
    examples: [
      "vectra-axi detection event list --profile <name>",
      "vectra-axi detection event list --profile <name> --from <checkpoint> --limit 20",
      "vectra-axi detection event list --profile <name> --cursor <cursor>",
    ],
  },
  "host list": {
    // Filter flags cover the inventory's conservative qux.host.list query
    // subset. Score filters keep QUX display names while mapping to the wire
    // t_score_gte/c_score_gte keys in src/entities.ts.
    description: "List hosts on QUX v2.5 or RUX v3.4 with server-side filters and a bounded window",
    flags: {
      ...globals,
      name: { kind: "value", valueName: "text", description: "Filter by server-side host name; exact/partial and case matching are unspecified by the API guides" },
      "threat-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum threat score" },
      "certainty-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum certainty score" },
      tags: { kind: "value", valueName: "tags", description: "Filter by server-side tags" },
      "min-id": { kind: "value", valueName: "id", description: "Server-side minimum host ID (positive integer)" },
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      "max-id": { kind: "value", valueName: "id", description: "Server-side maximum host ID (positive integer)" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,name,state,threat,certainty" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi host list --profile <name> --name web-01",
      "vectra-axi host list --profile <name> --threat-gte 70",
      "vectra-axi host list --profile <name> --fields id,name,threat",
      "vectra-axi host list --profile <name> --cursor <cursor>",
    ],
  },
  "host show": {
    description: "Show every returned host field under host on QUX v2.5 or RUX v3.4 as raw TOON, with CLI metadata outside the host object",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID to show (positive integer, required)" },
      full: { kind: "boolean", description: "Show complete returned text; default previews strings longer than 500 characters" },
    },
    examples: [
      "vectra-axi host show --profile <name> --id 19",
    ],
  },
  "account list": {
    // Same conservative query subset as hosts, per the qux.account.list record.
    description: "List accounts on QUX v2.5 or RUX v3.4 with server-side filters and a bounded window",
    flags: {
      ...globals,
      "threat-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum threat score" },
      "certainty-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum certainty score" },
      tags: { kind: "value", valueName: "tags", description: "Filter by server-side tags" },
      "min-id": { kind: "value", valueName: "id", description: "Server-side minimum account ID (positive integer)" },
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      "max-id": { kind: "value", valueName: "id", description: "Server-side maximum account ID (positive integer)" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,name,state,threat,certainty" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi account list --profile <name> --threat-gte 70",
      "vectra-axi account list --profile <name> --fields id,name,threat",
      "vectra-axi account list --profile <name> --cursor <cursor>",
    ],
  },
  "account show": {
    description: "Show one account on QUX v2.5 or RUX v3.4 in full detail",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID to show (positive integer, required)" },
    },
    examples: [
      "vectra-axi account show --profile <name> --id 19",
    ],
  },
  "entity list": {
    // Type-qualified facade over host/account list: --type is required and
    // selects one kind's operation, never a merged ranking. The facade
    // CLI exposes no min/max ID flags and its fields carry no state;
    // the session still permits ID keys in server continuation links.
    description: "List entities of one kind on QUX v2.5 or RUX v3.4 with a bounded window; score filters are QUX-only",
    flags: {
      ...globals,
      type: { kind: "value", valueName: "kind", description: "Entity kind to list: host or account (required)" },
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      "threat-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum threat score" },
      "certainty-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum certainty score" },
      tags: { kind: "value", valueName: "tags", description: "Filter by server-side tags" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,name,threat,certainty on QUX or id,name,type,urgency_score,importance on RUX" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi entity list --profile <name> --type host",
      "vectra-axi entity list --profile <name> --type account --threat-gte 70",
    ],
  },
  "entity show": {
    description: "Show one entity of one kind on QUX v2.5 or RUX v3.4 in full detail",
    flags: {
      ...globals,
      type: { kind: "value", valueName: "kind", description: "Entity kind to show: host or account (required)" },
      id: { kind: "value", valueName: "id", description: "Entity ID to show (positive integer, required)" },
      full: { kind: "boolean", description: "Show complete returned text; default previews strings longer than 500 characters" },
    },
    examples: [
      "vectra-axi entity show --profile <name> --type host --id 19",
    ],
  },
  "entity scoring list": {
    // RUX-03 (part b): checkpoint feed on the RUX v3.4 entity-scoring
    // route. --type is required and selects the scored kind, --from starts
    // at a returned checkpoint, --limit is an output window only (never the
    // upstream batch limit), timestamp bounds pass through for the server
    // to apply inclusively, and --cursor resumes a capped batch with its
    // original filters. remaining_count is reported as returned, never as
    // a stable total. Scores pass through untouched; no conversion happens.
    description: "List RUX entity scoring events from a checkpoint with a bounded window",
    flags: {
      ...globals,
      type: { kind: "value", valueName: "kind", description: "Scored entity kind: host or account (required)" },
      from: { kind: "value", valueName: "checkpoint", description: "Start from a returned checkpoint; default reads the earliest batch" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      "event-timestamp-gte": { kind: "value", valueName: "timestamp", description: "Filter by server-side minimum event timestamp, applied inclusively" },
      "event-timestamp-lte": { kind: "value", valueName: "timestamp", description: "Filter by server-side maximum event timestamp, applied inclusively" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped batch with its original filters" },
    },
    examples: [
      "vectra-axi entity scoring list --profile <name> --type host",
      "vectra-axi entity scoring list --profile <name> --type host --from <checkpoint> --limit 20",
      "vectra-axi entity scoring list --profile <name> --type host --cursor <cursor>",
    ],
  },
  "detection triage set": {
    description: "Set a QUX or RUX per-detection triage label, suppressing scoring, through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated detection IDs, normalized and capped at 100 (required)" },
      category: { kind: "value", valueName: "label", description: "Nonempty custom triage label (required)" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target from the preview, required to execute" },
    },
    examples: [
      "vectra-axi detection triage set --profile <name> --ids 41 --category synthetic-triage",
      "vectra-axi detection triage set --profile <name> --ids 41,42 --category synthetic-triage",
    ],
  },
  "detection triage clear": {
    description: "Clear QUX or RUX per-detection triage suppression through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated detection IDs, normalized and capped at 100 (required)" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target from the preview, required to execute" },
    },
    examples: [
      "vectra-axi detection triage clear --profile <name> --ids 41",
      "vectra-axi detection triage clear --profile <name> --ids 41,42",
    ],
  },
  "detection fixed set": {
    description: "Set legacy QUX or RUX detection fixed state; marking fixed zeroes scores and close supersedes it on 9.3+",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Single detection ID; exactly one of --id or --ids is required" },
      ids: { kind: "value", valueName: "ids", description: "Comma-separated detection IDs, normalized and capped at 100" },
      value: { kind: "value", valueName: "bool", description: "Desired fixed state: true or false (required)" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target from the preview, required to execute" },
    },
    examples: [
      "vectra-axi detection fixed set --profile <name> --ids 41,42 --value true",
      "vectra-axi detection fixed set --profile <name> --id 42 --value false",
    ],
  },
  "detection close": {
    description: "Close QUX (9.3+) or RUX detections as remediated or benign through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Single detection ID; exactly one of --id or --ids is required" },
      ids: { kind: "value", valueName: "ids", description: "Comma-separated detection IDs, normalized and capped at 100" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target from the preview, required to execute a change" },
      reason: { kind: "value", valueName: "reason", description: "Close reason: remediated or benign (required)" },
    },
    examples: [
      "vectra-axi detection close --profile <name> --id 42 --reason benign",
      "vectra-axi detection close --profile <name> --ids 41,42 --reason remediated",
    ],
  },
  "detection open": {
    description: "Reopen QUX (9.3+) or RUX detections for scoring through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Single detection ID; exactly one of --id or --ids is required" },
      ids: { kind: "value", valueName: "ids", description: "Comma-separated detection IDs, normalized and capped at 100" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target from the preview, required to execute a change" },
    },
    examples: [
      "vectra-axi detection open --profile <name> --id 42",
      "vectra-axi detection open --profile <name> --ids 41,42",
    ],
  },
  "host key-asset set": {
    description: "Set a QUX or RUX host key-asset flag through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID (positive integer, required)" },
      value: { kind: "value", valueName: "bool", description: "Desired key-asset state: true or false (required)" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact host target from the preview, required to execute a change" },
    },
    examples: [
      "vectra-axi host key-asset set --profile <name> --id 7 --value true",
      "vectra-axi host key-asset set --profile <name> --id 7 --value false --execute --confirm 'host 7'",
    ],
  },
  "detection note list": {
    // Notes come only from the dedicated versioned notes resource, never
    // from the embedded detail summary. --full prints the complete returned
    // text; it cannot restore content the upstream response never returned.
    description: "List full detection notes on QUX v2.5 or RUX v3.4 through the dedicated notes route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID whose notes to list (positive integer, required)" },
      full: { kind: "boolean", description: "Show complete returned note text; default previews long notes" },
    },
    examples: [
      "vectra-axi detection note list --profile <name> --id 42",
      "vectra-axi detection note list --profile <name> --id 42 --full",
    ],
  },
  "detection tag list": {
    description: "List detection tags on QUX v2.5 or RUX v3.4 through the tagging route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID whose tags to list (positive integer, required)" },
    },
    examples: [
      "vectra-axi detection tag list --profile <name> --id 42",
    ],
  },
  "detection tag set": {
    description: "Replace QUX or RUX detection tags with the exact desired set through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID whose tags to replace (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target detection <id> when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated desired tags (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read desired tags from a file, one per line; empty clears all tags; use - for stdin" },
      execute: { kind: "boolean", description: "Send the replace after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi detection tag set --profile <name> --id 42 --tags a,b",
      "vectra-axi detection tag set --profile <name> --id 42 --tags a,b --execute --confirm 'detection 42'",
    ],
  },
  "detection tag bulk-set": {
    description: "Add tags to QUX or RUX detections in bulk with per-target diffs through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated target detection IDs to change (positive integers, at most 100; required with no --ids-file)" },
      "ids-file": { kind: "value", valueName: "path", description: "Read target detection IDs from a file, one per line; use - for stdin (required with no --ids)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target count and set when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated tags to add (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read tags to add from a file, one per line; use - for stdin" },
      execute: { kind: "boolean", description: "Send the changes after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi detection tag bulk-set --profile <name> --ids 41,42 --tags a,b",
      "vectra-axi detection tag bulk-set --profile <name> --ids 41,42 --tags a,b --execute --confirm '2 targets: detection 41, detection 42'",
    ],
  },
  "detection tag bulk-delete": {
    description: "Remove tags from QUX or RUX detections in bulk with per-target diffs through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated target detection IDs to change (positive integers, at most 100; required with no --ids-file)" },
      "ids-file": { kind: "value", valueName: "path", description: "Read target detection IDs from a file, one per line; use - for stdin (required with no --ids)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target count and set when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated tags to remove (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read tags to remove from a file, one per line; use - for stdin" },
      execute: { kind: "boolean", description: "Send the changes after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi detection tag bulk-delete --profile <name> --ids 41,42 --tags a,b",
      "vectra-axi detection tag bulk-delete --profile <name> --ids 41,42 --tags a,b --execute --confirm '2 targets: detection 41, detection 42'",
    ],
  },
  "detection note bulk-add": {
    description: "Append one note to up to 100 explicit RUX detection targets through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated positive target IDs (required, maximum 100 unique IDs)" },
      note: { kind: "value", valueName: "text", description: "Non-empty note text" },
      "note-file": { kind: "value", valueName: "path", description: "Read exact note text from a file; use - for stdin" },
      execute: { kind: "boolean", description: "Send the append; default previews without sending" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target count and set shown in the preview" },
    },
    examples: [
      "vectra-axi detection note bulk-add --profile <name> --ids 7,8 --note <text>",
      "vectra-axi detection note bulk-add --profile <name> --ids 7,8 --note-file ./note.txt --execute --confirm '2 targets: detection 7, detection 8'",
    ],
  },
  "detection note add": {
    description: "Append one QUX or RUX detection note through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID to append the note to (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target detection <id> when executing a change" },
      note: { kind: "value", valueName: "text", description: "Note text to append (non-empty)" },
      "note-file": { kind: "value", valueName: "path", description: "Read the note to append from a file exactly as stored; use - for stdin" },
      execute: { kind: "boolean", description: "Send the append after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi detection note add --profile <name> --id 42 --note <text>",
      "vectra-axi detection note add --profile <name> --id 42 --note <text> --execute --confirm 'detection 42'",
    ],
  },
  "detection note edit": {
    description: "Replace one detection note's text through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID owning the note (positive integer, required)" },
      "note-id": { kind: "value", valueName: "id", description: "Note ID to replace (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target detection <id> note <note-id> when executing a change" },
      note: { kind: "value", valueName: "text", description: "Replacement note text (non-empty)" },
      "note-file": { kind: "value", valueName: "path", description: "Read the replacement text from a file exactly as stored; use - for stdin" },
      execute: { kind: "boolean", description: "Send the edit after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi detection note edit --profile <name> --id 42 --note-id 7 --note <text>",
      "vectra-axi detection note edit --profile <name> --id 42 --note-id 7 --note <text> --execute --confirm 'detection 42 note 7'",
    ],
  },
  "detection note delete": {
    description: "Delete one detection note through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID owning the note (positive integer, required)" },
      "note-id": { kind: "value", valueName: "id", description: "Note ID to delete (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target detection <id> note <note-id> when executing a change" },
      execute: { kind: "boolean", description: "Send the delete after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi detection note delete --profile <name> --id 42 --note-id 7",
      "vectra-axi detection note delete --profile <name> --id 42 --note-id 7 --execute --confirm 'detection 42 note 7'",
    ],
  },
  "host close": {
    description: "Close a host and all its active detections through the gated disruptive write pipeline (QUX 9.3+, RUX)",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID (positive integer, required)" },
      reason: { kind: "value", valueName: "reason", description: "remediated or benign (required)" },
      "dry-run": { kind: "boolean", description: "Preview the active detection count without sending (default)" },
      execute: { kind: "boolean", description: "Execute the reviewed close" },
      confirm: { kind: "value", valueName: "target", description: "Exact target host <id> (required with --execute)" },
    },
    examples: [
      "vectra-axi host close --profile <name> --id 7 --reason remediated",
      "vectra-axi host close --profile <name> --id 7 --reason remediated --execute --confirm 'host 7'",
    ],
  },
  "account close": {
    description: "Close an account and all its active detections through the gated disruptive write pipeline (QUX 9.3+, RUX)",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID (positive integer, required)" },
      reason: { kind: "value", valueName: "reason", description: "remediated or benign (required)" },
      "dry-run": { kind: "boolean", description: "Preview the active detection count without sending (default)" },
      execute: { kind: "boolean", description: "Execute the reviewed close" },
      confirm: { kind: "value", valueName: "target", description: "Exact target account <id> (required with --execute)" },
    },
    examples: [
      "vectra-axi account close --profile <name> --id 7 --reason benign",
      "vectra-axi account close --profile <name> --id 7 --reason benign --execute --confirm 'account 7'",
    ],
  },
  "host note list": {
    description: "List full host notes on QUX v2.5 or RUX v3.4 through the dedicated notes route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID whose notes to list (positive integer, required)" },
      full: { kind: "boolean", description: "Show complete returned note text; default previews long notes" },
    },
    examples: [
      "vectra-axi host note list --profile <name> --id 19",
      "vectra-axi host note list --profile <name> --id 19 --full",
    ],
  },
  "host tag list": {
    description: "List host tags on QUX v2.5 or RUX v3.4 through the tagging route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID whose tags to list (positive integer, required)" },
    },
    examples: [
      "vectra-axi host tag list --profile <name> --id 19",
    ],
  },
  "host tag set": {
    description: "Replace QUX or RUX host tags with the exact desired set through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID whose tags to replace (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target host <id> when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated desired tags (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read desired tags from a file, one per line; empty clears all tags; use - for stdin" },
      execute: { kind: "boolean", description: "Send the replace after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi host tag set --profile <name> --id 19 --tags a,b",
      "vectra-axi host tag set --profile <name> --id 19 --tags a,b --execute --confirm 'host 19'",
    ],
  },
  "host tag bulk-set": {
    description: "Add tags to QUX or RUX hosts in bulk with per-target diffs through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated target host IDs to change (positive integers, at most 100; required with no --ids-file)" },
      "ids-file": { kind: "value", valueName: "path", description: "Read target host IDs from a file, one per line; use - for stdin (required with no --ids)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target count and set when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated tags to add (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read tags to add from a file, one per line; use - for stdin" },
      execute: { kind: "boolean", description: "Send the changes after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi host tag bulk-set --profile <name> --ids 7,8 --tags a,b",
      "vectra-axi host tag bulk-set --profile <name> --ids 7,8 --tags a,b --execute --confirm '2 targets: host 7, host 8'",
    ],
  },
  "host tag bulk-delete": {
    description: "Remove tags from QUX or RUX hosts in bulk with per-target diffs through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated target host IDs to change (positive integers, at most 100; required with no --ids-file)" },
      "ids-file": { kind: "value", valueName: "path", description: "Read target host IDs from a file, one per line; use - for stdin (required with no --ids)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target count and set when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated tags to remove (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read tags to remove from a file, one per line; use - for stdin" },
      execute: { kind: "boolean", description: "Send the changes after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi host tag bulk-delete --profile <name> --ids 7,8 --tags a,b",
      "vectra-axi host tag bulk-delete --profile <name> --ids 7,8 --tags a,b --execute --confirm '2 targets: host 7, host 8'",
    ],
  },
  "host note bulk-add": {
    description: "Append one note to up to 100 explicit RUX host targets through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated positive target IDs (required, maximum 100 unique IDs)" },
      note: { kind: "value", valueName: "text", description: "Non-empty note text" },
      "note-file": { kind: "value", valueName: "path", description: "Read exact note text from a file; use - for stdin" },
      execute: { kind: "boolean", description: "Send the append; default previews without sending" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target count and set shown in the preview" },
    },
    examples: [
      "vectra-axi host note bulk-add --profile <name> --ids 7,8 --note <text>",
      "vectra-axi host note bulk-add --profile <name> --ids 7,8 --note-file ./note.txt --execute --confirm '2 targets: host 7, host 8'",
    ],
  },
  "host note add": {
    description: "Append one QUX or RUX host note through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID to append the note to (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target host <id> when executing a change" },
      note: { kind: "value", valueName: "text", description: "Note text to append (non-empty)" },
      "note-file": { kind: "value", valueName: "path", description: "Read the note to append from a file exactly as stored; use - for stdin" },
      execute: { kind: "boolean", description: "Send the append after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi host note add --profile <name> --id 19 --note <text>",
      "vectra-axi host note add --profile <name> --id 19 --note <text> --execute --confirm 'host 19'",
    ],
  },
  "host note edit": {
    description: "Replace one host note's text through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID owning the note (positive integer, required)" },
      "note-id": { kind: "value", valueName: "id", description: "Note ID to replace (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target host <id> note <note-id> when executing a change" },
      note: { kind: "value", valueName: "text", description: "Replacement note text (non-empty)" },
      "note-file": { kind: "value", valueName: "path", description: "Read the replacement text from a file exactly as stored; use - for stdin" },
      execute: { kind: "boolean", description: "Send the edit after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi host note edit --profile <name> --id 19 --note-id 7 --note <text>",
      "vectra-axi host note edit --profile <name> --id 19 --note-id 7 --note <text> --execute --confirm 'host 19 note 7'",
    ],
  },
  "host note delete": {
    description: "Delete one host note through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID owning the note (positive integer, required)" },
      "note-id": { kind: "value", valueName: "id", description: "Note ID to delete (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target host <id> note <note-id> when executing a change" },
      execute: { kind: "boolean", description: "Send the delete after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi host note delete --profile <name> --id 19 --note-id 7",
      "vectra-axi host note delete --profile <name> --id 19 --note-id 7 --execute --confirm 'host 19 note 7'",
    ],
  },
  "account note list": {
    description: "List full account notes on QUX v2.5 or RUX v3.4 through the dedicated notes route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID whose notes to list (positive integer, required)" },
      full: { kind: "boolean", description: "Show complete returned note text; default previews long notes" },
    },
    examples: [
      "vectra-axi account note list --profile <name> --id 19",
      "vectra-axi account note list --profile <name> --id 19 --full",
    ],
  },
  "account tag list": {
    description: "List account tags on QUX v2.5 or RUX v3.4 through the tagging route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID whose tags to list (positive integer, required)" },
    },
    examples: [
      "vectra-axi account tag list --profile <name> --id 19",
    ],
  },
  "account tag set": {
    description: "Replace QUX or RUX account tags with the exact desired set through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID whose tags to replace (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target account <id> when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated desired tags (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read desired tags from a file, one per line; empty clears all tags; use - for stdin" },
      execute: { kind: "boolean", description: "Send the replace after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi account tag set --profile <name> --id 19 --tags a,b",
      "vectra-axi account tag set --profile <name> --id 19 --tags a,b --execute --confirm 'account 19'",
    ],
  },
  "account tag bulk-set": {
    description: "Add tags to QUX or RUX accounts in bulk with per-target diffs through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated target account IDs to change (positive integers, at most 100; required with no --ids-file)" },
      "ids-file": { kind: "value", valueName: "path", description: "Read target account IDs from a file, one per line; use - for stdin (required with no --ids)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target count and set when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated tags to add (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read tags to add from a file, one per line; use - for stdin" },
      execute: { kind: "boolean", description: "Send the changes after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi account tag bulk-set --profile <name> --ids 7,8 --tags a,b",
      "vectra-axi account tag bulk-set --profile <name> --ids 7,8 --tags a,b --execute --confirm '2 targets: account 7, account 8'",
    ],
  },
  "account tag bulk-delete": {
    description: "Remove tags from QUX or RUX accounts in bulk with per-target diffs through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated target account IDs to change (positive integers, at most 100; required with no --ids-file)" },
      "ids-file": { kind: "value", valueName: "path", description: "Read target account IDs from a file, one per line; use - for stdin (required with no --ids)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target count and set when executing a change" },
      tags: { kind: "value", valueName: "tags", description: "Comma-separated tags to remove (at least one)" },
      "tags-file": { kind: "value", valueName: "path", description: "Read tags to remove from a file, one per line; use - for stdin" },
      execute: { kind: "boolean", description: "Send the changes after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi account tag bulk-delete --profile <name> --ids 7,8 --tags a,b",
      "vectra-axi account tag bulk-delete --profile <name> --ids 7,8 --tags a,b --execute --confirm '2 targets: account 7, account 8'",
    ],
  },
  "account note bulk-add": {
    description: "Append one note to up to 100 explicit RUX account targets through the gated write pipeline",
    flags: {
      ...globals,
      ids: { kind: "value", valueName: "ids", description: "Comma-separated positive target IDs (required, maximum 100 unique IDs)" },
      note: { kind: "value", valueName: "text", description: "Non-empty note text" },
      "note-file": { kind: "value", valueName: "path", description: "Read exact note text from a file; use - for stdin" },
      execute: { kind: "boolean", description: "Send the append; default previews without sending" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target count and set shown in the preview" },
    },
    examples: [
      "vectra-axi account note bulk-add --profile <name> --ids 7,8 --note <text>",
      "vectra-axi account note bulk-add --profile <name> --ids 7,8 --note-file ./note.txt --execute --confirm '2 targets: account 7, account 8'",
    ],
  },
  "account note add": {
    description: "Append one QUX or RUX account note through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID to append the note to (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target account <id> when executing a change" },
      note: { kind: "value", valueName: "text", description: "Note text to append (non-empty)" },
      "note-file": { kind: "value", valueName: "path", description: "Read the note to append from a file exactly as stored; use - for stdin" },
      execute: { kind: "boolean", description: "Send the append after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi account note add --profile <name> --id 19 --note <text>",
      "vectra-axi account note add --profile <name> --id 19 --note <text> --execute --confirm 'account 19'",
    ],
  },
  "account note edit": {
    description: "Replace one account note's text through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID owning the note (positive integer, required)" },
      "note-id": { kind: "value", valueName: "id", description: "Note ID to replace (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target account <id> note <note-id> when executing a change" },
      note: { kind: "value", valueName: "text", description: "Replacement note text (non-empty)" },
      "note-file": { kind: "value", valueName: "path", description: "Read the replacement text from a file exactly as stored; use - for stdin" },
      execute: { kind: "boolean", description: "Send the edit after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi account note edit --profile <name> --id 19 --note-id 7 --note <text>",
      "vectra-axi account note edit --profile <name> --id 19 --note-id 7 --note <text> --execute --confirm 'account 19 note 7'",
    ],
  },
  "account note delete": {
    description: "Delete one account note through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID owning the note (positive integer, required)" },
      "note-id": { kind: "value", valueName: "id", description: "Note ID to delete (positive integer, required)" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target account <id> note <note-id> when executing a change" },
      execute: { kind: "boolean", description: "Send the delete after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi account note delete --profile <name> --id 19 --note-id 7",
      "vectra-axi account note delete --profile <name> --id 19 --note-id 7 --execute --confirm 'account 19 note 7'",
    ],
  },
  "assignment list": {
    // Filter flags cover both generations' assignment.list query subset.
    // Singular CLI names map to the plural wire keys in src/assignments.ts;
    // values pass through to the server. Assignments and outcomes are
    // distinct resources: rows carry the target host/account ID and a
    // CLI-derived unresolved/resolved status, never a merged outcome.
    description: "List QUX or RUX assignments with server-side filters and a bounded window",
    flags: {
      ...globals,
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      account: { kind: "value", valueName: "id", description: "Filter by server-side account ID (non-negative integer)" },
      host: { kind: "value", valueName: "id", description: "Filter by server-side host ID (non-negative integer)" },
      assignee: { kind: "value", valueName: "id", description: "Filter by server-side assignee user ID (non-negative integer)" },
      resolution: { kind: "value", valueName: "id", description: "Filter by server-side resolution outcome ID (non-negative integer)" },
      resolved: { kind: "value", valueName: "bool", description: "Filter by server-side resolved status: true or false" },
      "created-after": { kind: "value", valueName: "timestamp", description: "Filter by server-side creation timestamp" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,host_id,account_id,date_resolved,status" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi assignment list --profile <name> --resolved false",
      "vectra-axi assignment list --profile <name> --assignee 3 --limit 20",
      "vectra-axi assignment list --profile <name> --cursor <cursor>",
    ],
  },
  "assignment set": {
    // Desired-state host/account assignment through the WRITE-00 gate
    // pipeline (src/assignment-set.ts). Exactly one entity selector
    // (--host xor --account) and exactly one desired state (--user xor
    // --unassign); detections have no assignment route and resolving stays
    // a separate operation.
    description: "Set a QUX or RUX host or account assignment to an exact user through the gated write pipeline",
    flags: {
      ...globals,
      host: { kind: "value", valueName: "id", description: "Host ID whose assignment to set (positive integer, required with no --account)" },
      account: { kind: "value", valueName: "id", description: "Account ID whose assignment to set (positive integer, required with no --host)" },
      user: { kind: "value", valueName: "id", description: "User ID to assign the entity to (positive integer, required with no --unassign)" },
      unassign: { kind: "boolean", description: "Clear the entity assignment; cannot be combined with --user" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact target host|account <id> when executing a change" },
      execute: { kind: "boolean", description: "Send the change after the preview; default shows the dry run" },
      "dry-run": { kind: "boolean", description: "Show the preview without sending; cannot be combined with --execute" },
    },
    examples: [
      "vectra-axi assignment set --profile <name> --host 7 --user 3",
      "vectra-axi assignment set --profile <name> --host 7 --user 3 --execute --confirm 'host 7'",
      "vectra-axi assignment set --profile <name> --account 7 --unassign --execute --confirm 'account 7'",
    ],
  },
  "assignment resolve": {
    description: "Permanently resolve an open QUX or RUX host or account assignment through the gated write pipeline; there is no unresolve",
    flags: {
      ...globals,
      host: { kind: "value", valueName: "id", description: "Host ID; exactly one of --host or --account is required" },
      account: { kind: "value", valueName: "id", description: "Account ID; exactly one of --host or --account is required" },
      outcome: { kind: "value", valueName: "id", description: "Existing assignment outcome ID (required)" },
      note: { kind: "value", valueName: "text", description: "Optional resolution note; cannot combine with --note-file" },
      "note-file": { kind: "value", valueName: "path", description: "Read the optional note from a file or - for stdin" },
      detections: { kind: "value", valueName: "ids", description: "Comma-separated detection IDs (up to 100); requires --mark-fixed or --triage-as" },
      "mark-fixed": { kind: "boolean", description: "Mark selected detections fixed; requires --detections and excludes --triage-as" },
      "triage-as": { kind: "value", valueName: "label", description: "Triage selected detections under this label; requires --detections and excludes --mark-fixed" },
      confirm: { kind: "value", valueName: "target", description: "Confirm the exact host|account <id> target when executing" },
      execute: { kind: "boolean", description: "Send the resolution; default previews without sending" },
      "dry-run": { kind: "boolean", description: "Preview without sending; cannot combine with --execute" },
    },
    examples: [
      "vectra-axi assignment resolve --profile <name> --host 7 --outcome 1 --note 'Investigation complete'",
      "vectra-axi assignment resolve --profile <name> --account 7 --outcome 1 --execute --confirm 'account 7'",
      "vectra-axi assignment resolve --profile <name> --host 7 --outcome 1 --detections 41,42 --mark-fixed",
    ],
  },
  "threat-feed list": {
    description: "Read QUX or RUX threat-feed list",
    flags: {
      ...globals,
      all: { kind: "boolean", description: "RUX only: traverse collection pages within 10 requests, 8 MiB, 60 seconds and 10000 rows" },
      limit: { kind: "value", valueName: "rows", description: "Output row window; default 100; cannot combine with --all" },
    },
    examples: ["vectra-axi threat-feed list --help", "vectra-axi threat-feed list --profile <name>"],
  },
  "threat-feed show": {
    description: "Read QUX or RUX threat-feed show",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Threat-feed string ID (required)" },
    },
    examples: ["vectra-axi threat-feed show --help", "vectra-axi threat-feed show --profile <name> --id <id>"],
  },
  "threat-feed create": {
    description: "Preview or execute gated QUX or RUX threat-feed create",
    flags: {
      ...globals,
      name: { kind: "value", valueName: "name", description: "Feed name (required for create)" },
      category: { kind: "value", valueName: "cnc|exfil|lateral", description: "Detection category (required for create)" },
      certainty: { kind: "value", valueName: "Low|Medium|High", description: "Detection certainty (required for create)" },
      "indicator-type": { kind: "value", valueName: "type", description: "Anonymization, C2, Exfiltration, Malware Artifacts or Watchlist (required for create)" },
      duration: { kind: "value", valueName: "days", description: "Positive integer lifetime in days (required for create)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi threat-feed create --help", "vectra-axi threat-feed create --profile <name> --name neutral-feed --category cnc --certainty High --indicator-type Watchlist --duration 7"],
  },
  "threat-feed edit": {
    description: "Preview or execute gated QUX or RUX threat-feed edit",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Threat-feed string ID (required)" },
      name: { kind: "value", valueName: "name", description: "Feed name (required for create)" },
      category: { kind: "value", valueName: "cnc|exfil|lateral", description: "Detection category (required for create)" },
      certainty: { kind: "value", valueName: "Low|Medium|High", description: "Detection certainty (required for create)" },
      "indicator-type": { kind: "value", valueName: "type", description: "Anonymization, C2, Exfiltration, Malware Artifacts or Watchlist (required for create)" },
      duration: { kind: "value", valueName: "days", description: "Positive integer lifetime in days (required for create)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi threat-feed edit --help", "vectra-axi threat-feed edit --profile <name> --id <id> --duration 14"],
  },
  "threat-feed delete": {
    description: "Preview or execute gated QUX or RUX threat-feed delete",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Threat-feed string ID (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi threat-feed delete --help", "vectra-axi threat-feed delete --profile <name> --id <id>"],
  },
  "threat-feed file set": {
    description: "Preview or execute gated QUX or RUX threat-feed file set",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Threat-feed string ID (required)" },
      file: { kind: "value", valueName: "path", description: "STIX file path, at most 5000000 bytes; stdin is refused" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi threat-feed file set --help", "vectra-axi threat-feed file set --profile <name> --id <id> --file <stix>"],
  },
  "threat-feed file delete": {
    description: "Preview or execute gated QUX or RUX threat-feed file delete",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Threat-feed string ID (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi threat-feed file delete --help", "vectra-axi threat-feed file delete --profile <name> --id <id>"],
  },
  "match enablement show": {
    description: "Read current Match enablement for one device",
    flags: {
      ...globals,
      device: { kind: "value", valueName: "serial", description: "Device serial (required)" },
    },
    examples: ["vectra-axi match enablement show --help", "vectra-axi match enablement show --profile <name> --device SYNTH0001"],
  },
  "match ruleset show": {
    description: "Read Match ruleset metadata without rule contents",
    flags: {
      ...globals,
      uuid: { kind: "value", valueName: "uuid", description: "Ruleset UUID (required)" },
    },
    examples: ["vectra-axi match ruleset show --help", "vectra-axi match ruleset show --profile <name> --uuid <uuid>"],
  },
  "match assignment list": {
    description: "Read all Match device-to-ruleset assignments",
    flags: {
      ...globals,
    },
    examples: ["vectra-axi match assignment list --help", "vectra-axi match assignment list --profile <name>"],
  },
  "match enablement set": {
    description: "Preview or execute disruptive Match enablement; changing state causes a reboot; valid licence required to enable",
    flags: {
      ...globals,
      device: { kind: "value", valueName: "serial", description: "Device serial (required)" },
      value: { kind: "value", valueName: "true|false", description: "Desired enablement (required); changing state causes a reboot; enabling requires a valid Match licence" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only; requires hand-edited profile opt-in and allowlist" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi match enablement set --help", "vectra-axi match enablement set --profile <name> --device SYNTH0001 --value true"],
  },
  "match ruleset upload": {
    description: "Upload Match rules through bounded multipart; licence required; RUX /rules/ is deprecated, staged /rules/upload/ is the documented successor (follow-up candidate)",
    flags: {
      ...globals,
      file: { kind: "value", valueName: "path", description: "Regular ruleset file path only, never stdin; maximum 5000000 bytes; preview and journal contain metadata only (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only; requires hand-edited profile opt-in and allowlist" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi match ruleset upload --help", "vectra-axi match ruleset upload --profile <name> --file <file>"],
  },
  "match ruleset delete": {
    description: "Preview or execute gated Match ruleset delete",
    flags: {
      ...globals,
      uuid: { kind: "value", valueName: "uuid", description: "Ruleset UUID (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only; requires hand-edited profile opt-in and allowlist" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi match ruleset delete --help", "vectra-axi match ruleset delete --profile <name> --uuid <uuid>"],
  },
  "match assignment set": {
    description: "Preview or execute gated Match assignment set",
    flags: {
      ...globals,
      device: { kind: "value", valueName: "serial", description: "Device serial (required)" },
      uuid: { kind: "value", valueName: "uuid", description: "Ruleset UUID (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only; requires hand-edited profile opt-in and allowlist" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi match assignment set --help", "vectra-axi match assignment set --profile <name> --device SYNTH0001 --uuid <uuid>"],
  },
  "match assignment delete": {
    description: "Preview or execute gated Match assignment delete",
    flags: {
      ...globals,
      device: { kind: "value", valueName: "serial", description: "Device serial (required)" },
      uuid: { kind: "value", valueName: "uuid", description: "Ruleset UUID (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only; requires hand-edited profile opt-in and allowlist" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi match assignment delete --help", "vectra-axi match assignment delete --profile <name> --device SYNTH0001 --uuid <uuid>"],
  },
  "setting internal-network show": {
    description: "Show QUX internal-network monitoring and drop lists",
    flags: globals,
    examples: ["vectra-axi setting internal-network show --profile <name>", "vectra-axi setting internal-network show --help"],
  },
  "setting internal-network set": {
    description: "Replace QUX internal-network lists; high risk: changes what is monitored or dropped",
    flags: {
      ...globals,
      include: { kind: "value", valueName: "cidrs|none", description: "Full comma-separated network CIDRs to include; 'none' clears (required)" },
      exclude: { kind: "value", valueName: "cidrs|none", description: "Full comma-separated network CIDRs to exclude; 'none' clears (required)" },
      drop: { kind: "value", valueName: "cidrs|none", description: "Full comma-separated network CIDRs to drop; 'none' clears (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default before/after preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact target 'internal network' required with --execute" },
    },
    examples: ["vectra-axi setting internal-network set --profile <name> --include 198.51.100.0/24 --exclude none --drop none", "vectra-axi setting internal-network set --help"],
  },
  "setting syslog set": {
    description: "Replace QUX syslog export configuration; disruptive: redirects detection export (data egress)",
    flags: {
      ...globals,
      "config-file": { kind: "value", valueName: "path|-", description: "Full JSON configuration document with real secrets; redacted placeholders rejected; '-' reads stdin (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default redacted before/after preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact target 'syslog export' required with --execute" },
    },
    examples: ["vectra-axi setting syslog set --profile <name> --config-file <path>", "vectra-axi setting syslog set --help"],
  },
  "setting kafka set": {
    description: "Replace QUX Kafka export configuration; disruptive: redirects detection export (data egress)",
    flags: {
      ...globals,
      "config-file": { kind: "value", valueName: "path|-", description: "Full JSON configuration document with real secrets; redacted placeholders rejected; '-' reads stdin (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default redacted before/after preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact target 'kafka export' required with --execute" },
    },
    examples: ["vectra-axi setting kafka set --profile <name> --config-file <path>", "vectra-axi setting kafka set --help"],
  },
  "notification destination list": {
    description: "List RUX notification destinations; webhook URLs and tokens are redacted",
    flags: globals,
    examples: ["vectra-axi notification destination list --profile <name>", "vectra-axi notification destination list --help"],
  },
  "notification destination show": {
    description: "Show a RUX notification destination with webhook URLs and tokens redacted",
    flags: { ...globals, id: { kind: "value", valueName: "id", description: "Destination string ID (required)" } },
    examples: ["vectra-axi notification destination show --profile <name> --id <id>", "vectra-axi notification destination show --help"],
  },
  "notification destination create": {
    description: "Create a RUX notification destination; high risk: external event data egress",
    flags: {
      ...globals,
      "config-file": { kind: "value", valueName: "path|-", description: "JSON destination_type, title, optional enabled and config with destination_params.url and optional event_rules (required); URLs and tokens are redacted" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact target 'new notification destination' required with --execute" },
    },
    examples: ["vectra-axi notification destination create --profile <name> --config-file <path>", "vectra-axi notification destination create --help"],
  },
  "notification destination edit": {
    description: "Fully replace a RUX notification destination; high risk: external event data egress",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Destination string ID (required)" },
      "config-file": { kind: "value", valueName: "path|-", description: "Full JSON destination document, including the original URL and tokens (required); redacted read output cannot be replayed" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi notification destination edit --profile <name> --id <id> --config-file <path>", "vectra-axi notification destination edit --help"],
  },
  "notification destination delete": {
    description: "Delete a RUX notification destination; high risk: stops external event delivery",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Destination string ID (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi notification destination delete --profile <name> --id <id>", "vectra-axi notification destination delete --help"],
  },
  "proxy list": {
    description: "List QUX or RUX proxies",
    flags: globals,
    examples: ["vectra-axi proxy list --profile <name>", "vectra-axi proxy list --help"],
  },
  "proxy show": {
    description: "Show one QUX or RUX proxy",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Proxy string ID (required)" },
    },
    examples: ["vectra-axi proxy show --profile <name> --id <id>", "vectra-axi proxy show --help"],
  },
  "proxy create": {
    description: "Create a user-defined QUX or RUX proxy through the gated write pipeline",
    flags: {
      ...globals,
      address: { kind: "value", valueName: "ip", description: "Proxy IP address (required)" },
      consider: { kind: "value", valueName: "true|false", description: "Whether to consider the address as a proxy (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi proxy create --profile <name> --address 192.0.2.10 --consider true", "vectra-axi proxy create --help"],
  },
  "proxy edit": {
    description: "Edit a user-defined QUX or RUX proxy through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Proxy string ID (required)" },
      address: { kind: "value", valueName: "ip", description: "Proxy IP address" },
      consider: { kind: "value", valueName: "true|false", description: "Whether to consider the address as a proxy" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi proxy edit --profile <name> --id <id> --consider false", "vectra-axi proxy edit --help"],
  },
  "proxy delete": {
    description: "Delete a user-defined RUX proxy through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Proxy string ID (required)" },
      execute: { kind: "boolean", description: "Send the mutation; default preview only" },
      "dry-run": { kind: "boolean", description: "Preview without sending (default)" },
      confirm: { kind: "value", valueName: "target", description: "Exact preview target required with --execute" },
    },
    examples: ["vectra-axi proxy delete --profile <name> --id <id>", "vectra-axi proxy delete --help"],
  },
  "assignment outcome list": {
    description: "List QUX or RUX assignment outcomes with a bounded window",
    flags: {
      ...globals,
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,title,category,builtin" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi assignment outcome list --profile <name>",
      "vectra-axi assignment outcome list --profile <name> --fields id,title,category",
    ],
  },
  "assignment outcome create": {
    description: "Create a custom QUX or RUX assignment outcome through the gated write pipeline",
    flags: {
      ...globals,
      title: { kind: "value", valueName: "text", description: "Outcome title (required)" },
      category: { kind: "value", valueName: "category", description: "benign_true_positive, malicious_true_positive, false_positive or internal (required)" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot combine with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target from the preview, required to execute" },
    },
    examples: [
      "vectra-axi assignment outcome create --profile <name> --title \"Example outcome\" --category internal",
      "vectra-axi assignment outcome create --profile <name> --title \"Example outcome\" --category internal --execute --confirm 'new assignment outcome'",
    ],
  },
  "assignment outcome edit": {
    description: "Edit a custom QUX or RUX assignment outcome through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Custom outcome ID (positive integer, required)" },
      title: { kind: "value", valueName: "text", description: "Outcome title" },
      category: { kind: "value", valueName: "category", description: "benign_true_positive, malicious_true_positive, false_positive or internal" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot combine with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target from the preview, required to execute" },
    },
    examples: [
      "vectra-axi assignment outcome edit --profile <name> --id 5 --title \"Updated outcome\"",
      "vectra-axi assignment outcome edit --profile <name> --id 5 --title \"Updated outcome\" --execute --confirm 'assignment outcome 5'",
    ],
  },
  "assignment outcome delete": {
    description: "Delete a custom QUX or RUX assignment outcome through the gated write pipeline",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Custom outcome ID (positive integer, required)" },
      execute: { kind: "boolean", description: "Send the confirmed change; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot combine with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target from the preview, required to execute" },
    },
    examples: [
      "vectra-axi assignment outcome delete --profile <name> --id 5",
      "vectra-axi assignment outcome delete --profile <name> --id 5 --execute --confirm 'assignment outcome 5'",
    ],
  },
  "assignment outcome show": {
    description: "Show one QUX or RUX assignment outcome in full detail",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Outcome ID to show (positive integer, required)" },
    },
    examples: [
      "vectra-axi assignment outcome show --profile <name> --id 1",
    ],
  },
  "user list": {
    description: "List QUX or RUX users with a bounded window; username filtering is QUX-only",
    flags: {
      ...globals,
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      username: { kind: "value", valueName: "name", description: "Filter by server-side username (QUX-only; unsupported on RUX)" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,username on QUX or id,name on RUX" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi user list --profile <name>",
      "vectra-axi user list --profile <qux-profile> --username soc-analyst",
      "vectra-axi user list --profile <rux-profile> --fields id,name",
    ],
  },
  "user show": {
    description: "Show one QUX or RUX user in full detail",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "User ID to show (positive integer, required)" },
    },
    examples: [
      "vectra-axi user show --profile <name> --id 3",
    ],
  },
  "audit list": {
    // On QUX both dates are required ISO calendar days sent unchanged as
    // the inventory's start/end wire keys; the server applies them as an
    // inclusive UTC window. No limit/cursor exists: client-side truncation
    // of an oversized window is refused, so narrow the dates instead.
    // On RUX the same leaf reads the v3.4 audit checkpoint feed: --from
    // starts at a returned checkpoint, --limit is an output window only
    // (never the upstream batch limit), timestamp bounds pass through for
    // the server to apply inclusively, --start-date/--end-date expand to
    // whole-day timestamp bounds, and --cursor resumes a capped batch with
    // its original filters. remaining_count is reported as returned, never
    // as a stable total.
    description: "List QUX audits in a bounded inclusive UTC date window or RUX audit events from a checkpoint",
    flags: {
      ...globals,
      "start-date": { kind: "value", valueName: "date", description: "Window start as YYYY-MM-DD UTC, inclusive (required on QUX; whole-day convenience on RUX)" },
      "end-date": { kind: "value", valueName: "date", description: "Window end as YYYY-MM-DD UTC, inclusive (required on QUX; whole-day convenience on RUX)" },
      from: { kind: "value", valueName: "checkpoint", description: "Start from a returned checkpoint on a RUX profile; default reads the earliest batch" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read on a RUX profile; default 100" },
      "event-timestamp-gte": { kind: "value", valueName: "timestamp", description: "Filter by server-side minimum event timestamp on a RUX profile, applied inclusively" },
      "event-timestamp-lte": { kind: "value", valueName: "timestamp", description: "Filter by server-side maximum event timestamp on a RUX profile, applied inclusively" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped batch with its original filters on a RUX profile" },
    },
    examples: [
      "vectra-axi audit list --profile <name> --start-date 2026-10-01 --end-date 2026-10-02",
      "vectra-axi audit list --profile <name> --from <checkpoint> --limit 20",
      "vectra-axi audit list --profile <name> --cursor <cursor>",
    ],
  },
  "group list": {
    // Filter flags cover the inventory's qux.group.list query subset.
    // Type values pass through to the server with no client-side allowlist,
    // so host, account, IP, domain and release-dependent AD kinds survive.
    description: "List groups on QUX v2.5 or RUX v3.4 with server-side filters and a bounded window",
    flags: {
      ...globals,
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      name: { kind: "value", valueName: "name", description: "Filter by server-side group name" },
      type: { kind: "value", valueName: "kind", description: "Filter by server-side group kind; values pass through verbatim" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,name,type" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi group list --profile <name>",
      "vectra-axi group list --profile <name> --type host",
      "vectra-axi group list --profile <name> --cursor <cursor>",
    ],
  },
  "group show": {
    description: "Show one group on QUX v2.5 or RUX v3.4 in full detail",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Group ID to show (positive integer, required)" },
    },
    examples: [
      "vectra-axi group show --profile <name> --id 8",
    ],
  },
  "group create": {
    description: "Create a group on QUX or RUX under the explicit write policy",
    flags: {
      ...globals,
      name: { kind: "value", valueName: "name", description: "Group name, required" },
      description: { kind: "value", valueName: "text", description: "Group description, required" },
      importance: { kind: "value", valueName: "value", description: "high, medium, low or never_prioritize; required" },
      type: { kind: "value", valueName: "host|account|ip|domain", description: "Group kind, required" },
      members: { kind: "value", valueName: "list", description: "Comma-separated host IDs, account UIDs, IPs or domains; exactly one of members, regex or AD DN required" },
      regex: { kind: "value", valueName: "pattern", description: "Host/account membership regex; QUX requires release 9.0+" },
      "ad-group-dn": { kind: "value", valueName: "dn", description: "Host/account AD group distinguished name; QUX requires release 9.6+" },
      execute: { kind: "boolean", description: "Send the confirmed mutation; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact group target from preview, required to execute" },
    },
    examples: [
      "vectra-axi group create --profile <name> --type host --name Example --description Example --importance medium --members 7,9",
      "vectra-axi group create --profile <name> --type domain --name Example --description Example --importance medium --members example.invalid --execute --confirm 'new group'",
    ],
  },
  "group edit": {
    description: "Edit a group on QUX or RUX under the explicit write policy",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Group ID (positive integer, required)" },
      name: { kind: "value", valueName: "name", description: "Group name" },
      description: { kind: "value", valueName: "text", description: "Group description" },
      importance: { kind: "value", valueName: "value", description: "high, medium, low or never_prioritize" },
      execute: { kind: "boolean", description: "Send the confirmed mutation; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact group target from preview, required to execute" },
    },
    examples: [
      "vectra-axi group edit --profile <name> --id 8 --importance high",
      "vectra-axi group edit --profile <name> --id 8 --name Example --execute --confirm 'group 8'",
    ],
  },
  "group delete": {
    description: "Delete a group on QUX or RUX; deletion orphans triage rule references",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Group ID (positive integer, required)" },
      execute: { kind: "boolean", description: "Send the confirmed mutation; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact group target from preview, required to execute" },
    },
    examples: [
      "vectra-axi group delete --profile <name> --id 8",
      "vectra-axi group delete --profile <name> --id 8 --execute --confirm 'group 8'",
    ],
  },
  "group member add": {
    description: "Add to static group membership on QUX or RUX; groups drive triage rules and importance",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Group ID (positive integer, required)" },
      members: { kind: "value", valueName: "list", description: "Comma-separated host IDs, account UIDs, IPs or domains; exactly one member input required" },
      "members-file": { kind: "value", valueName: "path|-", description: "JSON array of members; - reads stdin; [] clears membership with set" },
      execute: { kind: "boolean", description: "Send the confirmed full replacement; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact group target from preview, required to execute" },
    },
    examples: [
      "vectra-axi group member add --profile <name> --id 8 --members 7,9",
      "vectra-axi group member add --profile <name> --id 8 --members-file members.json --execute --confirm 'group 8'",
    ],
  },
  "group member remove": {
    description: "Remove from static group membership on QUX or RUX; groups drive triage rules and importance",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Group ID (positive integer, required)" },
      members: { kind: "value", valueName: "list", description: "Comma-separated host IDs, account UIDs, IPs or domains; exactly one member input required" },
      "members-file": { kind: "value", valueName: "path|-", description: "JSON array of members; - reads stdin; [] clears membership with set" },
      execute: { kind: "boolean", description: "Send the confirmed full replacement; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact group target from preview, required to execute" },
    },
    examples: [
      "vectra-axi group member remove --profile <name> --id 8 --members 7,9",
      "vectra-axi group member remove --profile <name> --id 8 --members-file members.json --execute --confirm 'group 8'",
    ],
  },
  "group member set": {
    description: "Replace static group membership on QUX or RUX; groups drive triage rules and importance",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Group ID (positive integer, required)" },
      members: { kind: "value", valueName: "list", description: "Comma-separated host IDs, account UIDs, IPs or domains; exactly one member input required" },
      "members-file": { kind: "value", valueName: "path|-", description: "JSON array of members; - reads stdin; [] clears membership with set" },
      execute: { kind: "boolean", description: "Send the confirmed full replacement; default previews only" },
      "dry-run": { kind: "boolean", description: "Preview only; cannot be combined with --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact group target from preview, required to execute" },
    },
    examples: [
      "vectra-axi group member set --profile <name> --id 8 --members 7,9",
      "vectra-axi group member set --profile <name> --id 8 --members-file members.json --execute --confirm 'group 8'",
    ],
  },
  "group member list": {
    // Membership comes only from the dedicated paged member route, never
    // from embedded detail members capped at 2000 rows. The group ID is a
    // path parameter, so windows stay scoped to one group and kinds are
    // never merged into one ranking.
    description: "List one group's members on QUX v2.5 (appliance 9.2+) or RUX v3.4 through the paged member route",
    flags: {
      ...globals,
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      id: { kind: "value", valueName: "id", description: "Group ID whose members to list (positive integer, required)" },
      name: { kind: "value", valueName: "name", description: "Filter by server-side member name" },
      ordering: { kind: "value", valueName: "ordering", description: "Server-side result ordering" },
      "is-key-asset": { kind: "value", valueName: "bool", description: "Filter by server-side key-asset flag: true or false" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,name on QUX or id,name,uid,ip,domain on RUX" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi group member list --profile <name> --id 8",
      "vectra-axi group member list --profile <name> --id 8 --cursor <cursor>",
    ],
  },
  "triage rule list": {
    // Filter flags cover the inventory's qux.triage-rule.list query subset
    // minus the wire fields selector, which has no CLI flag: rows arrive
    // whole and the CLI projects its recorded subset client-side.
    description: "List triage rules on QUX v2.5 or RUX v3.4 with server-side filters and a bounded window",
    flags: {
      ...globals,
      all: { kind: "boolean", description: "Traverse pages within 10 requests, 8 MiB, 60 seconds and 10000 rows; cannot combine with --limit" },
      contains: { kind: "value", valueName: "text", description: "Filter by server-side rule text match" },
      ordering: { kind: "value", valueName: "ordering", description: "Server-side result ordering" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,enabled,triage_category" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi triage rule list --profile <name>",
      "vectra-axi triage rule list --profile <name> --contains synthetic",
    ],
  },
  "triage rule create": {
    description: "Create an org-wide QUX or RUX triage rule (high risk: suppresses future detections)",
    flags: {
      ...globals,
      "rule-file": { kind: "value", valueName: "path|-", description: "Full JSON rule: description, detection_category, triage_category, detection, is_whitelist, source_conditions, additional_conditions; trees are null or OR with one AND child and ANY_OF/NONE_OF leaves" },
      execute: { kind: "boolean", description: "Send the previewed mutation" },
      "dry-run": { kind: "boolean", description: "Preview only (default); excludes --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target: new triage rule" },
    },
    examples: [
      "vectra-axi triage rule create --profile <name> --rule-file rule.json",
      "vectra-axi triage rule create --profile <name> --rule-file - --execute --confirm 'new triage rule'",
    ],
  },
  "triage rule edit": {
    description: "Fully replace an org-wide QUX or RUX triage rule with a before/after preview (high risk)",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Rule ID (positive integer, required)" },
      "rule-file": { kind: "value", valueName: "path|-", description: "Complete replacement JSON, same schema as create; omitted fields are not merged; trees are null or OR with one AND child and ANY_OF/NONE_OF leaves" },
      execute: { kind: "boolean", description: "Send the previewed mutation" },
      "dry-run": { kind: "boolean", description: "Preview only (default); excludes --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target: triage rule <id>" },
    },
    examples: [
      "vectra-axi triage rule edit --profile <name> --id 7 --rule-file rule.json",
      "vectra-axi triage rule edit --profile <name> --id 7 --rule-file - --execute --confirm 'triage rule 7'",
    ],
  },
  "triage rule delete": {
    description: "Delete an org-wide QUX or RUX triage rule after previewing it (high risk)",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Rule ID (positive integer, required)" },
      execute: { kind: "boolean", description: "Send the previewed mutation" },
      "dry-run": { kind: "boolean", description: "Preview only (default); excludes --execute" },
      confirm: { kind: "value", valueName: "target", description: "Exact target: triage rule <id>" },
    },
    examples: [
      "vectra-axi triage rule delete --profile <name> --id 7",
      "vectra-axi triage rule delete --profile <name> --id 7 --execute --confirm 'triage rule 7'",
    ],
  },
  "triage rule show": {
    description: "Show one triage rule on QUX v2.5 or RUX v3.4 in full detail",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Rule ID to show (positive integer, required)" },
    },
    examples: [
      "vectra-axi triage rule show --profile <name> --id 7",
    ],
  },
  "health list": {
    // Snapshots carry the cached/fresh and VLAN options as boolean flags:
    // --fresh sends cache=false for a live check, otherwise the query omits
    // cache and the upstream cached default (with updated_at) applies;
    // --no-vlans sends vlans=false to omit VLAN detail.
    description: "Show the QUX or RUX health snapshot with cached or fresh semantics",
    flags: {
      ...globals,
      fresh: { kind: "boolean", description: "Request a fresh check (sends cache=false); default uses the cached snapshot" },
      "no-vlans": { kind: "boolean", description: "Omit VLAN detail (sends vlans=false); default includes it" },
    },
    examples: [
      "vectra-axi health list --profile <name>",
      "vectra-axi health list --profile <name> --fresh",
    ],
  },
  "health show": {
    description: "Show one QUX or RUX health check snapshot with cached or fresh semantics",
    flags: {
      ...globals,
      check: { kind: "value", valueName: "name", description: "Health check to show: cpu, disk, network, memory, power, sensors, system, hostid, connectivity or trafficdrop; external-connectors, external-connectors-details, edr, edr-details or network-brain-ping on a RUX profile only (required)" },
      fresh: { kind: "boolean", description: "Request a fresh check (sends cache=false); default uses the cached snapshot; rejected on RUX connector/EDR checks" },
      "no-vlans": { kind: "boolean", description: "Omit VLAN detail (sends vlans=false); default includes it; rejected on RUX connector/EDR checks" },
      "connector-type": { kind: "value", valueName: "type", description: "Filter by server-side connector type; --check external-connectors or external-connectors-details on a RUX profile only" },
      "edr-type": { kind: "value", valueName: "type", description: "Filter by server-side EDR type; --check edr or edr-details on a RUX profile only" },
      "data-type": { kind: "value", valueName: "type", description: "Filter by server-side data type; --check external-connectors or edr on a RUX profile only" },
      live: { kind: "boolean", description: "Request live connector/EDR data; --check external-connectors, external-connectors-details, edr or edr-details on a RUX profile only" },
    },
    examples: [
      "vectra-axi health show --profile <name> --check cpu",
      "vectra-axi health show --profile <name> --check connectivity --fresh",
    ],
  },
  "health event list": {
    // Checkpoint feed: --from starts at a returned checkpoint, --limit is an
    // output window only (never the upstream batch limit), and --cursor
    // resumes a capped batch with its original filters. remaining_count is
    // reported as returned, never as a stable total. QUX is release-gated to 9.4.
    description: "List QUX or RUX health events from a checkpoint with a bounded window",
    flags: {
      ...globals,
      from: { kind: "value", valueName: "checkpoint", description: "Start from a returned checkpoint; default reads the earliest batch" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      ordering: { kind: "value", valueName: "ordering", description: "Server-side result ordering" },
      status: { kind: "value", valueName: "status", description: "Filter by server-side health status" },
      "health-check-name": { kind: "value", valueName: "name", description: "Filter by server-side health check name" },
      "entity-type": { kind: "value", valueName: "type", description: "Filter by server-side entity type" },
      "entity-name": { kind: "value", valueName: "name", description: "Filter by server-side entity name" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped batch with its original filters" },
    },
    examples: [
      "vectra-axi health event list --profile <name>",
      "vectra-axi health event list --profile <name> --from <checkpoint> --limit 20",
      "vectra-axi health event list --profile <name> --cursor <cursor>",
    ],
  },

  "api get": {
    // API-01: reviewed raw read over the operation catalogue. --operation
    // names an allowlisted GET read by inventory ID; --path binds its route
    // template variables and --query passes only its recorded server-side
    // keys. The destination stays the configured profile's instance: there
    // is no URL argument, no custom header and no other method. Checkpoint
    // and date-window feeds, writes and sensitive routes are refused with
    // guidance to their named leaves or the block reason.
    description: "Read one allowlisted GET operation by inventory ID with its recorded query and field policy",
    flags: {
      ...globals,
      operation: { kind: "value", valueName: "id", description: "Reviewed operation ID to read, for example qux.detection.list (required)" },
      path: { kind: "value", valueName: "pairs", description: "Route template bindings as name=value pairs joined with &" },
      query: { kind: "value", valueName: "pairs", description: "Server-side filters as name=value pairs joined with &" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over the operation's recorded fields" },
      limit: { kind: "value", valueName: "rows", description: "Row window for collection reads; default 100" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped collection read with its original operation and filters" },
      full: { kind: "boolean", description: "Show complete long text; default previews truncated values" },
    },
    examples: [
      "vectra-axi api get --profile <name> --operation qux.detection.list --query state=active --limit 20",
      "vectra-axi api get --profile <name> --operation qux.detection.show --path id=42",
      "vectra-axi api get --profile <name> --operation rux.detection.list --fields id,state",
    ],
  },
  "lockdown list": {
    // The kind selects a QUX status route or the RUX type query; there is no
    // execution leaf, so no action flag exists to validate here.
    description: "List QUX host/account or RUX host/account/traffic lockdown status",
    flags: {
      ...globals,
      type: { kind: "value", valueName: "kind", description: "Lockdown status kind: host, account, or traffic on a RUX profile (required)" },
    },
    examples: [
      "vectra-axi lockdown list --profile <name> --type host",
      "vectra-axi lockdown list --profile <name> --type account",
    ],
  },
};

function flagSyntax(name: string, flag: Flag): string {
  return `--${name}${flag.kind === "value" ? ` <${flag.valueName}>` : ""}`;
}

function childCommands(path = ""): Record<string, string> {
  const prefix = path ? `${path} ` : "";
  return Object.fromEntries(Object.keys(catalogue)
    .filter((leaf) => leaf.startsWith(prefix))
    .map((leaf) => {
      const child = `${prefix}${leaf.slice(prefix.length).split(" ")[0]}`;
      return [child, catalogue[child]?.description ?? `Explore ${child} commands`];
    }));
}

// Describe only executable list routes; planned inventory routes confer no support.
export function listPaging(leaf: string): string | undefined {
  if (!leaf.endsWith(" list") || !catalogue[leaf]) return undefined;
  if (leaf === "profile list") return "Local configuration; no endpoint or --all";
  return [...new Set(inventory.operations
    .filter((operation) => operation.command === leaf && operation.disposition === "named")
    .map((operation) => `${operation.deployment.toUpperCase()}: ${
      operation.paging === "collection" ? "collection pages; bounded --all supported"
        : operation.paging === "none" ? "nonpaged single response; no --all"
          : operation.paging === "checkpoint" ? "checkpoint batch; --cursor/--from continuation, no --all"
            : "date window; narrow dates to bound the response, no --all"
    }`))].join("; ");
}

export function help(leaf?: string): Record<string, unknown> {
  const entry = leaf !== undefined && Object.hasOwn(catalogue, leaf) ? catalogue[leaf] : undefined;
  const children = childCommands(leaf);
  const group = leaf !== undefined && Object.keys(children).length > 0;
  return {
    ...(entry || group ? {
      command: `vectra-axi ${leaf}`,
      description: entry?.description ?? `Explore ${leaf} commands`,
      ...(group ? { commands: children } : {}),
      ...(listPaging(leaf!) ? { pagination: listPaging(leaf!) } : {}),
    } : {
      description: DESCRIPTION,
      commands: Object.fromEntries(Object.entries(catalogue).map(([name, entry]) => [name, entry.description])),
      version: "-v, -V, --version: Bare flag only; print version",
    }),
    ...(leaf === undefined || entry?.flags.cursor ? {
      completeness: "complete is true only when the matching result is exhausted without error and no cursor remains; for checkpoint feeds it covers the current batch, not future events. Bounded windows with a cursor set complete: false and exit 0; failed reads exit 1.",
    } : {}),
    flags: Object.fromEntries(Object.entries(entry?.flags ?? globals).map(([name, flag]) => [flagSyntax(name, flag), flag.description])),
    ...(entry?.flags.id ? { arguments: { "<id>": "Resource ID; use either a positional ID or --id, never both" } } : {}),
    combinations: exclusiveFlags.map(([left, right]) => `--${left} cannot be combined with --${right}`),
    examples: entry?.examples.map((example) => entry.flags.id ? example.replace(/ --id (\S+)/, " $1") : example) ?? (group
      ? Object.keys(children).slice(0, 3).map((child) => `vectra-axi ${child} --help`)
      : ["vectra-axi", "vectra-axi setup --help"]),
  };
}

export function parseInvocation(argv: readonly string[]): {
  leaf: string; flags: ReadonlyMap<string, string | boolean>; help: boolean; home: boolean;
} {
  const home = argv.length === 0 || argv[0]?.startsWith("-") === true;
  // Resolve the longest known leaf or group before validating flags.
  const pair = argv[0] !== undefined && argv[1] !== undefined && !argv[1].startsWith("-")
    ? `${argv[0]} ${argv[1]}` : undefined;
  const triple = pair !== undefined && argv[2] !== undefined && !argv[2].startsWith("-")
    ? `${pair} ${argv[2]}` : undefined;
  const leaf = home ? "home"
    : triple !== undefined && Object.hasOwn(catalogue, triple) ? triple
    : pair !== undefined && (Object.hasOwn(catalogue, pair) || Object.keys(childCommands(pair)).length) ? pair
    : argv[0]!;
  const entry = Object.hasOwn(catalogue, leaf) ? catalogue[leaf]! : undefined;
  const children = childCommands(leaf);
  const group = Object.keys(children).length > 0;
  const scope = entry || group ? leaf : undefined;
  const allowedFlags = entry?.flags ?? globals;
  const usage = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [
      entry ? `Valid flags for ${leaf}: ${Object.entries(entry.flags).map(([name, flag]) => flagSyntax(name, flag)).join(", ")}`
        : `Available commands: ${Object.keys(childCommands(scope)).join(", ")}`,
      `Run vectra-axi${scope ? ` ${scope}` : ""} --help`,
    ]);
  };
  const attempted = home ? "home"
    : triple !== undefined ? triple : pair !== undefined ? pair : argv[0]!;
  if (!entry && (!group || (triple ?? pair ?? leaf) !== leaf)) usage(`Unknown command: ${attempted}`);
  const flags = new Map<string, string | boolean>();
  const args = home ? argv : argv.slice(leaf.split(" ").length);
  let positionalId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-") && entry?.flags.id && positionalId === undefined) {
      positionalId = arg;
      continue;
    }
    if (!arg.startsWith("--")) usage(`Unexpected argument: ${arg}`);
    const [name, ...inline] = arg.slice(2).split("=");
    const flag = Object.hasOwn(allowedFlags, name!) ? allowedFlags[name!] : undefined;
    if (!flag) usage(`Unknown flag: ${arg}`);
    if (flags.has(name!)) usage(`Repeated flag: --${name}`);
    let value: string | boolean = true;
    if (flag!.kind === "boolean") {
      if (inline.length) usage(`--${name} does not accept a value`);
    } else {
      const next = inline.length ? inline.join("=") : args[++index];
      if (!next?.trim() || (!inline.length && next.startsWith("-") && !((name === "tags-file" || name === "note-file" || name === "ids-file" || name === "rule-file" || name === "members-file" || name === "config-file") && next === "-"))) usage(`--${name} requires a non-empty value`);
      value = next!;
    }
    flags.set(name!, value);
  }
  if (positionalId !== undefined) {
    if (flags.has("id")) usage("Positional id cannot be combined with --id");
    flags.set("id", positionalId);
  }
  for (const [left, right] of exclusiveFlags) {
    if (flags.has(left) && flags.has(right)) usage(`--${left} cannot be combined with --${right}`);
  }
  if (!entry && !flags.has("help")) usage(`Unknown command: ${leaf}`);
  return { leaf, flags, help: flags.has("help"), home };
}
