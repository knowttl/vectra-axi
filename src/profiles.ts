import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { SecretRedactor } from "./redact.js";

const nonempty = z.string().trim().min(1);
const profileName = z.string().min(1).refine((value) => value === value.trim());
const originField = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && value === url.origin && !url.username && !url.password;
  } catch { return false; }
});
// WRITE-00 hand-edited opt-in: absent means forced read-only. When present
// the scope allowlist is always explicit; the coordinator snapshots it at
// creation, so read flags, environment overrides and later raw reads cannot
// widen it. No mutation family is enabled by this record alone.
const writePolicy = z.strictObject({
  allowWrites: z.boolean(),
  operations: z.array(nonempty).min(1),
}).optional();
const quxFields = {
  kind: z.literal("qux"),
  origin: originField,
  apiVersion: z.literal("2.5"),
  applianceRelease: nonempty.optional(),
  caBundle: nonempty.optional(),
  writes: writePolicy,
};
// RUX-01: cloud profiles use OAuth only (no personal-token mode), pin API
// v3.4 and carry no appliance release; the cloud has no release gate.
const ruxFields = {
  kind: z.literal("rux"),
  origin: originField,
  apiVersion: z.literal("3.4"),
  caBundle: nonempty.optional(),
  // The write policy shape is shared so the coordinator compiles against
  // every generation; on RUX only the named note edit/delete operations
  // pass the coordinator scope, since no other cloud mutation family ships.
  writes: writePolicy,
};
const envReference = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const clientId = z.string().min(1).refine((value) => value === value.trim() && !/[:\s]/.test(value));
// A plain union: qux and rux OAuth variants share the auth discriminator,
// so a discriminated union cannot tell them apart.
const profileSchema = z.union([
  z.strictObject({ ...quxFields, auth: z.literal("token"), tokenEnv: envReference }),
  z.strictObject({ ...quxFields, auth: z.literal("oauth"), clientId, secretEnv: envReference }),
  z.strictObject({ ...ruxFields, auth: z.literal("oauth"), clientId, secretEnv: envReference }),
]);
const configSchema = z.strictObject({
  defaultProfile: profileName.optional(),
  profiles: z.record(profileName, profileSchema),
}).refine((config) => config.defaultProfile === undefined || Object.hasOwn(config.profiles, config.defaultProfile));

export type Profile = z.infer<typeof profileSchema>;
export type Config = z.infer<typeof configSchema>;
export type LoadedConfig = { path: string; config: Config };
export type SelectedProfile = Profile & {
  name: string;
  source: "flag" | "env" | "config-default" | "sole";
};

export function loadConfig(explicit?: string, redactor?: SecretRedactor): LoadedConfig {
  const selected = explicit ?? process.env.VECTRA_AXI_CONFIG;
  const path = selected === undefined ? join(homedir(), ".vectra-axi", "config.json") : resolve(selected);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (selected === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, config: { profiles: {} } };
    }
    throw new AxiError("Cannot read profile configuration as JSON", "CONFIG_INVALID", [
      "Check the selected config file's path, permissions and JSON syntax", "Run vectra-axi setup --help",
    ]);
  }
  // Register references before validation: even an invalid profile must not leak its known secret.
  if (raw && typeof raw === "object" && "profiles" in raw && raw.profiles && typeof raw.profiles === "object") {
    for (const profile of Object.values(raw.profiles)) {
      if (profile && typeof profile === "object") {
        for (const field of ["tokenEnv", "secretEnv"] as const) {
          if (field in profile && typeof profile[field] === "string") redactor?.add(process.env[profile[field]]);
        }
      }
    }
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AxiError("Invalid profile configuration", "CONFIG_INVALID", [
      "Use kind qux with apiVersion 2.5, or kind rux with apiVersion 3.4 and auth oauth; QUX auth token requires tokenEnv, OAuth requires clientId and secretEnv",
      "Remove mixed OAuth/token fields, inline secrets, UI-login fields and TLS bypass settings; RUX has no token mode or appliance release",
      "Check defaultProfile names an existing profile; run vectra-axi setup --help",
    ]);
  }
  return { path, config: parsed.data };
}

export function selectProfile(config: Config, flag?: string): SelectedProfile {
  const names = Object.keys(config.profiles);
  const env = process.env.VECTRA_AXI_PROFILE;
  const name = flag ?? env ?? config.defaultProfile ?? (names.length === 1 ? names[0] : undefined);
  if (names.length === 0 || name === undefined) {
    throw new AxiError(names.length ? "Several profiles are configured and none is selected" : "No profiles are configured",
      names.length ? "PROFILE_AMBIGUOUS" : "PROFILE_REQUIRED", [
        "Run vectra-axi setup", "Pass --profile <name>, set VECTRA_AXI_PROFILE or configure defaultProfile",
      ]);
  }
  if (!Object.hasOwn(config.profiles, name)) {
    throw new AxiError("Selected profile is not configured", "PROFILE_NOT_FOUND", [
      "Check --profile, VECTRA_AXI_PROFILE and defaultProfile; run vectra-axi setup",
    ]);
  }
  return { ...config.profiles[name]!, name,
    source: flag !== undefined ? "flag" : env !== undefined ? "env" : config.defaultProfile !== undefined ? "config-default" : "sole" };
}
