import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { oauthCredentials, type TokenTransport } from "../src/oauth.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".oauth-test-"));
const path = join(scratch, "config.json");
const profile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "oauth",
  clientId: "synthetic-client", secretEnv: "SENTINEL_SECRET" };
const secret = "fake-client-secret-SENTINEL";
const access = "fake-access-token-SENTINEL";
const refresh = "fake-unused-refresh-SENTINEL";
const response = { status: 200, body: { access_token: access, expires_in: 2, token_type: "Bearer" } };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.stubEnv("SENTINEL_SECRET", secret); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function configured(fields = {}, redactor = new SecretRedactor()) {
  writeFileSync(path, JSON.stringify({ profiles: { lab: { ...profile, ...fields } } }));
  return { loaded: loadConfig(path, redactor), redactor };
}

function provider(transport: TokenTransport, fields = {}, redactor = new SecretRedactor()) {
  const { loaded } = configured(fields, redactor);
  const selected = selectProfile(loaded.config, "lab");
  if (selected.auth !== "oauth") throw new Error("Expected synthetic OAuth profile");
  return oauthCredentials(selected, loaded.path, redactor, transport);
}

it("uses only the named versioned QUX client-credentials exchange", async () => {
  const transport = vi.fn<TokenTransport>().mockResolvedValue(response);
  expect(await provider(transport)()).toEqual({ header: `Bearer ${access}`, expiresAt: 1_002_000 });
  expect(transport).toHaveBeenCalledExactlyOnceWith({
    operation: "qux.oauth.exchange", method: "POST", url: "https://fixture.invalid/api/v2.5/oauth2/token",
    headers: { Authorization: `Basic ${Buffer.from(`synthetic-client:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", tls: { rejectUnauthorized: true },
  });
});

it("reuses an invocation's credential until its returned expiry", async () => {
  const transport = vi.fn<TokenTransport>().mockResolvedValue(response);
  const resolve = provider(transport);
  const credential = await resolve();
  credential.header = "changed by caller";
  vi.setSystemTime(1_001_999);
  expect(await resolve()).toEqual({ header: `Bearer ${access}`, expiresAt: 1_002_000 });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("reacquires at expiry using client credentials even if a refresh token is returned", async () => {
  const transport = vi.fn<TokenTransport>().mockResolvedValueOnce({ ...response, body: { ...response.body, refresh_token: refresh } })
    .mockResolvedValueOnce({ ...response, body: { ...response.body, access_token: "fake-second-token", expires_in: 7 } });
  const resolve = provider(transport);
  await resolve();
  vi.setSystemTime(1_002_000);
  expect(await resolve()).toEqual({ header: "Bearer fake-second-token", expiresAt: 1_009_000 });
  expect(transport.mock.calls.map(([request]) => request.body)).toEqual(["grant_type=client_credentials", "grant_type=client_credentials"]);
});

it("keeps separate invocation credential caches", async () => {
  const transport = vi.fn<TokenTransport>().mockResolvedValue(response);
  await provider(transport)();
  await provider(transport)();
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each([undefined, "", "   "])("rejects missing secret %j before transport", async (value) => {
  vi.stubEnv("SENTINEL_SECRET", value);
  const transport = vi.fn<TokenTransport>();
  await expect(provider(transport)()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  ["token fields", { tokenEnv: "SENTINEL_TOKEN" }], ["missing client", { clientId: undefined }],
  ["empty client", { clientId: "" }], ["Basic delimiter", { clientId: "fake:client" }],
  ["missing secret reference", { secretEnv: undefined }], ["invalid reference", { secretEnv: "not an env reference" }],
  ["inline secret", { clientSecret: secret }], ["RUX", { kind: "rux", apiVersion: "3.4" }],
])("rejects OAuth profile with %s", (_name, fields) => {
  expect(() => configured(fields)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it.each([
  [401, {}, "AUTH_FAILED"], [400, { error: "invalid_client" }, "AUTH_FAILED"],
  [403, {}, "ACCESS_DENIED"], [429, {}, "AUTH_EXCHANGE_FAILED"], [503, {}, "AUTH_EXCHANGE_FAILED"],
  [302, {}, "AUTH_EXCHANGE_FAILED"],
])("returns bounded actionable error for status %s", async (status, body, code) => {
  const transport = vi.fn<TokenTransport>().mockResolvedValue({ status, body });
  await expect(provider(transport)()).rejects.toMatchObject({ code, suggestions: expect.any(Array) });
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
  ["CERT_HAS_EXPIRED", "TLS_TRUST_ERROR"], ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_TRUST_ERROR"],
  ["ETIMEDOUT", "AUTH_EXCHANGE_FAILED"],
])("translates transport %s without retry or raw cause", async (code, expected) => {
  const transport = vi.fn<TokenTransport>().mockRejectedValue(Object.assign(new Error(`raw ${secret}`), { code }));
  const error = await provider(transport)().catch((error: AxiError) => error);
  expect(error).toMatchObject({ code: expected, suggestions: expect.any(Array) });
  expect(JSON.stringify(error)).not.toContain(secret);
  expect((error as Error).stack).not.toContain(secret);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("rejects unreadable private trust before transport", async () => {
  const transport = vi.fn<TokenTransport>();
  await expect(provider(transport, { caBundle: "absent.pem" })()).rejects.toMatchObject({ code: "TLS_TRUST_ERROR" });
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  ["missing token", { access_token: undefined }], ["empty token", { access_token: "" }],
  ["header injection", { access_token: `${access}\r\nInjected: yes` }],
  ["trailing newline", { access_token: `${access}\n` }],
  ["lone high surrogate", { access_token: "\ud800" }], ["lone low surrogate", { access_token: "\udc00" }],
  ["NUL", { access_token: "abc\u0000def" }], ["control character", { access_token: "abc\u001fdef" }],
  ["DEL", { access_token: "abc\u007fdef" }], ["non-ASCII", { access_token: "abc\u00e9def" }],
  ["non-Bearer punctuation", { access_token: "abc:def" }], ["interior padding", { access_token: "abc=def" }],
  ["padding alone", { access_token: "=" }],
  ["wrong scheme", { token_type: "Token" }], ["missing scheme", { token_type: undefined }], ["missing expiry", { expires_in: undefined }],
  ["string expiry", { expires_in: "2" }], ["unbounded expiry", { expires_in: Infinity }],
])("rejects malformed response with %s", async (_name, fields) => {
  const transport = vi.fn<TokenTransport>().mockResolvedValue({ ...response, body: { ...response.body, ...fields } });
  await expect(provider(transport)()).rejects.toMatchObject({ code: "AUTH_RESPONSE_INVALID" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each(["AZaz09-._~+/", "synthetic=", "synthetic=="])("accepts Bearer token syntax %s", async (access_token) => {
  const transport = vi.fn<TokenTransport>().mockResolvedValue({ ...response, body: { ...response.body, access_token } });
  expect(await provider(transport)()).toEqual({ header: `Bearer ${access_token}`, expiresAt: 1_002_000 });
});

it("does not cache an unsuitable access token", async () => {
  const transport = vi.fn<TokenTransport>().mockResolvedValueOnce({ ...response, body: { ...response.body, access_token: "abc\u0000def" } })
    .mockResolvedValue(response);
  const resolve = provider(transport);
  await expect(resolve()).rejects.toMatchObject({ code: "AUTH_RESPONSE_INVALID" });
  expect(await resolve()).toEqual({ header: `Bearer ${access}`, expiresAt: 1_002_000 });
  expect(await resolve()).toEqual({ header: `Bearer ${access}`, expiresAt: 1_002_000 });
  expect(transport).toHaveBeenCalledTimes(2);
});

it("registers returned tokens even when an exchange response is denied", async () => {
  const redactor = new SecretRedactor();
  const transport = vi.fn<TokenTransport>().mockResolvedValue({ status: 403,
    body: { access_token: access, refresh_token: refresh, error_description: `raw ${secret}` } });
  const error = await provider(transport, {}, redactor)().catch((error: AxiError) => error);
  expect(error).toMatchObject({ code: "ACCESS_DENIED" });
  expect((error as Error).message).not.toContain(secret);
  expect(redactor.value({ result: access, debug: refresh })).toEqual({ result: "***redacted***", debug: "***redacted***" });
});

it.each(["\ud800", "\udc00"])("authenticates despite an unencodable unused refresh token %j", async (refresh_token) => {
  const redactor = new SecretRedactor();
  const transport = vi.fn<TokenTransport>().mockResolvedValue({ ...response, body: { ...response.body, refresh_token } });
  expect(await provider(transport, {}, redactor)()).toEqual({ header: `Bearer ${access}`, expiresAt: 1_002_000 });
  expect(redactor.text(refresh_token)).toBe("***redacted***");
  expect(redactor.text(JSON.stringify({ refresh_token }))).toBe('{"refresh_token":"***redacted***"}');
});

it.each([
  [401, "AUTH_FAILED"], [403, "ACCESS_DENIED"], [503, "AUTH_EXCHANGE_FAILED"],
  [200, "AUTH_RESPONSE_INVALID"],
])("preserves status %s classification with unencodable returned tokens", async (status, code) => {
  const redactor = new SecretRedactor();
  const body = { ...response.body, access_token: "\ud800", refresh_token: "\udc00" };
  const transport = vi.fn<TokenTransport>().mockResolvedValue({ status, body });
  await expect(provider(transport, {}, redactor)()).rejects.toMatchObject({ code });
  expect(redactor.value(body)).toEqual({ ...body, access_token: "***redacted***", refresh_token: "***redacted***" });
});

it.each([0, -1])("reports already expired lifetime %s without retry", async (expires_in) => {
  const transport = vi.fn<TokenTransport>().mockResolvedValue({ ...response, body: { ...response.body, expires_in } });
  await expect(provider(transport)()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("does not extend expiry by the exchange latency", async () => {
  const transport = vi.fn<TokenTransport>().mockImplementation(async () => { vi.setSystemTime(1_002_000); return response; });
  await expect(provider(transport)()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("does not reuse an expired credential after failed reacquisition", async () => {
  const transport = vi.fn<TokenTransport>().mockResolvedValueOnce(response).mockResolvedValue({ status: 401, body: {} });
  const resolve = provider(transport);
  await resolve();
  vi.setSystemTime(1_002_000);
  await expect(resolve()).rejects.toMatchObject({ code: "AUTH_FAILED" });
  await expect(resolve()).rejects.toMatchObject({ code: "AUTH_FAILED" });
  expect(transport).toHaveBeenCalledTimes(3);
});

it("scrubs Basic and returned token material from SDK errors, results and debug output", async () => {
  const redactor = new SecretRedactor();
  const transport = vi.fn<TokenTransport>().mockResolvedValue({ ...response, body: { ...response.body, refresh_token: refresh } });
  const credential = await provider(transport, {}, redactor)();
  const encoded = Buffer.from(`synthetic-client:${secret}`).toString("base64");
  const diagnostic = `${secret} ${access} ${refresh} Basic ${encoded}`;
  const stdout: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write");
  await runAxiCli({ description: "Synthetic OAuth fixture", argv: [], topLevelHelp: "", commands: {},
    home: () => redactor.boundary(() => { throw new AxiError(diagnostic, "AUTH_FAILED", [diagnostic]); }),
    stdout: { write: (chunk) => stdout.push(redactor.text(chunk)) } });
  expect(stdout.join("")).toContain("***redacted***");
  expect(stderr).not.toHaveBeenCalled();
  stderr.mockRestore();
  process.exitCode = 0;
  expect(redactor.value(credential)).toEqual({ header: "Bearer ***redacted***", expiresAt: 1_002_000 });
  expect(redactor.text(`debug: ${diagnostic}`)).toBe("debug: ***redacted*** ***redacted*** ***redacted*** Basic ***redacted***");
  expect(stdout.join("")).not.toContain(encoded);
});
