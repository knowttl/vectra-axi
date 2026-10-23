import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runInternalNetworkRead, runInternalNetworkSet } from "../src/settings.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".settings-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const operation = "qux.setting.internal-network.set";
const empty = { included_subnets: [], excluded_subnets: [], dropped_subnets: [] };
const desired = { include: ["198.51.100.0/24"], exclude: [], drop: [] };
const input = ["--include", "198.51.100.0/24", "--exclude", "none", "--drop", "none"];
const execute = ["--execute", "--confirm", "internal network"];
beforeEach(() => {
  vi.stubEnv("SYNTHETIC_TOKEN", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(auditPath, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function harness(options: {
  kind?: "qux" | "rux"; state?: () => unknown;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean; readStatus?: number;
} = {}) {
  const kind = options.kind ?? "qux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true, operations: [operation] },
  } } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config, "lab");
  const seen: { method: string; url: string; body?: string }[] = [];
  const transport: RawTransport = async (request) => {
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET") return {
      status: options.readStatus ?? 200, bodyText: JSON.stringify(options.state ? options.state() : empty),
    };
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return {
    seen, read: () => runInternalNetworkRead(session),
    run: (args: string[] = input) => runInternalNetworkSet(session, coordinator,
      new Map(parseInvocation(["setting", "internal-network", "set", ...args]).flags)),
  };
}
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

it("reads the reviewed QUX settings route", async () => {
  const { read, seen } = harness();
  expect((await read()).output).toEqual({ profile: "lab", include: [], exclude: [], drop: [] });
  expect(seen).toEqual([{ method: "GET", url: "https://fixture.invalid/api/v2.5/settings/internal_network" }]);
});

it("previews the high-risk before/after diff then replaces all lists once", async () => {
  const { run, seen } = harness();
  expect((await run()).output).toMatchObject({
    before: { include: [], exclude: [], drop: [] }, after: desired,
    warning: "High risk: changes what is monitored or dropped across the appliance.",
  });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect((await run([...input, ...execute])).failed).toBe(false);
  expect(seen.filter((call) => call.method === "POST")).toEqual([
    { method: "POST", url: "https://fixture.invalid/api/v2.5/settings/internal_network", body: JSON.stringify(desired) },
  ]);
  expect(seen.filter((call) => call.method === "GET")).toHaveLength(3);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/include|exclude|drop|198\.51|payload|synthetic-secret/);
});

it("normalizes IPv6 and ignores duplicate entries and list ordering for no-op", async () => {
  const { run, seen } = harness({ state: () => ({ ...empty,
    included_subnets: ["2001:db8::/32", "198.51.100.0/24"],
  }) });
  const args = ["--include", "198.51.100.0/24,2001:0db8::/32,198.51.100.0/24", "--exclude", "none", "--drop", "none"];
  expect((await run(args)).output).toMatchObject({ state: expect.stringContaining("no-op") });
  expect((await run([...args, ...execute])).output).toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it("sends nonempty exclude and drop lists", async () => {
  const { run, seen } = harness();
  await run(["--include", "none", "--exclude", "192.0.2.0/24", "--drop", "203.0.113.0/24", ...execute]);
  expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ include: [], exclude: ["192.0.2.0/24"], drop: ["203.0.113.0/24"] });
});

it.each([
  ["0.0.0.0/0", "0.0.0.0/0"], ["198.51.100.7/32", "198.51.100.7/32"],
  ["::/0", "::/0"], ["2001:0DB8::7/128", "2001:db8::7/128"],
  ["2001:db8:0:0:0:0:0:0/32", "2001:db8::/32"],
])("previews valid boundary CIDR %s", async (value, normalized) => {
  const { run, seen } = harness();
  expect((await run(["--include", value, "--exclude", "none", "--drop", "none"])).output)
    .toMatchObject({ after: { include: [normalized] } });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it.each(["198.51.100.1/24", "198.51.100.0/33", "198.51.100.0", "999.1.1.0/24", "2001:db8::1/32", "2001:db8::/129", "fe80::%eth0/64", "198.51.100.0/-1", "198.51.100.0/24,", "none,198.51.100.0/24"])("refuses invalid CIDR %s before any request", async (value) => {
  const { run, seen } = harness();
  await expect(run(["--include", value, "--exclude", "none", "--drop", "none", ...execute])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it("requires every desired-state list", async () => {
  const { run, seen } = harness();
  await expect(run(["--include", "198.51.100.0/24"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it("refuses RUX reads and writes before any request", async () => {
  const { read, run, seen } = harness({ kind: "rux" });
  await expect(read()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  await expect(run()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  expect(seen).toEqual([]);
});

it.each([
  [{ allowWrites: false, operations: [operation] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["qux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses disallowed profile writes %j", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("lets forced read-only override opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"],
  [["--execute", "--confirm", "other network"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run([...input, ...args])).rejects.toMatchObject({ code });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it.each([null, {}, { ...empty, dropped_subnets: "203.0.113.0/24" }, { ...empty, included_subnets: ["invalid"] }])("refuses malformed settings %j", async (state) => {
  const { run, seen } = harness({ state: () => state });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it("refuses a denied settings read without sending", async () => {
  const { run, seen } = harness({ readStatus: 403 });
  await expect(run([...input, ...execute])).rejects.toBeDefined();
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it("refuses a concurrent settings change", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ++reads === 1 ? empty : { ...empty, dropped_subnets: ["203.0.113.0/24"] } });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});

it.each([
  [403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"],
] as const)("journals failure or ambiguity without replay %s %s", async (status, timeout, outcome) => {
  const { run, seen } = harness({ status, timeout });
  expect((await run([...input, ...execute])).failed).toBe(true);
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(journal().at(-1)).toMatchObject({ outcome });
});
