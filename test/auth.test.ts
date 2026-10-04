import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { authFailure, resolveToken, tlsOptions } from "../src/auth.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".auth-test-"));
const path = join(scratch, "config.json");
const profile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" };
const sentinel = "fake-secret-SENTINEL-01";

afterEach(() => { vi.unstubAllEnvs(); rmSync(path, { force: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function configure(value: unknown = { profiles: { lab: profile } }, redactor?: SecretRedactor) {
  writeFileSync(path, JSON.stringify(value));
  return loadConfig(path, redactor);
}

it.each([
  ["flag", "lab", "other", "other", "lab"],
  ["env", undefined, "other", "lab", "other"],
  ["config-default", undefined, undefined, "other", "other"],
  ["sole", undefined, undefined, undefined, "lab"],
])("selects the profile through %s precedence", (source, flag, env, defaultProfile, expected) => {
  vi.stubEnv("VECTRA_AXI_PROFILE", env);
  const loaded = configure({ defaultProfile, profiles: source === "sole" ? { lab: profile } : { lab: profile, other: profile } });
  expect(selectProfile(loaded.config, flag)).toMatchObject({ name: expected, source, apiVersion: "2.5" });
});

it("reports ambiguity instead of guessing the deployment", () => {
  vi.stubEnv("VECTRA_AXI_PROFILE", undefined);
  const loaded = configure({ profiles: { lab: profile, other: profile } });
  expect(() => selectProfile(loaded.config)).toThrow(expect.objectContaining({ code: "PROFILE_AMBIGUOUS" }));
});

it.each(["", " lab", "lab ", " lab ", "\tlab\n"])("rejects invalid profile identifier %j without collapsing keys", (name) => {
  expect(() => configure({ profiles: { lab: profile, [name]: { ...profile, origin: "https://other.invalid" } } }))
    .toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it.each(["", " lab", "lab ", " lab ", "\tlab\n"])("rejects invalid default profile identifier %j", (defaultProfile) => {
  expect(() => configure({ defaultProfile, profiles: { lab: profile } }))
    .toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it.each(["flag", "env"])("does not normalize the %s profile selection", (source) => {
  vi.stubEnv("VECTRA_AXI_PROFILE", source === "env" ? " lab " : undefined);
  expect(() => selectProfile(configure().config, source === "flag" ? " lab " : undefined))
    .toThrow(expect.objectContaining({ code: "PROFILE_NOT_FOUND" }));
});

it.each(["missing", "constructor", "toString"])("rejects an unknown profile %s", (name) => {
  expect(() => selectProfile(configure().config, name)).toThrow(expect.objectContaining({ code: "PROFILE_NOT_FOUND" }));
});

it("does not reuse a UI login when configuration has no profiles", () => {
  vi.stubEnv("VECTRA_AXI_PROFILE", undefined);
  expect(() => selectProfile(configure({ profiles: {} }).config)).toThrow(expect.objectContaining({ code: "PROFILE_REQUIRED" }));
});

it.each([
  ["missing kind", { kind: undefined }], ["missing origin", { origin: undefined }],
  ["HTTP", { origin: "http://fixture.invalid" }], ["URL path", { origin: "https://fixture.invalid/api/v2.5" }],
  ["URL query", { origin: "https://fixture.invalid?x=y" }], ["URL fragment", { origin: "https://fixture.invalid#fragment" }],
  ["URL login", { origin: "https://user:fake@fixture.invalid" }],
  ["numeric version", { apiVersion: 2.5 }], ["unreviewed version", { apiVersion: "2.10" }],
  ["cloud token", { kind: "rux", apiVersion: "3.4" }],
  ["OAuth", { auth: "oauth", clientId: "fake-client", secretEnv: "SENTINEL_SECRET" }],
  ["mixed client ID", { clientId: "fake-client" }], ["mixed OAuth secret", { secretEnv: "SENTINEL_SECRET" }],
  ["missing reference", { tokenEnv: undefined }], ["invalid reference", { tokenEnv: "not an env reference" }],
  ["inline token", { token: sentinel }], ["UI password", { password: sentinel }],
  ["TLS bypass", { rejectUnauthorized: false }],
])("rejects %s at configuration load, including unselected profiles", (_name, fields) => {
  expect(() => configure({ defaultProfile: "lab", profiles: { lab: profile, invalid: { ...profile, ...fields } } }))
    .toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

// RUX-01: cloud profiles use OAuth only, pin API v3.4 and carry no
// appliance release; token mode and release fields stay QUX-only.
const ruxOauth = { kind: "rux", origin: "https://cloud.invalid", apiVersion: "3.4", auth: "oauth",
  clientId: "synthetic-client", secretEnv: "SENTINEL_SECRET" };

it("accepts a cloud OAuth profile beside an on-prem profile", () => {
  const loaded = configure({ profiles: { lab: profile, cloud: ruxOauth } });
  expect(selectProfile(loaded.config, "cloud")).toMatchObject(
    { name: "cloud", kind: "rux", apiVersion: "3.4", auth: "oauth" });
  expect(selectProfile(loaded.config, "lab")).toMatchObject({ kind: "qux", apiVersion: "2.5" });
});

it.each([
  ["token mode", { auth: "token", tokenEnv: "SENTINEL_TOKEN", clientId: undefined, secretEnv: undefined }],
  ["appliance release", { applianceRelease: "9.4" }],
  ["QUX version", { apiVersion: "2.5" }],
  ["mixed token reference", { tokenEnv: "SENTINEL_TOKEN" }],
])("rejects a cloud profile with %s", (_name, fields) => {
  expect(() => configure({ profiles: { lab: profile, cloud: { ...ruxOauth, ...fields } } }))
    .toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it("rejects a dangling configured default", () => {
  expect(() => configure({ defaultProfile: "absent", profiles: { lab: profile } }))
    .toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it("keeps malformed JSON contents out of errors", () => {
  writeFileSync(path, `{"token":"${sentinel}`);
  expect(() => loadConfig(path)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID", message: "Cannot read profile configuration as JSON" }));
});

it("reads the explicitly selected environment config", () => {
  configure();
  vi.stubEnv("VECTRA_AXI_CONFIG", path);
  expect(loadConfig().config.profiles.lab).toEqual(profile);
});

it("fails when an explicit config is missing", () => {
  expect(() => loadConfig(join(scratch, "missing.json"))).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it("resolves the QUX Token scheme and retains the value in invocation memory", () => {
  const redactor = new SecretRedactor();
  vi.stubEnv("SENTINEL_TOKEN", sentinel);
  expect(resolveToken(selectProfile(configure().config, "lab"), redactor)).toBe(`Token ${sentinel}`);
  expect(redactor.text(`debug: Token ${sentinel}`)).toBe("debug: Token ***redacted***");
});

it.each([undefined, "", "   "])("reports missing token credentials for %s", (value) => {
  vi.stubEnv("SENTINEL_TOKEN", value);
  expect(() => resolveToken(selectProfile(configure().config, "lab"), new SecretRedactor()))
    .toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
});

it("rejects header injection in a referenced token", () => {
  vi.stubEnv("SENTINEL_TOKEN", `${sentinel}\r\nHeader: injected`);
  expect(() => resolveToken(selectProfile(configure().config, "lab"), new SecretRedactor()))
    .toThrow(expect.objectContaining({ code: "AUTH_FAILED" }));
});

it("uses verified system trust by default", () => {
  expect(tlsOptions(selectProfile(configure().config, "lab"), path)).toEqual({ rejectUnauthorized: true });
});

it("adds a private CA beside the config while retaining system trust", () => {
  const ca = "-----BEGIN CERTIFICATE-----\nSYNTHETIC-CA-ONLY\n-----END CERTIFICATE-----\n";
  writeFileSync(join(scratch, "fake-ca.pem"), ca);
  const selected = selectProfile(configure({ profiles: { lab: { ...profile, caBundle: "fake-ca.pem" } } }).config, "lab");
  expect(tlsOptions(selected, path)).toEqual({ rejectUnauthorized: true, ca: [...rootCertificates, ca] });
});

it("reports unreadable private CA material as a trust error", () => {
  const selected = selectProfile(configure({ profiles: { lab: { ...profile, caBundle: "absent.pem" } } }).config, "lab");
  expect(() => tlsOptions(selected, path)).toThrow(expect.objectContaining({ code: "TLS_TRUST_ERROR" }));
});

it("rejects an empty private CA bundle", () => {
  writeFileSync(join(scratch, "empty-ca.pem"), "");
  const selected = selectProfile(configure({ profiles: { lab: { ...profile, caBundle: "empty-ca.pem" } } }).config, "lab");
  expect(() => tlsOptions(selected, path)).toThrow(expect.objectContaining({ code: "TLS_TRUST_ERROR" }));
});

it.each([
  [{ expired: true }, "AUTH_EXPIRED"], [{ status: 401 }, "AUTH_FAILED"], [{ status: 403 }, "ACCESS_DENIED"],
  [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "TLS_TRUST_ERROR"],
  [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "TLS_TRUST_ERROR"], [{ code: "CERT_HAS_EXPIRED" }, "TLS_TRUST_ERROR"],
])("distinguishes authentication/access/trust failure %j", (failure, code) => {
  expect(authFailure(failure)).toMatchObject({ code, suggestions: expect.any(Array) });
});

it("leaves non-authentication failures to the session", () => {
  expect(authFailure({ status: 500, code: "ECONNRESET" })).toBeUndefined();
});

it.each(["AUTH_FAILED", "TLS_TRUST_ERROR", "unexpected"])("scrubs %s before SDK formatting and all output", async (code) => {
  vi.stubEnv("SENTINEL_TOKEN", sentinel);
  const redactor = new SecretRedactor();
  configure(undefined, redactor);
  const error = code === "unexpected" ? new Error(`unexpected ${sentinel}`)
    : Object.assign(new AxiError(`failure ${sentinel}`, code, [`replace ${sentinel}`]), { details: { nested: [sentinel] } });
  let safe: unknown;
  try { redactor.boundary(() => { throw error; }); } catch (error) { safe = error; }
  expect(JSON.stringify(safe)).not.toContain(sentinel);
  expect((safe as Error).message).not.toContain(sentinel);
  expect((safe as Error).stack).not.toContain(sentinel);
  const stdout: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write");
  await runAxiCli({ description: "Synthetic auth fixture", argv: [], topLevelHelp: "", commands: {},
    home: () => { throw safe; }, stdout: { write: (chunk) => stdout.push(redactor.text(chunk)) } });
  expect(stdout.join("")).toContain("***redacted***");
  expect(stdout.join("")).not.toContain(sentinel);
  expect(stderr).not.toHaveBeenCalled();
  stderr.mockRestore();
  process.exitCode = 0;
  expect(redactor.text(`debug ${sentinel}`)).not.toContain(sentinel);
});

it("redacts nested results, object keys and escaped diagnostic strings", () => {
  const redactor = new SecretRedactor();
  const secret = 'fake-"\\\n-secret';
  redactor.add(secret);
  expect(redactor.value({ [secret]: [secret, { text: `prefix ${secret}` }] }))
    .toEqual({ "***redacted***": ["***redacted***", { text: "prefix ***redacted***" }] });
  expect(redactor.text(JSON.stringify({ secret }))).not.toContain(JSON.stringify(secret).slice(1, -1));
});

it.each(["\ud800", "\udc00", "prefix\ud800suffix", "prefix\udc00suffix"])("redacts unencodable secrets %j", (secret) => {
  const redactor = new SecretRedactor();
  redactor.add(secret);
  expect(redactor.value({ [secret]: [secret] })).toEqual({ "***redacted***": ["***redacted***"] });
  expect(redactor.text(JSON.stringify({ secret }))).toBe('{"secret":"***redacted***"}');
});

it("redacts URI-encoded well-formed secrets", () => {
  const redactor = new SecretRedactor();
  const secret = "fake/secret-\ud83d\udd10";
  redactor.add(secret);
  expect(redactor.text(encodeURIComponent(secret))).toBe("***redacted***");
});

it("registers an unselected profile's referenced secret before rejecting its configuration", () => {
  vi.stubEnv("SENTINEL_SECRET", sentinel);
  const redactor = new SecretRedactor();
  expect(() => configure({ defaultProfile: "lab", profiles: {
    lab: profile, invalid: { ...profile, secretEnv: "SENTINEL_SECRET" },
  } }, redactor)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  expect(redactor.text(`diagnostic ${sentinel}`)).toBe("diagnostic ***redacted***");
});
