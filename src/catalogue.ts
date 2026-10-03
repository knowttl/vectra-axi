import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { inventorySchema } from "./inventory/schema.js";

export const DESCRIPTION = "Inspect Vectra investigations through reviewed read-only commands";

// Inventory evidence never enables a runtime leaf. Endpoint slices bind IDs explicitly.
export const inventory = inventorySchema.parse(JSON.parse(readFileSync(
  new URL("../../inventory/capabilities.json", import.meta.url), "utf8",
)));

type Flag = { kind: "boolean" | "value"; description: string };
const globals: Readonly<Record<string, Flag>> = {
  help: { kind: "boolean", description: "Show concise help; default false" },
  profile: { kind: "value", description: "Select a profile by name; none configured in CLI-01" },
};

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
};

export function help(leaf?: string): Record<string, unknown> {
  const entry = leaf === undefined ? undefined : catalogue[leaf];
  return entry ? {
    command: `vectra-axi ${leaf}`,
    description: entry.description,
    flags: Object.fromEntries(Object.entries(entry.flags).map(([name, flag]) => [`--${name}`, flag.description])),
    examples: entry.examples,
  } : {
    description: DESCRIPTION,
    commands: Object.fromEntries(Object.entries(catalogue).map(([name, entry]) => [name, entry.description])),
    flags: { "--help": "Show help", "-v, -V, --version": "Bare flag only; print version" },
    examples: ["vectra-axi", "vectra-axi setup --help"],
  };
}

export function parseInvocation(argv: readonly string[]): {
  leaf: string; flags: ReadonlyMap<string, string | boolean>; help: boolean; home: boolean;
} {
  const home = argv.length === 0 || argv[0]?.startsWith("-") === true;
  const leaf = home ? "home" : argv[0]!;
  const entry = Object.hasOwn(catalogue, leaf) ? catalogue[leaf]! : undefined;
  const usage = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [
      entry ? `Valid flags for ${leaf}: ${Object.keys(entry.flags).map((name) => `--${name}`).join(", ")}`
        : `Available commands: ${Object.keys(catalogue).join(", ")}`,
      `Run vectra-axi${entry ? ` ${leaf}` : ""} --help`,
    ]);
  };
  if (!entry) usage(`Unknown command: ${leaf}`);
  const flags = new Map<string, string | boolean>();
  const args = home ? argv : argv.slice(1);
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
  if (flags.has("help") && flags.size > 1) usage("--help cannot be combined with --profile");
  return { leaf, flags, help: flags.has("help"), home };
}
