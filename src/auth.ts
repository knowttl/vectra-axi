import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { rootCertificates } from "node:tls";
import { AxiError } from "axi-sdk-js";
import { secretReference, type LoadedConfig, type SelectedProfile } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";
import { privateFiles } from "./private-file.js";

export function resolveSecret(profile: SelectedProfile, redactor: SecretRedactor, verifyAcl = false): string {
  const ref = secretReference(profile);
  let secret: string | undefined;
  if ("env" in ref) secret = process.env[ref.env];
  else if ("file" in ref) {
    try { secret = privateFiles().read(ref.file, true, verifyAcl).replace(/^\uFEFF/, "").trimEnd(); }
    catch (error) {
      if (error instanceof AxiError) throw error;
      throw new AxiError(`Cannot read secret file: ${ref.file}`, "AUTH_REQUIRED", ["Provide a readable private secret file"]);
    }
  }
  redactor.add(secret);
  if (!secret?.trim()) throw new AxiError("The profile's secret reference is unset or empty", "AUTH_REQUIRED", ["Provide the token or clientSecret through its SecretRef; vectra-axi does not store credentials"]);
  return secret;
}

export function authStatus(profile: SelectedProfile, redactor: SecretRedactor): Record<string, unknown> {
  const ref = secretReference(profile);
  const status = { profile: profile.name, source: profile.source, origin: profile.origin, auth: profile.auth,
    ...(profile.auth === "oauth" ? { clientId: profile.clientId } : {}),
    secrets: { [profile.auth === "token" ? "token" : "clientSecret"]: ref } };
  try {
    if (profile.auth === "token") resolveToken(profile, redactor, true);
    else resolveSecret(profile, redactor, true);
    return { ...status, status: "available" };
  } catch (error) {
    if (!(error instanceof AxiError)) throw error;
    return { ...status, status: "unavailable", code: error.code, error: error.message, help: error.suggestions };
  }
}

// Internal material for the future session, never a command result or authenticated fetch.
export function resolveToken(profile: SelectedProfile, redactor: SecretRedactor, verifyAcl = false): string {
  if (profile.auth !== "token") {
    throw new AxiError("Personal-token resolution requires auth token", "CONFIG_INVALID", ["Use the OAuth credential provider for auth oauth"]);
  }
  const token = resolveSecret(profile, redactor, verifyAcl);
  if (/\s/.test(token)) {
    throw new AxiError("The referenced token contains whitespace", "AUTH_FAILED", [
      "Replace the token environment value with the API personal token alone",
    ]);
  }
  return `Token ${token}`;
}

export function tlsOptions(profile: SelectedProfile, configPath: LoadedConfig["path"]): {
  rejectUnauthorized: true; ca?: string[];
} {
  if (!profile.caBundle) return { rejectUnauthorized: true };
  try {
    const ca = readFileSync(resolve(dirname(configPath), profile.caBundle), "utf8");
    if (!ca.trim()) throw new Error("Empty CA bundle");
    return { rejectUnauthorized: true, ca: [...rootCertificates, ca] };
  } catch {
    throw new AxiError("Cannot load the profile's private CA bundle", "TLS_TRUST_ERROR", [
      "Set caBundle to a readable PEM CA bundle; relative paths resolve beside the config file",
      "Keep TLS verification enabled",
    ]);
  }
}

// CORE-01 supplies status/TLS failures; expiry is explicit evidence, never guessed from a 401.
export function authFailure(failure: { status?: number; expired?: boolean; code?: string }): AxiError | undefined {
  if (failure.code && new Set([
    "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "ERR_TLS_CERT_ALTNAME_INVALID", "INVALID_CA",
  ]).has(failure.code)) {
    return new AxiError("TLS certificate verification failed", "TLS_TRUST_ERROR", [
      "Check the HTTPS origin, certificate validity and private caBundle; do not disable verification",
    ]);
  }
  if (failure.expired) return new AxiError("API credential has expired", "AUTH_EXPIRED", ["Replace the token provided by its SecretRef"]);
  if (failure.status === 401) return new AxiError("API credential was rejected", "AUTH_FAILED", ["Check or replace the credential provided by its SecretRef"]);
  if (failure.status === 403) return new AxiError("API access was denied", "ACCESS_DENIED", ["Check the API credential's role, permissions and licence for this operation"]);
  return undefined;
}
