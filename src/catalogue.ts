import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { inventorySchema } from "./inventory/schema.js";

export const DESCRIPTION = "Inspect Vectra investigations through reviewed read-only commands";

// Inventory evidence never enables a runtime leaf. Endpoint slices bind IDs explicitly.
export const inventory = inventorySchema.parse(JSON.parse(readFileSync(
  new URL("../../inventory/capabilities.json", import.meta.url), "utf8",
)));

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
  const leaf = home ? "home" : argv[0]!;
  const entry = Object.hasOwn(catalogue, leaf) ? catalogue[leaf]! : undefined;
  const usage = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [
      entry ? `Valid flags for ${leaf}: ${Object.entries(entry.flags).map(([name, flag]) => flagSyntax(name, flag)).join(", ")}`
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
  for (const [left, right] of exclusiveFlags) {
    if (flags.has(left) && flags.has(right)) usage(`--${left} cannot be combined with --${right}`);
  }
  return { leaf, flags, help: flags.has("help"), home };
}
