import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runTriageRuleWrite } from "../src/triage-rule-write.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".triage-rule-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const rulePath = join(scratch, "rule.json");
const operand = { field: "host", label: "Host", values: [{ value: 7, label: "Example host" }], groups: [] };
const desired = {
  description: "Example rule", detection_category: "COMMAND & CONTROL", triage_category: "Example category",
  detection: "Example detection", is_whitelist: false,
  source_conditions: { OR: [{ AND: [{ ANY_OF: operand }, { NONE_OF: operand }] }] }, additional_conditions: null,
};
const current = { ...desired, id: 7, enabled: true, description: "Previous description", extra: "Retain in preview" };
type Action = "create" | "edit" | "delete";
beforeEach(() => {
  vi.stubEnv("SYNTHETIC_TOKEN", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(auditPath, { force: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function harness(options: {
  kind?: "qux" | "rux"; state?: () => unknown;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean;
} = {}) {
  const kind = options.kind ?? "qux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true,
      operations: ["create", "edit", "delete"].map((action) => `${kind}.triage-rule.${action}`) },
  } } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config, "lab");
  const seen: { method: string; url: string; body?: string }[] = [];
  const transport: RawTransport = async (request) => {
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.url.endsWith("/oauth2/token")) return {
      status: 200, bodyText: JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }),
    };
    if (request.method === "GET") return { status: 200, bodyText: JSON.stringify(options.state ? options.state() : current) };
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return { seen, run: async (action: Action, args: string[], input = JSON.stringify(desired)) =>
    runTriageRuleWrite(session, coordinator,
      new Map(parseInvocation(["triage", "rule", action, ...args]).flags), action, () => input) };
}
const input = ["--rule-file", "-"];
const confirm = ["--execute", "--confirm", "triage rule 7"];
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

it.each(["qux", "rux"] as const)("sends exact create, full replacement and delete requests on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  await run("create", [...input, "--execute", "--confirm", "new triage rule"]);
  await run("edit", ["--id", "7", ...input, ...confirm]);
  await run("delete", ["--id", "7", ...confirm]);
  const base = `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/rules`;
  const slash = kind === "rux" ? "/" : "";
  expect(seen.filter((call) => call.method !== "GET" && !call.url.endsWith("/oauth2/token"))).toEqual([
    { method: "POST", url: base + slash, body: JSON.stringify(desired) },
    { method: "PUT", url: base + "/7" + slash, body: JSON.stringify(desired) },
    { method: "DELETE", url: base + "/7" + slash },
  ]);
  expect(seen.filter((call) => call.method === "GET")).toEqual(Array(4).fill({ method: "GET", url: base + "/7" + slash }));
  expect(journal().map((row) => row.kind)).toEqual(["intent", "outcome", "intent", "outcome", "intent", "outcome"]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/Example|description|conditions|payload|synthetic-secret|synthetic-access/);
});

it("previews full before/after documents and org-wide risk without mutations", async () => {
  const { run, seen } = harness();
  expect((await run("create", input)).output).toMatchObject({ before: null, after: desired, risk: expect.stringContaining("org-wide") });
  expect((await run("edit", ["--id", "7", ...input])).output).toMatchObject({ before: current, after: desired });
  expect((await run("delete", ["--id", "7"])).output).toMatchObject({ before: current, after: null });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it("reads a complete JSON rule from a file", async () => {
  writeFileSync(rulePath, JSON.stringify(desired));
  expect((await harness().run("create", ["--rule-file", rulePath])).output.after).toEqual(desired);
});

it.each([
  null, {}, { AND: [] }, { OR: [] }, { OR: [{ AND: [] }, { AND: [] }] },
  { OR: [{ ANY_OF: operand }] }, { OR: [{ AND: [{ OR: [] }] }] },
  { OR: [{ AND: [{ ANY_OF: operand, NONE_OF: operand }] }] },
  { OR: [{ AND: [{ ANY_OF: { ...operand, values: "wrong" } }] }] },
])("refuses malformed tree %j before any HTTP on RUX", async (source_conditions) => {
  const { run, seen } = harness({ kind: "rux" });
  const body = source_conditions === null ? { ...desired, additional_conditions: [] } : { ...desired, source_conditions };
  await expect(run("edit", ["--id", "7", ...input, ...confirm], JSON.stringify(body))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each(["not: json", "{", "[]", JSON.stringify({ detectionIdList: [41], triage_category: "Example" })])
("refuses invalid or per-detection documents %s before HTTP", async (body) => {
  const { run, seen } = harness();
  await expect(run("create", input, body)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  ["create", []], ["create", ["--rule-file", "/absent-rule.json"]],
  ["edit", input], ["delete", ["--id", "0"]], ["delete", ["--id", "9007199254740992"]],
] as const)("refuses invalid %s flags %j", async (action, args) => {
  const { run, seen } = harness();
  await expect(run(action, [...args])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each(["edit", "delete"] as const)("refuses a concurrent change before %s, even if it matches the proposed body", async (action) => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ++reads === 1 ? current : { ...desired, id: 7, enabled: true } });
  await expect(run(action, ["--id", "7", ...(action === "edit" ? input : []), ...confirm])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});

it.each([null, { ...current, id: 8 }, { ...current, enabled: null }])("refuses unsafe read response %j", async (state) => {
  const { run, seen } = harness({ state: () => state });
  await expect(run("delete", ["--id", "7", ...confirm])).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it.each([
  [{ allowWrites: false, operations: ["qux.triage-rule.create"] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["qux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses write policy %j before HTTP", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run("create", input)).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("forced read-only overrides opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run("delete", ["--id", "7", ...confirm])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"], [["--execute", "--confirm", "other"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run("create", [...input, ...args])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)
("journals rejected or ambiguous outcome %s %s without replay", async (status, timeout, outcome) => {
  const { run, seen } = harness({ status, timeout });
  expect((await run("create", [...input, "--execute", "--confirm", "new triage rule"])).failed).toBe(true);
  expect(seen).toHaveLength(1);
  expect(journal().at(-1)).toMatchObject({ outcome });
});
