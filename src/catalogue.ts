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
  // Two-word leaves (`detection list`, `detection show`) resolve from the
  // first two tokens; single-word leaves resolve from the first alone.
  const leaf = home ? "home"
    : argv[0] === "detection" && (argv[1] === "list" || argv[1] === "show") ? `detection ${argv[1]}`
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
    : argv[0] === "detection" && argv[1] !== undefined ? `detection ${argv[1]}` : argv[0]!;
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
      if (!next?.trim() || next.startsWith("-")) usage(`--${name} requires a non-empty value`);
      value = next!;
    }
    flags.set(name!, value);
  }
  for (const [left, right] of exclusiveFlags) {
    if (flags.has(left) && flags.has(right)) usage(`--${left} cannot be combined with --${right}`);
  }
  return { leaf, flags, help: flags.has("help"), home };
}
