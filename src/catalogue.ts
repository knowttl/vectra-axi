import { existsSync, readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { inventorySchema } from "./inventory/schema.js";

export const DESCRIPTION = "Inspect Vectra investigations through reviewed read-only commands";

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
  config: { kind: "value", valueName: "path", description: "Read an explicit config; default VECTRA_AXI_CONFIG or ~/.vectra-axi/config.json" },
};
const exclusiveFlags = [["help", "profile"]] as const;

export const catalogue: Readonly<Record<string, {
  description: string;
  flags: Readonly<Record<string, Flag>>;
  examples: readonly string[];
}>> = {
  home: {
    description: "Show local setup state; also the no-arguments view",
    flags: globals,
    examples: ["vectra-axi", "vectra-axi home", "vectra-axi home --profile <name>"],
  },
  setup: {
    description: "Show setup availability without installing or changing configuration",
    flags: globals,
    examples: ["vectra-axi setup", "vectra-axi setup --help"],
  },
  doctor: {
    // See README.md#release for generation-specific checks and safety
    // constraints; src/doctor.ts implements the leaf: one bounded detection
    // read per QUX profile, the named OAuth exchange alone per RUX profile.
    description: "Check profile configuration with one bounded detection read per QUX profile or OAuth exchange per RUX profile",
    flags: globals,
    examples: [
      "vectra-axi doctor",
      "vectra-axi doctor --profile <name>",
    ],
  },
  "detection list": {
    // Filter flags cover the inventory's conservative qux.detection.list
    // query subset. Kebab-case names map to snake_case keys in
    // src/detections.ts; values pass through to the server.
    description: "List QUX detections with server-side filters and a bounded window",
    flags: {
      ...globals,
      state: { kind: "value", valueName: "state", description: "Filter by server-side detection state" },
      "detection-type": { kind: "value", valueName: "type", description: "Filter by server-side detection type" },
      "detection-category": { kind: "value", valueName: "category", description: "Filter by server-side detection category" },
      "host-id": { kind: "value", valueName: "id", description: "Filter by server-side host ID (non-negative integer)" },
      tags: { kind: "value", valueName: "tags", description: "Filter by server-side tags" },
      "certainty-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum certainty" },
      "threat-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum threat" },
      ordering: { kind: "value", valueName: "ordering", description: "Server-side result ordering" },
      "min-id": { kind: "value", valueName: "id", description: "Server-side minimum detection ID (non-negative integer)" },
      "max-id": { kind: "value", valueName: "id", description: "Server-side maximum detection ID (non-negative integer)" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,detection_type,state,threat,certainty" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi detection list --profile <name> --state active --limit 100",
      "vectra-axi detection list --profile <name> --threat-gte 70 --fields id,state,threat",
      "vectra-axi detection list --profile <name> --cursor <cursor>",
    ],
  },
  "detection show": {
    description: "Show one QUX detection in full detail",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID to show (positive integer, required)" },
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
    description: "List QUX hosts with server-side filters and a bounded window",
    flags: {
      ...globals,
      "threat-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum threat score" },
      "certainty-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum certainty score" },
      tags: { kind: "value", valueName: "tags", description: "Filter by server-side tags" },
      "min-id": { kind: "value", valueName: "id", description: "Server-side minimum host ID (non-negative integer)" },
      "max-id": { kind: "value", valueName: "id", description: "Server-side maximum host ID (non-negative integer)" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,name,state,threat,certainty" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi host list --profile <name> --threat-gte 70",
      "vectra-axi host list --profile <name> --fields id,name,threat",
      "vectra-axi host list --profile <name> --cursor <cursor>",
    ],
  },
  "host show": {
    description: "Show one QUX host in full detail",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID to show (positive integer, required)" },
    },
    examples: [
      "vectra-axi host show --profile <name> --id 19",
    ],
  },
  "account list": {
    // Same conservative query subset as hosts, per the qux.account.list record.
    description: "List QUX accounts with server-side filters and a bounded window",
    flags: {
      ...globals,
      "threat-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum threat score" },
      "certainty-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum certainty score" },
      tags: { kind: "value", valueName: "tags", description: "Filter by server-side tags" },
      "min-id": { kind: "value", valueName: "id", description: "Server-side minimum account ID (non-negative integer)" },
      "max-id": { kind: "value", valueName: "id", description: "Server-side maximum account ID (non-negative integer)" },
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
    description: "Show one QUX account in full detail",
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
    description: "List QUX entities of one kind with server-side filters and a bounded window",
    flags: {
      ...globals,
      type: { kind: "value", valueName: "kind", description: "Entity kind to list: host or account (required)" },
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
    description: "Show one QUX entity of one kind in full detail",
    flags: {
      ...globals,
      type: { kind: "value", valueName: "kind", description: "Entity kind to show: host or account (required)" },
      id: { kind: "value", valueName: "id", description: "Entity ID to show (positive integer, required)" },
    },
    examples: [
      "vectra-axi entity show --profile <name> --type host --id 19",
    ],
  },
  "detection note list": {
    // Notes come only from the dedicated versioned notes resource, never
    // from the embedded detail summary. --full prints the complete returned
    // text; it cannot restore content the upstream response never returned.
    description: "List full QUX detection notes through the versioned notes route",
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
    description: "List QUX detection tags through the versioned tagging route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Detection ID whose tags to list (positive integer, required)" },
    },
    examples: [
      "vectra-axi detection tag list --profile <name> --id 42",
    ],
  },
  "detection tag set": {
    description: "Replace QUX detection tags with the exact desired set through the gated write pipeline",
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
  "detection note add": {
    description: "Append one QUX detection note through the gated write pipeline",
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
  "host note list": {
    description: "List full QUX host notes through the versioned notes route",
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
    description: "List QUX host tags through the versioned tagging route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Host ID whose tags to list (positive integer, required)" },
    },
    examples: [
      "vectra-axi host tag list --profile <name> --id 19",
    ],
  },
  "host tag set": {
    description: "Replace QUX host tags with the exact desired set through the gated write pipeline",
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
  "host note add": {
    description: "Append one QUX host note through the gated write pipeline",
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
  "account note list": {
    description: "List full QUX account notes through the versioned notes route",
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
    description: "List QUX account tags through the versioned tagging route",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Account ID whose tags to list (positive integer, required)" },
    },
    examples: [
      "vectra-axi account tag list --profile <name> --id 19",
    ],
  },
  "account tag set": {
    description: "Replace QUX account tags with the exact desired set through the gated write pipeline",
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
  "account note add": {
    description: "Append one QUX account note through the gated write pipeline",
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
  "assignment list": {
    // Filter flags cover both generations' assignment.list query subset.
    // Singular CLI names map to the plural wire keys in src/assignments.ts;
    // values pass through to the server. Assignments and outcomes are
    // distinct resources: rows carry the target host/account ID and a
    // CLI-derived unresolved/resolved status, never a merged outcome.
    description: "List QUX or RUX assignments with server-side filters and a bounded window",
    flags: {
      ...globals,
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
    // a separate operation with no leaf.
    description: "Set a QUX host or account assignment to an exact user through the gated write pipeline",
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
  "assignment outcome list": {
    description: "List QUX or RUX assignment outcomes with a bounded window",
    flags: {
      ...globals,
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,title,category,builtin" },
      cursor: { kind: "value", valueName: "cursor", description: "Resume a capped list with its original filters" },
    },
    examples: [
      "vectra-axi assignment outcome list --profile <name>",
      "vectra-axi assignment outcome list --profile <name> --fields id,title,category",
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
    // Both dates are required ISO calendar days sent unchanged as the
    // inventory's start/end wire keys; the server applies them as an
    // inclusive UTC window. No limit/cursor exists: client-side truncation
    // of an oversized window is refused, so narrow the dates instead.
    description: "List QUX audits in a bounded inclusive UTC date window",
    flags: {
      ...globals,
      "start-date": { kind: "value", valueName: "date", description: "Window start as YYYY-MM-DD UTC, inclusive (required)" },
      "end-date": { kind: "value", valueName: "date", description: "Window end as YYYY-MM-DD UTC, inclusive (required)" },
    },
    examples: [
      "vectra-axi audit list --profile <name> --start-date 2026-10-01 --end-date 2026-10-02",
    ],
  },
  "group list": {
    // Filter flags cover the inventory's qux.group.list query subset.
    // Type values pass through to the server with no client-side allowlist,
    // so host, account, IP, domain and release-dependent AD kinds survive.
    description: "List QUX groups with server-side filters and a bounded window",
    flags: {
      ...globals,
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
    description: "Show one QUX group in full detail",
    flags: {
      ...globals,
      id: { kind: "value", valueName: "id", description: "Group ID to show (positive integer, required)" },
    },
    examples: [
      "vectra-axi group show --profile <name> --id 8",
    ],
  },
  "group member list": {
    // Membership comes only from the dedicated paged member route, never
    // from embedded detail members capped at 2000 rows. The group ID is a
    // path parameter, so windows stay scoped to one group and kinds are
    // never merged into one ranking.
    description: "List one QUX group's members through the paged member route",
    flags: {
      ...globals,
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
    description: "List QUX triage rules with server-side filters and a bounded window",
    flags: {
      ...globals,
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
  "triage rule show": {
    description: "Show one QUX triage rule in full detail",
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

export function help(leaf?: string): Record<string, unknown> {
  const entry = leaf === undefined ? undefined : catalogue[leaf];
  return {
    ...(entry ? {
      command: `vectra-axi ${leaf}`,
      description: entry.description,
    } : {
      description: DESCRIPTION,
      commands: Object.fromEntries(Object.entries(catalogue).map(([name, entry]) => [name, entry.description])),
      version: "-v, -V, --version: Bare flag only; print version",
    }),
    flags: Object.fromEntries(Object.entries(entry?.flags ?? globals).map(([name, flag]) => [flagSyntax(name, flag), flag.description])),
    combinations: exclusiveFlags.map(([left, right]) => `--${left} cannot be combined with --${right}`),
    examples: entry?.examples ?? ["vectra-axi", "vectra-axi setup --help"],
  };
}

export function parseInvocation(argv: readonly string[]): {
  leaf: string; flags: ReadonlyMap<string, string | boolean>; help: boolean; home: boolean;
} {
  const home = argv.length === 0 || argv[0]?.startsWith("-") === true;
  // Three-word leaves (`detection note list`, `host tag list`, ...) resolve
  // from the first three tokens when the triple names a catalogue entry;
  // two-word leaves resolve from the first two, single-word from the first.
  const pair = argv[0] !== undefined && argv[1] !== undefined && !argv[1].startsWith("-")
    ? `${argv[0]} ${argv[1]}` : undefined;
  const triple = pair !== undefined && argv[2] !== undefined && !argv[2].startsWith("-")
    ? `${pair} ${argv[2]}` : undefined;
  const leaf = home ? "home"
    : triple !== undefined && Object.hasOwn(catalogue, triple) ? triple
    : pair !== undefined && Object.hasOwn(catalogue, pair) ? pair
    : argv[0]!;
  const entry = Object.hasOwn(catalogue, leaf) ? catalogue[leaf]! : undefined;
  const usage = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [
      entry ? `Valid flags for ${leaf}: ${Object.entries(entry.flags).map(([name, flag]) => flagSyntax(name, flag)).join(", ")}`
        : `Available commands: ${Object.keys(catalogue).join(", ")}`,
      `Run vectra-axi${entry ? ` ${leaf}` : ""} --help`,
    ]);
  };
  const attempted = home ? "home"
    : triple !== undefined ? triple : pair !== undefined ? pair : argv[0]!;
  if (!entry) usage(`Unknown command: ${attempted}`);
  const flags = new Map<string, string | boolean>();
  const args = home ? argv : argv.slice(leaf.split(" ").length);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) usage(`Unexpected argument: ${arg}`);
    const [name, ...inline] = arg.slice(2).split("=");
    const flag = Object.hasOwn(entry!.flags, name!) ? entry!.flags[name!] : undefined;
    if (!flag) usage(`Unknown flag: ${arg}`);
    if (flags.has(name!)) usage(`Repeated flag: --${name}`);
    let value: string | boolean = true;
    if (flag!.kind === "boolean") {
      if (inline.length) usage(`--${name} does not accept a value`);
    } else {
      const next = inline.length ? inline.join("=") : args[++index];
      if (!next?.trim() || (!inline.length && next.startsWith("-") && !((name === "tags-file" || name === "note-file") && next === "-"))) usage(`--${name} requires a non-empty value`);
      value = next!;
    }
    flags.set(name!, value);
  }
  for (const [left, right] of exclusiveFlags) {
    if (flags.has(left) && flags.has(right)) usage(`--${left} cannot be combined with --${right}`);
  }
  return { leaf, flags, help: flags.has("help"), home };
}
