import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig, selectProfile, type SelectedProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, nodeTransport, type RawTransport, type Session } from "../src/session.js";

vi.mock("node:https", () => ({ request: vi.fn() }));

const scratch = mkdtempSync(join(import.meta.dirname, ".session-test-"));
const path = join(scratch, "config.json");
const tokenProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" };
const oauthProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "oauth",
  clientId: "synthetic-client", secretEnv: "SENTINEL_SECRET" };
const token = "fake-token-SENTINEL";
const secret = "fake-client-secret-SENTINEL";
const access = "fake-access-token-SENTINEL";

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", token);
  vi.stubEnv("SENTINEL_SECRET", secret);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); rmSync(path, { force: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function session(transport: RawTransport, profile: Record<string, unknown> = { ...tokenProfile }, redactor = new SecretRedactor()): Session {
  writeFileSync(path, JSON.stringify({ profiles: { lab: profile } }));
  const loaded = loadConfig(path, redactor);
  return createSession({ profile: selectProfile(loaded.config, "lab"), configPath: loaded.path, redactor, transport });
}

const ok = (body: unknown) => ({ status: 200, bodyText: JSON.stringify(body) });

it("sends a known read with versioned URL, allowlisted query and token credential", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ count: 1 }));
  const result = await session(transport).request("qux.detection.list", { query: { state: "active", threat_gte: 70 } });
  expect(result).toEqual({ status: 200, body: { count: 1 } });
  expect(transport).toHaveBeenCalledExactlyOnceWith({
    method: "GET",
    url: "https://fixture.invalid/api/v2.5/detections?state=active&threat_gte=70",
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    tls: { rejectUnauthorized: true },
  });
});

it("substitutes and encodes path parameters", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 42 }));
  await session(transport).request("qux.detection.show", { pathParams: { id: 42 } });
  expect(transport.mock.calls[0]![0].url).toBe("https://fixture.invalid/api/v2.5/detections/42");
});

it.each([
  ["missing parameter", {}, { state: "active" }, "Missing path parameter"],
  ["extra parameter", { id: 1, other: 2 }, undefined, "Unexpected path parameter"],
  ["slash traversal", { id: "../health" }, undefined, "Invalid path parameter"],
  ["whitespace", { id: "4 2" }, undefined, "Invalid path parameter"],
])("rejects %s before any HTTP call", async (_name, pathParams, query, message) => {
  const transport = vi.fn<RawTransport>();
  const options = { ...(Object.keys(pathParams).length ? { pathParams } : {}), ...(query ? { query } : {}) };
  await expect(session(transport).request("qux.detection.show", options)).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining(message),
  });
  expect(transport).not.toHaveBeenCalled();
});

it("rejects an unknown query key before any HTTP call", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(session(transport).request("qux.detection.list", { query: { unknown: "x" } }))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(transport).not.toHaveBeenCalled();
});

it("refuses an unknown operation without resolving a credential or calling HTTP", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(session(transport).request("qux.detection.destroy"))
    .rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect(transport).not.toHaveBeenCalled();
});

it("refuses a credential-export GET even though the fixture token could otherwise write", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(session(transport).request("qux.sensor-token.export"))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(transport).not.toHaveBeenCalled();
});

it("refuses the credential exchange as a resource request", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(session(transport).request("qux.oauth.exchange"))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(transport).not.toHaveBeenCalled();
});

it("refuses another generation's operation under this profile", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(session(transport).request("rux.detection.list"))
    .rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect(transport).not.toHaveBeenCalled();
});

it("drives the OAuth exchange then the resource request over one adapter", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 200, bodyText: JSON.stringify({ access_token: access, expires_in: 60, token_type: "Bearer" }) })
    .mockResolvedValueOnce(ok({ id: 7 }));
  const result = await session(transport, oauthProfile).request("qux.host.show", { pathParams: { id: 7 } });
  expect(result).toEqual({ status: 200, body: { id: 7 } });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0]![0]).toEqual({
    method: "POST", url: "https://fixture.invalid/api/v2.5/oauth2/token",
    headers: { Authorization: `Basic ${Buffer.from(`synthetic-client:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", tls: { rejectUnauthorized: true },
  });
  expect(transport.mock.calls[1]![0]).toMatchObject({
    method: "GET", url: "https://fixture.invalid/api/v2.5/hosts/7",
    headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
  });
});

it("refuses a denied operation on an OAuth profile before the exchange HTTP call", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(session(transport, oauthProfile).request("qux.sensor-token.export"))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(transport).not.toHaveBeenCalled();
});

it("reuses the session's unexpired OAuth credential when another exchange would fail", async () => {
  vi.useFakeTimers();
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(ok({ access_token: access, expires_in: 60, token_type: "Bearer" }))
    .mockImplementation(async (request) => {
      if (request.method === "POST") throw new Error("exchange unavailable");
      return ok({ ok: true });
    });
  const owned = session(transport, oauthProfile);
  await owned.request("qux.health.list");
  expect(await owned.request("qux.host.show", { pathParams: { id: 7 } }))
    .toEqual({ status: 200, body: { ok: true } });
  expect(transport.mock.calls.map(([call]) => [call.method, call.headers.Authorization])).toEqual([
    ["POST", `Basic ${Buffer.from(`synthetic-client:${secret}`).toString("base64")}`],
    ["GET", `Bearer ${access}`],
    ["GET", `Bearer ${access}`],
  ]);
});

it("reacquires the session's OAuth credential at expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const transport = vi.fn<RawTransport>().mockResolvedValueOnce(ok({ access_token: access, expires_in: 60, token_type: "Bearer" }))
    .mockResolvedValueOnce(ok({}))
    .mockResolvedValueOnce(ok({ access_token: "fake-second-token", expires_in: 60, token_type: "Bearer" }))
    .mockResolvedValueOnce(ok({}));
  const owned = session(transport, oauthProfile);
  await owned.request("qux.health.list");
  vi.setSystemTime(1_060_000);
  await owned.request("qux.health.list");
  expect(transport.mock.calls.map(([call]) => [call.method, call.headers.Authorization])).toEqual([
    ["POST", `Basic ${Buffer.from(`synthetic-client:${secret}`).toString("base64")}`],
    ["GET", `Bearer ${access}`],
    ["POST", `Basic ${Buffer.from(`synthetic-client:${secret}`).toString("base64")}`],
    ["GET", "Bearer fake-second-token"],
  ]);
});

function httpResponse(): EventEmitter {
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
  vi.mocked(httpsRequest).mockImplementation(((_options: unknown, callback: (response: IncomingMessage) => void) => {
    const pending = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: () => callback(response as IncomingMessage),
      destroy: vi.fn(),
    });
    return pending as unknown as ClientRequest;
  }) as typeof httpsRequest);
  return response;
}

it.each([
  ["token", tokenProfile, "TRANSPORT_FAILED"],
  ["OAuth", oauthProfile, "AUTH_EXCHANGE_FAILED"],
])("settles an aborted %s response without waiting for the deadline", async (_name, profile, code) => {
  vi.useFakeTimers();
  const response = httpResponse();
  const result = session(nodeTransport(), profile).request("qux.health.list");
  const rejected = expect(result).rejects.toMatchObject({ code });
  await Promise.resolve();
  response.emit("data", Buffer.from('{"partial":'));
  response.emit("aborted");
  response.emit("error", new Error("connection reset"));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("settles a response error without an aborted event", async () => {
  vi.useFakeTimers();
  const response = httpResponse();
  const result = session(nodeTransport()).request("qux.health.list");
  const rejected = expect(result).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
  await Promise.resolve();
  response.emit("error", new Error("response failed"));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("returns a complete response body and clears its deadline", async () => {
  vi.useFakeTimers();
  const response = httpResponse();
  const result = session(nodeTransport()).request("qux.health.list");
  await Promise.resolve();
  response.emit("data", Buffer.from('{"ok":'));
  response.emit("data", Buffer.from('true}'));
  response.emit("end");
  expect(await result).toEqual({ status: 200, body: { ok: true } });
  expect(vi.getTimerCount()).toBe(0);
});

it("settles a request at its deadline even if destroying it emits no error", async () => {
  vi.useFakeTimers();
  httpResponse();
  const result = session(nodeTransport()).request("qux.health.list");
  const rejected = expect(result).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a response beyond the body ceiling even if destroying it emits no error", async () => {
  vi.useFakeTimers();
  const response = httpResponse();
  const result = session(nodeTransport()).request("qux.health.list");
  const rejected = expect(result).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
  await Promise.resolve();
  response.emit("data", Buffer.alloc(8 * 1024 * 1024 + 1));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("maps exchange rejection through a resource request", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status: 401, bodyText: "{}" });
  await expect(session(transport, oauthProfile).request("qux.health.list"))
    .rejects.toMatchObject({ code: "AUTH_FAILED" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("follows a same-origin redirect and keeps the credential on the origin", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 302, location: "/api/v2.5/health?fresh=true", bodyText: "" })
    .mockResolvedValueOnce(ok({ ok: true }));
  const result = await session(transport).request("qux.health.list");
  expect(result).toEqual({ status: 200, body: { ok: true } });
  expect(transport).toHaveBeenCalledTimes(2);
  for (const [call] of transport.mock.calls) {
    expect(call.url.startsWith("https://fixture.invalid/")).toBe(true);
    expect(call.headers.Authorization).toBe(`Token ${token}`);
  }
  expect(transport.mock.calls[1]![0].url).toBe("https://fixture.invalid/api/v2.5/health?fresh=true");
});

it("stops a cross-origin redirect before the denied destination sees a credential or call", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 302, location: "https://collector.invalid/api/v2.5/health", bodyText: "" });
  await expect(session(transport).request("qux.health.list"))
    .rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(transport.mock.calls)).not.toContain("collector.invalid");
});

it("refuses an HTTP downgrade redirect", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 301, location: "http://fixture.invalid/api/v2.5/health", bodyText: "" });
  await expect(session(transport).request("qux.health.list"))
    .rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("refuses a redirect chain past the bound", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status: 302, location: "/api/v2.5/health", bodyText: "" });
  await expect(session(transport).request("qux.health.list"))
    .rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(transport).toHaveBeenCalledTimes(4);
});

it("validates a same-origin continuation link without fetching it", () => {
  const next = session(vi.fn<RawTransport>()).resolveContinuation(
    "qux.detection.list", "https://fixture.invalid/api/v2.5/detections?min_id=9");
  expect(next).toBe("https://fixture.invalid/api/v2.5/detections?min_id=9");
});

it("refuses a cross-origin continuation link with no HTTP call", () => {
  const transport = vi.fn<RawTransport>();
  expect(() => session(transport).resolveContinuation("qux.detection.list", "https://collector.invalid/next"))
    .toThrow(expect.objectContaining({ code: "DESTINATION_DENIED" }));
  expect(transport).not.toHaveBeenCalled();
});

it("refuses a continuation for an unknown operation", () => {
  expect(() => session(vi.fn<RawTransport>()).resolveContinuation("qux.detection.destroy", "/api/v2.5/x"))
    .toThrow(expect.objectContaining({ code: "OPERATION_UNKNOWN" }));
});

it.each([[401, "AUTH_FAILED"], [403, "ACCESS_DENIED"]])("maps status %s through the session", async (status, code) => {
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status, bodyText: "{}" });
  await expect(session(transport).request("qux.health.list")).rejects.toMatchObject({ code });
});

it("reports an unmapped failure status without retrying", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status: 503, bodyText: "busy" });
  await expect(session(transport).request("qux.health.list")).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("rejects a non-JSON success body", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status: 200, bodyText: "<html>nope</html>" });
  await expect(session(transport).request("qux.health.list")).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("maps a TLS transport failure without retry or raw cause", async () => {
  const transport = vi.fn<RawTransport>().mockRejectedValue(Object.assign(new Error("raw failure"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }));
  await expect(session(transport).request("qux.health.list")).rejects.toMatchObject({ code: "TLS_TRUST_ERROR" });
});

it("scrubs secret material from transport errors", async () => {
  const redactor = new SecretRedactor();
  const transport = vi.fn<RawTransport>().mockRejectedValue(new Error(`dial failed ${token}`));
  const error = await session(transport, tokenProfile, redactor).request("qux.health.list").catch((error: Error) => error);
  expect(error).toMatchObject({ code: "TRANSPORT_FAILED" });
  expect(JSON.stringify(error)).not.toContain(token);
  expect(redactor.text(token)).toBe("***redacted***");
});

it("exposes no raw transport, fetch handle or credential material", async () => {
  const owned = session(vi.fn<RawTransport>().mockResolvedValue(ok({})));
  expect(Object.keys(owned).sort()).toEqual(["profile", "request", "resolveContinuation"]);
  expect(owned.profile).toEqual({ name: "lab", kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5" });
  expect("transport" in owned && "fetch" in owned).toBe(false);
  expect(JSON.stringify(owned)).not.toContain(token);
});
