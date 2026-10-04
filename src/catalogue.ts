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
    // query subset carries no min/max ID and its fields carry no state.
    description: "List QUX entities of one kind with server-side filters and a bounded window",
    flags: {
      ...globals,
      type: { kind: "value", valueName: "kind", description: "Entity kind to list: host or account (required)" },
      "threat-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum threat score" },
      "certainty-gte": { kind: "value", valueName: "score", description: "Filter by server-side minimum certainty score" },
      tags: { kind: "value", valueName: "tags", description: "Filter by server-side tags" },
      limit: { kind: "value", valueName: "rows", description: "Row window for this read; default 100" },
      fields: { kind: "value", valueName: "list", description: "Comma-separated projection over id,name,threat,certainty" },
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
  // Two-word leaves (`detection list`, `host show`, `entity list`, ...) resolve
  // from the first two tokens when the pair names a catalogue entry;
  // single-word leaves resolve from the first alone.
  const pair = argv[0] !== undefined && argv[1] !== undefined && !argv[1].startsWith("-")
    ? `${argv[0]} ${argv[1]}` : undefined;
  const leaf = home ? "home"
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
    : pair !== undefined ? pair : argv[0]!;
  if (!entry) usage(`Unknown command: ${attempted}`);
  const flags = new Map<string, string | boolean>();
  const args = home ? argv : argv.slice(leaf.includes(" ") ? 2 : 1);
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
      if (!next?.trim() || (!inline.length && next.startsWith("-"))) usage(`--${name} requires a non-empty value`);
      value = next!;
    }
    flags.set(name!, value);
  }
  for (const [left, right] of exclusiveFlags) {
    if (flags.has(left) && flags.has(right)) usage(`--${left} cannot be combined with --${right}`);
  }
  return { leaf, flags, help: flags.has("help"), home };
}
