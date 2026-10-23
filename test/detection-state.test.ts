import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runDetectionState } from "../src/detection-state.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".detection-state-test-"));
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
  kind?: "qux" | "rux"; state?: (id: number) => unknown; fixed?: (id: number) => unknown; release?: string;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean;
} = {}) {
  const kind = options.kind ?? "qux";
  const profile = {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    ...(options.release ? { applianceRelease: options.release } : {}),
    writes: options.writes ?? { allowWrites: true,
      operations: ["close", "close-bulk", "open", "open-bulk", "fixed.set"].map((action) => `${kind}.detection.${action}`) },
  };
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: profile } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const selected = selectProfile(loaded.config, "lab");
  const seen: { method: string; url: string; body?: string }[] = [];
  const transport: RawTransport = async (request) => {
    if (request.url.endsWith("/oauth2/token")) return {
      status: 200, bodyText: JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }),
    };
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET") {
      const id = Number(new URL(request.url).pathname.split("/").filter(Boolean).at(-1));
      const fixed = options.fixed?.(id);
      return { status: 200, bodyText: JSON.stringify({ id, state: options.fixed
        ? typeof fixed === "boolean" ? fixed ? "fixed" : "active" : fixed
        : options.state?.(id) ?? "active" }) };
    }
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile: selected, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile: selected, configPath, redactor, transport, auditPath });
  return {
    seen,
    run: (action: "close" | "open" | "fixed set", args: string[] = []) => runDetectionState(
      session, coordinator, new Map(parseInvocation(["detection", ...action.split(" "), ...args]).flags), action),
  };
}
const execute = ["--execute", "--confirm", "detection 42"];
const close = ["--id", "42", "--reason", "benign"];
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

it("previews legacy scoring effects and marks a normalized QUX bulk set", async () => {
  const { run, seen } = harness({ release: "9.2" });
  const args = ["--ids", "42,41,42", "--value", "true"];
  expect((await run("fixed set", args)).output).toMatchObject({
    desired: true, proposed: { detectionIdList: [41, 42], mark_as_fixed: true },
    warning: expect.stringContaining("zeroes detection scores"),
  });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  await run("fixed set", [...args, "--execute", "--confirm", "2 targets: detection 41, detection 42"]);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/detections",
      body: '{"detectionIdList":[41,42],"mark_as_fixed":true}' },
  ]);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/mark_as_fixed|detectionIdList|payload|synthetic-secret/);
});

it.each([
  ["qux", "--id", "42", "/api/v2.5/detections", { detectionIdList: [42], mark_as_fixed: false }],
  ["rux", "--id", "42", "/api/v3.4/detections/42/", { mark_as_fixed: false }],
  ["rux", "--ids", "41,42", "/api/v3.4/detections/", { detectionIdList: [41, 42], mark_as_fixed: false }],
] as const)("unmarks %s %s via its evidenced route", async (kind, flag, ids, path, payload) => {
  const { run, seen } = harness({ kind, fixed: () => true });
  await run("fixed set", [flag, ids, "--value", "false", "--execute", "--confirm",
    flag === "--id" ? "detection 42" : "2 targets: detection 41, detection 42"]);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: `https://fixture.invalid${path}`, body: JSON.stringify(payload) },
  ]);
  expect(seen.filter((call) => call.method === "GET")).toHaveLength(flag === "--id" ? 2 : 4);
});

it.each([true, false])("treats fixed=%s as a no-op when already desired", async (fixed) => {
  const { run, seen } = harness({ fixed: () => fixed });
  expect((await run("fixed set", ["--id", "42", "--value", String(fixed), ...execute])).output)
    .toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  [{ allowWrites: false, operations: ["qux.detection.fixed.set"] }, false, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["qux.detection.open"] }, false, "OPERATION_NOT_WRITABLE"],
  [{ allowWrites: true, operations: ["qux.detection.fixed.set"] }, true, "WRITES_DISABLED"],
] as const)("retains fixed-set policy refusals %j read-only=%s", async (writes, readOnly, code) => {
  if (readOnly) vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run("fixed set", ["--id", "42", "--value", "true", ...execute])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"],
  [["--execute", "--confirm", "detection 41"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses invalid fixed-set execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run("fixed set", ["--id", "42", "--value", "true", ...args])).rejects.toMatchObject({ code });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)(
  "reports fixed-set rejection or ambiguity without replay: %s %s", async (status, timeout, outcome) => {
    const { run, seen } = harness({ status, timeout });
    expect((await run("fixed set", ["--id", "42", "--value", "true", ...execute])).failed).toBe(true);
    expect(seen.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(journal().at(-1)).toMatchObject({ outcome });
  });

it.each([undefined, null, "", 0])("refuses malformed fixed state %s", async (fixed) => {
  const { run, seen } = harness({ fixed: () => fixed });
  await expect(run("fixed set", ["--id", "42", "--value", "true", ...execute]))
    .rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  ["--id", "42"], ["--id", "42", "--value", "yes"],
  ["--id", "42", "--ids", "41", "--value", "true"],
  ["--ids", "41,", "--value", "true"],
].map((args) => ({ args })))("refuses invalid fixed-set input $args", async ({ args }) => {
  const { run, seen } = harness();
  await expect(run("fixed set", args)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it("skips fixed-set when the pre-send read reaches the desired state", async () => {
  let reads = 0;
  const { run, seen } = harness({ fixed: () => ++reads > 1 });
  expect((await run("fixed set", ["--id", "42", "--value", "true", ...execute])).output)
    .toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});

it("previews then closes a QUX detection with the exact reason and journals metadata only", async () => {
  const { run, seen } = harness();
  expect((await run("close", close)).output).toMatchObject({ proposed: { reason: "benign" }, target: "detection 42" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect((await run("close", [...close, ...execute])).failed).toBe(false);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/detections/42/close", body: '{"reason":"benign"}' },
  ]);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/benign|payload|synthetic-secret/);
});

it("closes a normalized RUX bulk set with a single native PATCH", async () => {
  const { run, seen } = harness({ kind: "rux" });
  await run("close", ["--ids", "42,41,42", "--reason", "remediated", "--execute",
    "--confirm", "2 targets: detection 41, detection 42"]);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v3.4/detections/close/",
      body: '{"detectionIdList":[41,42],"reason":"remediated"}' },
  ]);
  expect(seen.filter((call) => call.method === "GET")).toHaveLength(4);
});

it.each(["qux", "rux"] as const)("opens a single %s detection without a payload", async (kind) => {
  const { run, seen } = harness({ kind, state: () => "closed" });
  await run("open", ["--id", "42", ...execute]);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/detections/42/open${kind === "rux" ? "/" : ""}` },
  ]);
});

it("opens a bulk set with only detectionIdList", async () => {
  const { run, seen } = harness({ state: () => "closed" });
  await run("open", ["--ids", "41,42", "--execute", "--confirm", "2 targets: detection 41, detection 42"]);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/detections/open", body: '{"detectionIdList":[41,42]}' },
  ]);
});

it.each([
  ["close", "closed"], ["open", "active"], ["open", "inactive"],
] as const)("treats %s on %s as a no-op", async (action, state) => {
  const { run, seen } = harness({ state: () => state });
  expect((await run(action, action === "close" ? [...close, ...execute] : ["--id", "42", ...execute])).output)
    .toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method !== "GET")).toEqual([]);
});

it("refuses QUX 9.2 before any request", async () => {
  const { run, seen } = harness({ release: "9.2" });
  await expect(run("close", [...close, ...execute])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  { allowWrites: false, operations: ["qux.detection.close"] },
  { allowWrites: true, operations: ["qux.detection.open"] },
])("refuses disallowed profile writes before any request: %j", async (writes) => {
  const { run, seen } = harness({ writes });
  await expect(run("close", [...close, ...execute])).rejects.toMatchObject({
    code: writes.allowWrites ? "OPERATION_NOT_WRITABLE" : "WRITES_DISABLED",
  });
  expect(seen).toEqual([]);
});

it("lets the read-only environment override profile opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run("close", [...close, ...execute])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"],
  [["--execute", "--confirm", "detection 41"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses invalid execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run("close", [...close, ...args])).rejects.toMatchObject({ code });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  [], ["--id", "42", "--ids", "41"], ["--id", "0"], ["--ids", "41,"],
  ["--id", "41,42"], ["--id", "9007199254740992"], ["--id", "42", "--reason", "other"],
  ["--ids", Array.from({ length: 101 }, (_, index) => index + 1).join(",")],
].map((args) => ({ args })))("refuses invalid close input $args", async ({ args }) => {
  const { run, seen } = harness();
  await expect(run("close", args)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  [403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"],
] as const)("reports failure or ambiguity without replay: %s %s", async (status, timeout, outcome) => {
  const { run, seen } = harness({ status, timeout });
  expect((await run("close", [...close, ...execute])).failed).toBe(true);
  expect(seen.filter((call) => call.method === "PATCH")).toHaveLength(1);
  expect(journal().at(-1)).toMatchObject({ outcome });
});

it("refuses malformed state before sending", async () => {
  const { run, seen } = harness({ state: () => 7 });
  await expect(run("close", [...close, ...execute])).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it("re-reads and skips a detection closed before the send", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ++reads === 1 ? "active" : "closed" });
  expect((await run("close", [...close, ...execute])).output).toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});
