import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runProxyRead, runProxyWrite } from "../src/proxies.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".proxies-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
beforeEach(() => {
  vi.stubEnv("SYNTHETIC_TOKEN", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(auditPath, { force: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const proxy = { id: "proxy-1", address: "192.0.2.10", considerProxy: true, source: "user",
  createdAt: "2026-01-01T00:00:00Z", lastUpdatedAt: "2026-01-01T00:00:00Z" };
const envelope = (rows: unknown[]) => ({ meta: { count: rows.length }, proxies: rows });
const input = ["--address", "192.0.2.10", "--consider", "true"];
const confirm = ["--execute", "--confirm", "proxy proxy-1"];
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

function harness(options: {
  kind?: "qux" | "rux"; state?: (url: string) => unknown;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean;
} = {}) {
  const kind = options.kind ?? "qux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true,
      operations: ["create", "edit", "delete"].map((action) => `${kind}.proxy.${action}`) },
  } } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config, "lab");
  const seen: { method: string; url: string; body?: string }[] = [];
  const transport: RawTransport = async (request) => {
    if (request.url.endsWith("/oauth2/token")) return {
      status: 200, bodyText: JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }),
    };
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET") return { status: 200, bodyText: JSON.stringify(options.state
      ? options.state(request.url) : envelope(request.url.includes("proxy-1") ? [proxy] : [])) };
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return { seen,
    read: (action: "list" | "show", args: string[] = []) => runProxyRead(session,
      new Map(parseInvocation(["proxy", action, ...args]).flags), action),
    run: (action: "create" | "edit" | "delete", args: string[]) => runProxyWrite(session, coordinator,
      new Map(parseInvocation(["proxy", action, ...args]).flags), action),
  };
}

it.each(["qux", "rux"] as const)("reads the proxy envelope and string ID on %s", async (kind) => {
  const { read, seen } = harness({ kind, state: () => envelope([proxy]) });
  expect((await read("list")).output).toMatchObject({ count: 1, proxies: [
    { id: "proxy-1", address: "192.0.2.10", considerProxy: true, source: "user" },
  ] });
  expect((await read("show", ["--id", "proxy-1"])).output).toMatchObject(proxy);
  const base = `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/proxies`;
  expect(seen).toEqual([{ method: "GET", url: base + (kind === "rux" ? "/" : "") },
    { method: "GET", url: base + "/proxy-1" + (kind === "rux" ? "/" : "") }]);
});

it("reports an explicit empty proxy list", async () => {
  expect((await harness().read("list")).output).toMatchObject({ count: 0, proxies: [], help: ["No proxies are defined on this instance"] });
});

it.each(["qux", "rux"] as const)("previews then sends the exact create body on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  expect((await run("create", input)).output.warning).toBe("Proxy settings affect detection attribution.");
  expect(seen.map((call) => call.method)).toEqual(["GET"]);
  seen.length = 0;
  await run("create", [...input, "--execute", "--confirm", "new proxy 192.0.2.10"]);
  const url = `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/proxies${kind === "rux" ? "/" : ""}`;
  expect(seen).toEqual([{ method: "GET", url }, { method: "GET", url },
    { method: "POST", url, body: JSON.stringify({ proxy: { address: "192.0.2.10", considerProxy: true } }) }]);
  expect(journal().map((row) => row.kind)).toEqual(["intent", "outcome"]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/considerProxy|payload|synthetic-secret|synthetic-access/);
});

it.each(["qux", "rux"] as const)("sends only supplied edit fields on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  await run("edit", ["--id", "proxy-1", "--consider", "false", ...confirm]);
  expect(seen.map((call) => call.method)).toEqual(["GET", "GET", "PATCH"]);
  expect(seen.at(-1)).toEqual({ method: "PATCH",
    url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/proxies/proxy-1${kind === "rux" ? "/" : ""}`,
    body: JSON.stringify({ proxy: { considerProxy: false } }) });
});

it("deletes a RUX proxy after two reads", async () => {
  const { run, seen } = harness({ kind: "rux" });
  await run("delete", ["--id", "proxy-1", ...confirm]);
  expect(seen.map((call) => call.method)).toEqual(["GET", "GET", "DELETE"]);
  expect(seen.at(-1)).toEqual({ method: "DELETE", url: "https://fixture.invalid/api/v3.4/proxies/proxy-1/" });
});

it("refuses unsupported QUX deletion before HTTP", async () => {
  const { run, seen } = harness();
  await expect(run("delete", ["--id", "proxy-1", ...confirm])).rejects.toMatchObject({ code: "OPERATION_NOT_WRITABLE" });
  expect(seen).toEqual([]);
});

it.each([
  [{ allowWrites: false, operations: ["qux.proxy.create"] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["qux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses write policy %j", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run("create", input)).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("forced read-only overrides opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run("create", input)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"], [["--execute", "--confirm", "other"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run("create", [...input, ...args])).rejects.toMatchObject({ code });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)(
  "journals rejection or timeout without replay %s %s", async (status, timeout, outcome) => {
    const { run, seen } = harness({ status, timeout });
    expect((await run("create", [...input, "--execute", "--confirm", "new proxy 192.0.2.10"])).failed).toBe(true);
    expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(journal().at(-1)).toMatchObject({ outcome });
  });

it.each([
  ["create", []], ["create", ["--address", "example.invalid", "--consider", "true"]],
  ["create", ["--address", "192.0.2.10", "--consider", "yes"]], ["edit", ["--id", "proxy-1"]],
  ["edit", ["--id", "../bad", "--consider", "false"]],
] as const)("refuses invalid %s input %j before HTTP", async (action, args) => {
  const { run, seen } = harness();
  await expect(run(action, [...args])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each(["create", "edit"] as const)("skips %s when the desired state exists", async (action) => {
  const { run, seen } = harness({ state: () => envelope([proxy]) });
  const args = action === "create" ? [...input, "--execute", "--confirm", "new proxy 192.0.2.10"]
    : ["--id", "proxy-1", "--consider", "true", ...confirm];
  expect((await run(action, args)).output.state).toContain("no-op");
  expect(seen.map((call) => call.method)).toEqual(["GET"]);
});

it.each(["edit", "delete"] as const)("refuses %s of an auto-detected proxy", async (action) => {
  const { run, seen } = harness({ kind: "rux", state: () => envelope([{ ...proxy, source: "Cognito" }]) });
  await expect(run(action, ["--id", "proxy-1", ...(action === "edit" ? ["--consider", "false"] : []), ...confirm]))
    .rejects.toMatchObject({ code: "PROXY_NOT_WRITABLE" });
  expect(seen.map((call) => call.method)).toEqual(["GET"]);
});

it.each([
  [{ ...proxy, address: "192.0.2.11" }, "VERSION_CONFLICT"],
  [{ ...proxy, source: "Cognito" }, "PROXY_NOT_WRITABLE"],
  [{ ...proxy, considerProxy: null }, "MALFORMED_RESPONSE"],
] as const)("refuses changed or unsafe pre-send state %j", async (fresh, code) => {
  let reads = 0;
  const { run, seen } = harness({ state: () => envelope([++reads === 1 ? proxy : fresh]) });
  await expect(run("edit", ["--id", "proxy-1", "--consider", "false", ...confirm])).rejects.toMatchObject({ code });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});

it("refuses a concurrent create for the address with different settings", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => envelope(++reads === 1 ? [] : [{ ...proxy, considerProxy: false }]) });
  await expect(run("create", [...input, "--execute", "--confirm", "new proxy 192.0.2.10"]))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it.each([
  {}, { meta: { count: 2 }, proxies: [proxy] }, envelope([{ ...proxy, id: 7 }]), envelope([proxy, proxy]),
])("refuses malformed proxy read envelopes %j", async (state) => {
  await expect(harness({ state: () => state }).read("list")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
});

it("refuses a show response for a different ID", async () => {
  await expect(harness({ state: () => envelope([{ ...proxy, id: "other" }]) }).read("show", ["--id", "proxy-1"]))
    .rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
});
