import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { AxiError } from "axi-sdk-js";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig, selectProfile, type SelectedProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, nodeTransport, type RawTransport, type Session, type SessionRequestOptions } from "../src/session.js";
import { collect } from "../src/collections.js";
import { runAuditList } from "../src/audits.js";

vi.mock("node:https", () => ({ request: vi.fn() }));

const scratch = mkdtempSync(join(import.meta.dirname, ".session-test-"));
const path = join(scratch, "config.json");
const tokenProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" };
const oauthProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "oauth",
  clientId: "synthetic-client", secretEnv: "SENTINEL_SECRET" };
const ruxProfile = { kind: "rux", origin: "https://fixture.invalid", apiVersion: "3.4", auth: "oauth",
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

// RUX-01: the cloud profile keeps the session contract with an unversioned
// exchange, versioned resource prefix and unchanged credential lifecycle.
it("drives the unversioned RUX exchange then a versioned resource request", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 200, bodyText: JSON.stringify({ access_token: access, expires_in: 60,
      token_type: "Bearer", refresh_token: "fake-unused-refresh" }) })
    .mockResolvedValueOnce(ok({ ok: true }));
  const result = await session(transport, ruxProfile).request("rux.health.list");
  expect(result).toEqual({ status: 200, body: { ok: true } });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0]![0]).toEqual({
    method: "POST", url: "https://fixture.invalid/oauth2/token",
    headers: { Authorization: `Basic ${Buffer.from(`synthetic-client:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", tls: { rejectUnauthorized: true },
  });
  expect(transport.mock.calls[1]![0]).toMatchObject({
    method: "GET", url: "https://fixture.invalid/api/v3.4/health/",
    headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
  });
});

it("refuses the RUX credential exchange as a resource request", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(session(transport, ruxProfile).request("rux.oauth.exchange"))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  ["QUX session and RUX exchange", tokenProfile, "rux.oauth.exchange"],
  ["RUX session and QUX exchange", ruxProfile, "qux.oauth.exchange"],
  ["RUX session and QUX read", ruxProfile, "qux.health.list"],
])("refuses %s without resolving a credential or calling HTTP", async (_name, profile, operation) => {
  const transport = vi.fn<RawTransport>();
  await expect(session(transport, profile).request(operation))
    .rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect(transport).not.toHaveBeenCalled();
});

it("names the RUX contract when a cloud profile misses its generation", async () => {
  const transport = vi.fn<RawTransport>();
  const error: unknown = await session(transport, ruxProfile).request("qux.health.list").catch((error: AxiError) => error);
  expect(error).toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect((error as AxiError).suggestions.join(" ")).toContain("RUX v3.4");
});

it.each([
  ["versioned token route", "/api/v2.5/oauth2/token"],
  ["QUX resource prefix", "/api/v2.5/health"],
  ["unversioned token reuse", "/oauth2/token?refresh=true"],
])("rejects a RUX redirect to %s without calling it", async (_name, location) => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 200, bodyText: JSON.stringify({ access_token: access, expires_in: 60, token_type: "Bearer" }) })
    .mockResolvedValueOnce({ status: 302, location, bodyText: "" });
  await expect(session(transport, ruxProfile).request("rux.health.list"))
    .rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.map(([call]) => call.url)).toEqual([
    "https://fixture.invalid/oauth2/token", "https://fixture.invalid/api/v3.4/health/",
  ]);
});

it("maps a RUX exchange rejection through a resource request", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status: 401, bodyText: "{}" });
  await expect(session(transport, ruxProfile).request("rux.health.list"))
    .rejects.toMatchObject({ code: "AUTH_FAILED" });
  expect(transport).toHaveBeenCalledTimes(1);
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
  ["GET", tokenProfile], ["OAuth exchange", oauthProfile],
])("rejects cancellation before starting a %s", async (_name, profile) => {
  const controller = new AbortController();
  controller.abort();
  const transport = vi.fn<RawTransport>();
  await expect(session(transport, profile).request("qux.detection.list", { signal: controller.signal }))
    .rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  ["GET cancellation", tokenProfile, (controller: AbortController) => controller.abort(), "REQUEST_CANCELLED"],
  ["OAuth cancellation", oauthProfile, (controller: AbortController) => controller.abort(), "REQUEST_CANCELLED"],
  ["GET deadline", tokenProfile, (_controller: AbortController) => vi.advanceTimersByTimeAsync(1000), "DEADLINE_EXCEEDED"],
  ["OAuth deadline", oauthProfile, (_controller: AbortController) => vi.advanceTimersByTimeAsync(1000), "DEADLINE_EXCEEDED"],
] as const)("destroys the active request and releases timers on %s", async (_name, profile, stop, code) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  httpResponse();
  const result = collect(session(nodeTransport(), profile), "qux.detection.list", {
    signal: controller.signal, policy: { deadlineMs: 1000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  const pending = vi.mocked(httpsRequest).mock.results[0]!.value as ClientRequest;
  await stop(controller);
  expect(await result).toMatchObject({ rows: [], complete: false, error: { code } });
  expect(pending.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(httpsRequest).toHaveBeenCalledTimes(1);
});

it.each([
  ["redirect", tokenProfile, { status: 302, location: "/api/v2.5/detections?min_id=9", bodyText: "" }],
  ["OAuth exchange", oauthProfile, ok({ access_token: access, expires_in: 60, token_type: "Bearer" })],
])("does not send a resource request after a cancelled %s resolves late", async (_name, profile, response) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let respond!: (response: Awaited<ReturnType<RawTransport>>) => void;
  const transport = vi.fn<RawTransport>(() => new Promise((resolve) => { respond = resolve; }));
  const result = collect(session(transport, profile), "qux.detection.list", { signal: controller.signal });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect(await result).toMatchObject({ complete: false, error: { code: "REQUEST_CANCELLED" } });
  expect(transport.mock.calls[0]![0].signal?.aborted).toBe(true);
  respond(response);
  await vi.advanceTimersByTimeAsync(0);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["token", tokenProfile, "TRANSPORT_FAILED"],
  ["OAuth", oauthProfile, "AUTH_EXCHANGE_FAILED"],
])("clears the deadline when %s request construction throws", async (_name, profile, code) => {
  vi.useFakeTimers();
  vi.stubEnv("SENTINEL_TOKEN", "synthetic-\u0100-token");
  vi.mocked(httpsRequest).mockImplementationOnce(() => {
    throw Object.assign(new Error("Invalid character in header content"), { code: "ERR_INVALID_CHAR" });
  });
  await expect(session(nodeTransport(), profile).request("qux.health.list")).rejects.toMatchObject({ code });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
});

it("clears the deadline when writing an OAuth request body throws", async () => {
  vi.useFakeTimers();
  const pending = Object.assign(new EventEmitter(), {
    write: () => { throw new Error("body write failed"); },
    end: vi.fn(),
  });
  vi.mocked(httpsRequest).mockReturnValueOnce(pending as unknown as ClientRequest);
  await expect(session(nodeTransport(), oauthProfile).request("qux.health.list"))
    .rejects.toMatchObject({ code: "AUTH_EXCHANGE_FAILED" });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
});

it("clears the deadline when ending a resource request throws", async () => {
  vi.useFakeTimers();
  const pending = Object.assign(new EventEmitter(), { end: () => { throw new Error("request end failed"); } });
  vi.mocked(httpsRequest).mockReturnValueOnce(pending as unknown as ClientRequest);
  await expect(session(nodeTransport()).request("qux.health.list")).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
});

it.each([
  ["DNS", "https://fixture.invalid", "fixture.invalid", 443],
  ["IPv4", "https://192.0.2.10", "192.0.2.10", 443],
  ["IPv6", "https://[2001:db8::10]", "2001:db8::10", 443],
  ["IPv6 with a port", "https://[2001:db8::10]:8443", "2001:db8::10", "8443"],
])("passes a connection-ready %s hostname to Node", async (_name, origin, hostname, port) => {
  vi.useFakeTimers();
  const response = httpResponse();
  const result = session(nodeTransport(), { ...tokenProfile, origin }).request("qux.health.list");
  await Promise.resolve();
  response.emit("data", Buffer.from('{"ok":true}'));
  response.emit("end");
  expect(await result).toEqual({ status: 200, body: { ok: true } });
  expect(vi.mocked(httpsRequest).mock.calls[0]![0]).toMatchObject({ hostname, port, method: "GET", path: "/api/v2.5/health" });
});

it("uses the IPv6 literal for both the OAuth exchange and resource read", async () => {
  vi.useFakeTimers();
  const origin = "https://[2001:db8::10]";
  const exchangeResponse = httpResponse();
  const result = session(nodeTransport(), { ...oauthProfile, origin }).request("qux.health.list");
  const resourceResponse = httpResponse();
  exchangeResponse.emit("data", Buffer.from(JSON.stringify({ access_token: access, expires_in: 60, token_type: "Bearer" })));
  exchangeResponse.emit("end");
  await vi.advanceTimersByTimeAsync(0);
  resourceResponse.emit("data", Buffer.from('{"ok":true}'));
  resourceResponse.emit("end");
  expect(await result).toEqual({ status: 200, body: { ok: true } });
  expect(vi.mocked(httpsRequest).mock.calls.map(([options]) => options)).toMatchObject([
    { hostname: "2001:db8::10", method: "POST", path: "/api/v2.5/oauth2/token" },
    { hostname: "2001:db8::10", method: "GET", path: "/api/v2.5/health" },
  ]);
});

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
  const rejected = expect(result).rejects.toMatchObject({ code: "BYTE_BUDGET_EXCEEDED" });
  await Promise.resolve();
  response.emit("data", Buffer.alloc(8 * 1024 * 1024 + 1));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("suggests a smaller audit window when the production adapter rejects an oversized response", async () => {
  vi.useFakeTimers();
  const response = httpResponse();
  const result = runAuditList(session(nodeTransport()), new Map([
    ["start-date", "2026-10-01"], ["end-date", "2026-10-02"],
  ]));
  const rejected = expect(result).rejects.toMatchObject({
    code: "BYTE_BUDGET_EXCEEDED",
    suggestions: expect.arrayContaining([
      expect.stringContaining("smaller date range"),
      expect.stringContaining("--start-date 2026-10-02 --end-date 2026-10-02"),
    ]),
  });
  await Promise.resolve();
  response.emit("data", Buffer.alloc(8 * 1024 * 1024));
  response.emit("data", Buffer.from("x"));
  await rejected;
  const pending = vi.mocked(httpsRequest).mock.results[0]!.value as ClientRequest;
  expect(pending.destroy).toHaveBeenCalledTimes(1);
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
    .mockResolvedValueOnce({ status: 302, location: "/api/v2.5/health?cache=true", bodyText: "" })
    .mockResolvedValueOnce(ok({ ok: true }));
  const result = await session(transport).request("qux.health.list");
  expect(result).toEqual({ status: 200, body: { ok: true } });
  expect(transport).toHaveBeenCalledTimes(2);
  for (const [call] of transport.mock.calls) {
    expect(call.url.startsWith("https://fixture.invalid/")).toBe(true);
    expect(call.headers.Authorization).toBe(`Token ${token}`);
  }
  expect(transport.mock.calls[1]![0].url).toBe("https://fixture.invalid/api/v2.5/health?cache=true");
});

const deniedDestinations: [string, string, SessionRequestOptions["pathParams"], string][] = [
  ["sensor token export", "qux.health.list", undefined, "/api/v2.5/sensor_token"],
  ["connector credential export", "qux.health.list", undefined, "https://fixture.invalid/api/v2.5/settings/aws_connectors"],
  ["OAuth exchange", "qux.health.list", undefined, "/api/v2.5/oauth2/token"],
  ["another read operation", "qux.health.list", undefined, "/api/v2.5/hosts"],
  ["unsupported query", "qux.health.list", undefined, "/api/v2.5/health?fresh=true"],
  ["encoded unsupported query", "qux.health.list", undefined, "/api/v2.5/health?%66resh=true"],
  ["normalized traversal", "qux.health.list", undefined, "/api/v2.5/health/../sensor_token"],
  ["encoded route", "qux.health.list", undefined, "/api/v2.5/%73ensor_token"],
  ["different detection", "qux.detection.show", { id: 7 }, "/api/v2.5/detections/8"],
  ["different host", "qux.host.show", { id: 7 }, "/api/v2.5/hosts/8"],
  ["different account", "qux.account.show", { id: 7 }, "/api/v2.5/accounts/8"],
  ["different note owner", "qux.host.note.list", { id: 7 }, "/api/v2.5/hosts/8/notes"],
  ["different tag owner", "qux.account.tag.list", { id: 7 }, "/api/v2.5/tagging/account/8"],
  ["different group", "qux.group.member.list", { id: 7 }, "/api/v2.5/groups/8/members?page=2"],
  ["different health check", "qux.health.show", { check: "cpu" }, "/api/v2.5/health/disk"],
  ["unsupported entity query", "qux.entity.host.list", undefined, "/api/v2.5/hosts?ordering=-id"],
];

it.each(deniedDestinations)("rejects a redirect to %s before forwarding credentials", async (_name, operation, pathParams, location) => {
  const transport = vi.fn<RawTransport>().mockResolvedValueOnce({ status: 302, location, bodyText: "" });
  await expect(session(transport).request(operation, { pathParams })).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each(deniedDestinations)("rejects a continuation to %s without fetching it", (_name, operation, pathParams, next) => {
  const transport = vi.fn<RawTransport>();
  expect(() => session(transport).resolveContinuation(operation, next, { pathParams }))
    .toThrow(expect.objectContaining({ code: "DESTINATION_DENIED" }));
  expect(transport).not.toHaveBeenCalled();
});

it("checks every redirect hop against the original operation", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 302, location: "?cache=true", bodyText: "" })
    .mockResolvedValueOnce({ status: 302, location: "/api/v2.5/sensor_token", bodyText: "" });
  await expect(session(transport).request("qux.health.list")).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(transport).toHaveBeenCalledTimes(2);
});

it("follows a redirect within the same bound resource with declared query keys", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 302, location: "?page=2", bodyText: "" })
    .mockResolvedValueOnce(ok({ results: [] }));
  expect(await session(transport).request("qux.group.member.list", { pathParams: { id: "synthetic#7" } }))
    .toEqual({ status: 200, body: { results: [] } });
  expect(transport.mock.calls[1]![0]).toMatchObject({
    url: "https://fixture.invalid/api/v2.5/groups/synthetic%237/members?page=2",
    headers: { Authorization: `Token ${token}` },
  });
});

it("validates a continuation within the original bound resource", () => {
  expect(session(vi.fn<RawTransport>()).resolveContinuation(
    "qux.group.member.list", "/api/v2.5/groups/synthetic%237/members?page=2", { pathParams: { id: "synthetic#7" } },
  )).toBe("https://fixture.invalid/api/v2.5/groups/synthetic%237/members?page=2");
});

it("requires original path parameters to validate a parameterized continuation", () => {
  expect(() => session(vi.fn<RawTransport>()).resolveContinuation("qux.group.member.list", "/api/v2.5/groups/7/members?page=2"))
    .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
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

it("exposes a cloud snapshot with no appliance release", () => {
  const owned = session(vi.fn<RawTransport>(), ruxProfile);
  expect(owned.profile).toEqual({ name: "lab", kind: "rux",
    origin: "https://fixture.invalid", apiVersion: "3.4" });
  expect("applianceRelease" in owned.profile).toBe(false);
});

it("exposes no raw transport, fetch handle or credential material", async () => {
  const owned = session(vi.fn<RawTransport>().mockResolvedValue(ok({})));
  expect(Object.keys(owned).sort()).toEqual(["profile", "request", "resolveContinuation"]);
  expect(owned.profile).toEqual({ name: "lab", kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5" });
  expect("transport" in owned && "fetch" in owned).toBe(false);
  expect(JSON.stringify(owned)).not.toContain(token);
});

it("accepts a single trailing-slash variation but refuses a different RUX route", () => {
  const owned = session(vi.fn<RawTransport>(), ruxProfile);
  expect(owned.resolveContinuation("rux.detection.list", "/api/v3.4/detections?page=2"))
    .toBe("https://fixture.invalid/api/v3.4/detections?page=2");
  const transport = vi.fn<RawTransport>();
  expect(() => session(transport, ruxProfile).resolveContinuation("rux.detection.list", "/api/v3.4/hosts/?page=2"))
    .toThrow(expect.objectContaining({ code: "DESTINATION_DENIED" }));
  expect(transport).not.toHaveBeenCalled();
});
