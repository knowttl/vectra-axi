import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runDetectionTriage } from "../src/detection-triage.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".detection-triage-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
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
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean;
} = {}) {
  const kind = options.kind ?? "rux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true, operations: [`${kind}.detection.triage.set`, `${kind}.detection.triage.clear`] },
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
    if (request.method === "GET") return {
      status: 200, bodyText: JSON.stringify({ id: Number(new URL(request.url).pathname.split("/").filter(Boolean).at(-1)),
        is_triaged: options.state ? options.state() : false }),
    };
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return {
    seen,
    run: async (action: "set" | "clear", args: string[]) => runDetectionTriage(session, coordinator,
      new Map(parseInvocation(["detection", "triage", action, ...args]).flags), action),
  };
}
const input = ["--ids", "41", "--category", "synthetic-triage"];
const execute = ["--execute", "--confirm", "1 target: detection 41"];
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

it.each([
  ["rux", "set", "POST"], ["rux", "clear", "DELETE"],
  ["qux", "set", "POST"], ["qux", "clear", "DELETE"],
] as const)("previews then sends %s triage %s", async (kind, action, method) => {
  const { run, seen } = harness({ kind });
  const args = action === "set" ? input : ["--ids", "41"];
  const payload = { detectionIdList: [41], ...(action === "set" ? { triage_category: "synthetic-triage" } : {}) };
  expect((await run(action, args)).output).toMatchObject({ proposed: payload, scoring: expect.stringContaining("suppresses scoring") });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect((await run(action, [...args, ...execute])).failed).toBe(false);
  expect(seen.filter((call) => call.method !== "GET")).toEqual([
    { method, url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/rules${kind === "rux" ? "/" : ""}`, body: JSON.stringify(payload) },
  ]);
  expect(seen.filter((call) => call.method === "GET")).toHaveLength(3);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/triage_category|synthetic-triage|payload|synthetic-secret|synthetic-access/);
});

it("normalizes and confirms the complete target set", async () => {
  const { run, seen } = harness();
  expect((await run("clear", ["--ids", "42,41,42", "--execute", "--confirm", "2 targets: detection 41, detection 42"])).failed).toBe(false);
  expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ detectionIdList: [41, 42] });
});

it.each([
  [{ allowWrites: false, operations: ["rux.detection.triage.set"] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["rux.detection.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses disallowed profile writes %j", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run("set", [...input, ...execute])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("lets forced read-only override opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run("set", [...input, ...execute])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"],
  [["--execute", "--confirm", "detection 41"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run("set", [...input, ...args])).rejects.toMatchObject({ code });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it.each([
  [], ["--ids", "0"], ["--ids", "9007199254740992"], ["--ids", "41,"],
  ["--ids", "41"], ["--ids", "41", "--category", " "],
  ["--ids", Array.from({ length: 101 }, (_, index) => index + 1).join(",")],
].map((args) => ({ args })))("refuses invalid input $args", async ({ args }) => {
  const { run, seen } = harness();
  await expect(run("set", args)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([undefined, null, 1, "unknown"])("refuses malformed state %s", async (state) => {
  const { run, seen } = harness({ state: () => state });
  await expect(run("set", [...input, ...execute])).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)("journals failure or ambiguity without replay %s %s", async (status, timeout, outcome) => {
  const { run, seen } = harness({ status, timeout });
  expect((await run("set", [...input, ...execute])).failed).toBe(true);
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(journal().at(-1)).toMatchObject({ outcome });
});

it("refuses a concurrent triage-state change", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ++reads > 1 });
  await expect(run("set", [...input, ...execute])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});
