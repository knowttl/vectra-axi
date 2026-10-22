import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { parseInvocation } from "../src/catalogue.js";
import { main } from "../src/cli.js";
import { runEntityClose } from "../src/entity-close.js";
import type { EntityKind } from "../src/entities.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".entity-close-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const enabled = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN", writes: { allowWrites: true, operations: ["qux.host.close", "qux.account.close"] } };
type Call = { method: string; url: string; body?: string };

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", "synthetic-token");
  vi.stubEnv("CLOUD_SECRET", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
  vi.stubEnv("VECTRA_AXI_WRITE_LOG", auditPath);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
  rmSync(auditPath, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function harness(options: {
  profile?: Record<string, unknown>; status?: number; timeout?: boolean;
  entity?: unknown; detection?: unknown; changed?: boolean; readStatus?: number;
} = {}) {
  const calls: Call[] = [];
  let entityReads = 0;
  const transport: RawTransport = async (request) => {
    if (request.url.endsWith("/oauth2/token")) return { status: 200,
      bodyText: JSON.stringify({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600 }) };
    calls.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "PATCH") {
      if (options.timeout) throw new Error("socket timed out");
      return { status: options.status ?? 200, bodyText: "{}" };
    }
    const isDetection = request.url.includes("/detections/");
    if (!isDetection) entityReads++;
    const body = isDetection
      ? options.detection ?? { id: 42, state: options.changed && entityReads > 1 ? "closed" : "active" }
      : options.entity ?? { id: 7, detection_set: ["https://fixture.invalid/api/v3/detections/42"] };
    return { status: options.readStatus ?? 200, bodyText: JSON.stringify(body) };
  };
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: options.profile ?? enabled } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config, "lab");
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  const run = (extra: string[] = [], kind: EntityKind = "host", reason = "remediated") => runEntityClose(session, coordinator,
    parseInvocation([kind, "close", "--id", "7", "--reason", reason, ...extra]).flags, kind);
  return { run, calls, transport, session };
}
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

it("previews the affected active detection count without a mutation or journal", async () => {
  const { run, calls } = harness();
  expect(await run()).toMatchObject({ failed: false, output: {
    activeDetections: 1, effect: "disruptive", reason: "remediated",
    help: ["Re-run with --execute --confirm 'host 7' to close host 7"],
  } });
  expect(calls.map(({ method, url }) => [method, url])).toEqual([
    ["GET", "https://fixture.invalid/api/v2.5/hosts/7"],
    ["GET", "https://fixture.invalid/api/v2.5/detections/42"],
  ]);
  expect(() => journal()).toThrow();
});

it("sends exactly the host close body after a pre-send re-read and journals metadata only", async () => {
  const { run, calls } = harness();
  expect(await run(["--execute", "--confirm", "host 7"])).toMatchObject({ failed: false });
  expect(calls.filter(({ method }) => method === "GET")).toHaveLength(4);
  expect(calls.filter(({ method }) => method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/hosts/7/close", body: '{"reason":"remediated"}' },
  ]);
  expect(journal()).toEqual([
    expect.objectContaining({ kind: "intent", target: "host 7", effect: "disruptive" }),
    expect.objectContaining({ kind: "outcome", outcome: "SUCCESS" }),
  ]);
  const text = readFileSync(auditPath, "utf8");
  expect(text).not.toContain("remediated");
  expect(text).not.toContain("synthetic-token");
  expect(text).not.toContain("detectionIds");
});

it.each(["host", "account"] as const)("uses the documented RUX %s close slash convention", async (kind) => {
  const { run, calls } = harness({ profile: { kind: "rux", origin: "https://fixture.invalid", apiVersion: "3.4",
    auth: "oauth", clientId: "synthetic-client", secretEnv: "CLOUD_SECRET",
    writes: { allowWrites: true, operations: [`rux.${kind}.close`] } } });
  await run(["--execute", "--confirm", `${kind} 7`], kind);
  expect(calls.filter(({ method }) => method === "PATCH")).toEqual([
    { method: "PATCH", url: `https://fixture.invalid/api/v3.4/${kind}s/7/close${kind === "host" ? "/" : ""}`,
      body: '{"reason":"remediated"}' },
  ]);
});

it.each([
  ["without opt-in", { ...enabled, writes: undefined }, undefined, [], "WRITES_DISABLED"],
  ["forced read-only", enabled, "1", [], "WRITES_DISABLED"],
  ["outside allowlist", { ...enabled, writes: { allowWrites: true, operations: ["qux.account.close"] } }, undefined, [], "OPERATION_NOT_WRITABLE"],
  ["without confirmation", enabled, undefined, ["--execute"], "CONFIRM_REQUIRED"],
  ["wrong confirmation", enabled, undefined, ["--execute", "--confirm", "account 7"], "CONFIRM_MISMATCH"],
] as const)("refuses %s without sending", async (_name, profile, readOnly, extra, code) => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", readOnly);
  const { run, calls } = harness({ profile });
  await expect(run([...extra])).rejects.toMatchObject({ code });
  expect(calls.some(({ method }) => method === "PATCH")).toBe(false);
  expect(() => journal()).toThrow();
});

it.each([
  ["server reject", { status: 400 }, "FAILED"],
  ["timeout", { timeout: true }, "OUTCOME_UNKNOWN"],
] as const)("journals %s without replay", async (_name, options, outcome) => {
  const { run, calls } = harness(options);
  expect(await run(["--execute", "--confirm", "host 7"])).toMatchObject({ failed: true });
  expect(calls.filter(({ method }) => method === "PATCH")).toHaveLength(1);
  expect(journal()[1]).toMatchObject({ outcome });
});

it("refuses declared QUX releases below 9.3 before reading", async () => {
  const { run, calls } = harness({ profile: { ...enabled, applianceRelease: "9.2" } });
  await expect(run()).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("9.3") });
  expect(calls).toEqual([]);
});

it("accepts QUX release 9.3 and benign reason", async () => {
  const { run } = harness({ profile: { ...enabled, applianceRelease: "9.3" } });
  expect(await run([], "host", "benign")).toMatchObject({ output: { reason: "benign" } });
});

it.each([
  ["oversized detection set", { entity: { id: 7, detection_set: Array.from({ length: 101 }, (_, i) => i + 1) } }, "VALIDATION_ERROR"],
  ["missing detection set", { entity: { id: 7 } }, "RESPONSE_INVALID"],
  ["malformed detection", { detection: { id: 42 } }, "RESPONSE_INVALID"],
  ["denied read", { readStatus: 403 }, "ACCESS_DENIED"],
  ["changed active detections", { changed: true }, "VERSION_CONFLICT"],
] as const)("refuses %s before sending", async (_name, options, code) => {
  const { run, calls } = harness(options);
  await expect(run(["--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code });
  expect(calls.some(({ method }) => method === "PATCH")).toBe(false);
});

it("counts closed detections as unaffected", async () => {
  const { run } = harness({ detection: { id: 42, state: "closed" } });
  expect(await run()).toMatchObject({ output: { activeDetections: 0 } });
});

it.each([
  ["missing reason", ["host", "close", "--id", "7"]],
  ["invalid reason", ["host", "close", "--id", "7", "--reason", "other"]],
  ["invalid id", ["host", "close", "--id", "0", "--reason", "benign"]],
  ["combined execute and dry-run", ["host", "close", "--id", "7", "--reason", "benign", "--execute", "--dry-run"]],
])("rejects %s before any HTTP call", async (_name, argv) => {
  const { transport, calls } = harness();
  const redactor = new SecretRedactor();
  const profile = selectProfile(loadConfig(configPath, redactor).config, "lab");
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  await expect(runEntityClose(session, coordinator, parseInvocation(argv).flags, "host"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toEqual([]);
});

it("dispatches close through the CLI with the selected profile", async () => {
  const { transport, calls } = harness();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await main(["host", "close", "--config", configPath, "--profile", "lab", "--id", "7", "--reason", "remediated"], transport);
  expect(decode(stdout.mock.calls.map(([chunk]) => chunk).join(""))).toMatchObject({ activeDetections: 1, operation: "qux.host.close" });
  expect(calls.some(({ method }) => method === "PATCH")).toBe(false);
});
