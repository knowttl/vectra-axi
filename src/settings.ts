import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { LeafResult } from "./notes.js";
import type { Session } from "./session.js";
import { resourceDigest } from "./session.js";
import { redactExportSettings, containsRedactedPlaceholder } from "./redact.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

const warning = "High risk: changes what is monitored or dropped across the appliance.";
const target = "internal network";
const path = "/api/v2.5/settings/internal_network";

function cidr(value: string): string | undefined {
  const parts = value.split("/");
  const address = parts[0]!;
  const version = isIP(address);
  if (parts.length !== 2 || !version || address.includes("%") || !/^\d+$/.test(parts[1]!)) return undefined;
  const prefix = Number(parts[1]);
  const bits = version === 4 ? 32 : 128;
  if (prefix > bits) return undefined;
  const normalized = version === 4 ? address : new URL(`http://[${address}]/`).hostname.slice(1, -1);
  let number: bigint;
  if (version === 4) number = normalized.split(".").reduce((n, octet) => (n << 8n) + BigInt(octet), 0n);
  else {
    const [left, right] = normalized.split("::");
    const start = left ? left.split(":") : [];
    const end = right ? right.split(":") : [];
    const groups = right === undefined ? start : [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end];
    number = groups.reduce((n, group) => (n << 16n) + BigInt(`0x${group}`), 0n);
  }
  if ((number & ((1n << BigInt(bits - prefix)) - 1n)) !== 0n) return undefined;
  return `${normalized}/${prefix}`;
}

const subnets = z.array(z.string()).transform((values, ctx) => {
  const normalized = values.map(cidr);
  if (normalized.some((value) => value === undefined)) {
    ctx.addIssue({ code: "custom", message: "Expected network CIDRs without host bits" });
    return z.NEVER;
  }
  return [...new Set(normalized as string[])].sort();
});
const networkSchema = z.object({ included_subnets: subnets, excluded_subnets: subnets, dropped_subnets: subnets });
type Network = { include: string[]; exclude: string[]; drop: string[] };

function requireQux(session: Session): void {
  if (session.profile.kind !== "qux") throw new AxiError("Internal-network settings are unsupported on RUX", "UNSUPPORTED_OPERATION", [
    "Select a QUX profile for `vectra-axi setting internal-network show` or `set`",
  ]);
}

async function readNetwork(session: Session): Promise<Network> {
  const { body } = await session.request("qux.setting.internal-network.show", {});
  const parsed = networkSchema.safeParse(body);
  if (!parsed.success) throw new AxiError("Cannot determine internal-network settings", "MALFORMED_RESPONSE", [
    "Read the internal-network settings before retrying",
  ]);
  return { include: parsed.data.included_subnets, exclude: parsed.data.excluded_subnets, drop: parsed.data.dropped_subnets };
}

export async function runInternalNetworkRead(session: Session): Promise<LeafResult> {
  requireQux(session);
  return { failed: false, output: { profile: session.profile.name, ...await readNetwork(session) } };
}

export async function runInternalNetworkSet(
  session: Session, coordinator: MutationCoordinator, flags: ReadonlyMap<string, string | boolean>,
): Promise<LeafResult> {
  requireQux(session);
  const desired = {} as Network;
  for (const name of ["include", "exclude", "drop"] as const) {
    const raw = flags.get(name);
    const parsed = typeof raw === "string" ? subnets.safeParse(raw === "none" ? [] : raw.split(",").map((value) => value.trim())) : undefined;
    if (!parsed?.success) throw new AxiError(`--${name} requires comma-separated network CIDRs or 'none' to clear the list`, "VALIDATION_ERROR", [
      "Run `vectra-axi setting internal-network set --help`",
    ]);
    desired[name] = parsed.data;
  }
  const definition: MutationDefinition = {
    operation: "qux.setting.internal-network.set", method: "POST", path,
    effect: "write", requiresConfirmation: true, target, payload: desired,
  };
  coordinator.preview(definition);
  let before: Network | undefined;
  const readState = async () => {
    const fresh = await readNetwork(session);
    if (before && JSON.stringify(before) !== JSON.stringify(fresh)) throw new AxiError(
      "Internal-network settings changed since preview", "VERSION_CONFLICT", ["Preview the settings again before executing"],
    );
    before = fresh;
    return fresh;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState, isNoop: (state) => JSON.stringify(state) === JSON.stringify(desired),
  });
  const common = { profile: session.profile.name, operation: definition.operation, target, warning };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, before, after: desired,
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to replace all three lists`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, after: desired, audit: result.auditId } };
  return { failed: true, output: {
    ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Internal-network change rejected with status ${result.status}` : result.guidance,
    help: [`Read back with \`vectra-axi setting internal-network show --profile ${session.profile.name}\` before doing anything else; never replay an unknown outcome`],
  } };
}

export async function runExportSettingSet(
  session: Session, coordinator: MutationCoordinator, flags: ReadonlyMap<string, string | boolean>,
  kind: "syslog" | "kafka", readStdin: () => string = () => readFileSync(0, "utf8"),
): Promise<LeafResult> {
  if (session.profile.kind !== "qux") throw new AxiError(
    "Syslog and Kafka export settings are unsupported on RUX", "UNSUPPORTED_OPERATION",
    ["Select a QUX profile"],
  );
  const file = flags.get("config-file");
  let desired: unknown;
  try {
    if (typeof file !== "string" || !file.trim()) throw new Error();
    desired = JSON.parse(file === "-" ? readStdin() : readFileSync(file, "utf8"));
  } catch {
    throw new AxiError("--config-file <path|-> must contain a full JSON object", "VALIDATION_ERROR");
  }
  const document = z.record(z.string(), z.unknown());
  if (!document.safeParse(desired).success) throw new AxiError(
    "--config-file must contain a full JSON object", "VALIDATION_ERROR",
  );
  if (containsRedactedPlaceholder(desired)) throw new AxiError(
    "--config-file must not contain ***redacted*** placeholders", "VALIDATION_ERROR", [
      "Restore real secrets from your vault instead of copying preview output",
      "Start from the complete preview structure, never the projected api-get subset",
    ],
  );
  const target = `${kind} export`;
  const definition: MutationDefinition = {
    operation: `qux.setting.${kind}.set`, method: "POST", path: `/api/v2.5/settings/${kind}_config`,
    effect: "disruptive", requiresConfirmation: true, target, payload: desired,
  };
  coordinator.preview(definition);
  let before: unknown;
  let beforeDigest: string | undefined;
  const readState = async () => {
    const fresh = await session.request(`qux.setting.${kind}.show`, {});
    if (!document.safeParse(fresh.body).success || !fresh.bodyDigest) throw new AxiError(
      "Cannot determine export settings", "MALFORMED_RESPONSE", ["Read the settings before retrying"],
    );
    if (beforeDigest && beforeDigest !== fresh.bodyDigest) throw new AxiError(
      "Export settings changed since preview", "VERSION_CONFLICT", ["Preview the settings again before executing"],
    );
    before = fresh.body;
    beforeDigest = fresh.bodyDigest;
    return fresh.bodyDigest;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"),
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
    readState, isNoop: (digest) => digest === resourceDigest(desired),
  });
  const common = { profile: session.profile.name, operation: definition.operation, target,
    warning: "Disruptive: redirects detection export (data egress) across the appliance." };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, before, after: redactExportSettings(desired),
    ...(result.preview.noop ? { state: "already in desired state (no-op)" }
      : { help: [`Re-run with --execute --confirm '${target}' to replace the full document`] }),
  } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "already in desired state (no-op)" } };
  if (result.kind === "success") return { failed: false, output: { ...common, audit: result.auditId } };
  return { failed: true, output: {
    ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Export settings rejected with status ${result.status}` : result.guidance,
    help: ["Read the export settings before doing anything else; never replay an unknown outcome"],
  } };
}
