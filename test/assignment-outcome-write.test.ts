import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { OUTCOME_CATEGORIES, runAssignmentOutcomeWrite } from "../src/assignment-outcome-write.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".assignment-outcome-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
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
      operations: ["create", "edit", "delete"].map((action) => `${kind}.assignment-outcome.${action}`) },
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
    if (request.method === "GET") return { status: 200, bodyText: JSON.stringify(options.state ? options.state() : custom) };
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return { seen, run: async (action: "create" | "edit" | "delete", args: string[]) =>
    runAssignmentOutcomeWrite(session, coordinator,
      new Map(parseInvocation(["assignment", "outcome", action, ...args]).flags), action) };
}
const custom = { id: 5, title: "Example outcome", category: "internal", builtin: false };
const input = ["--title", "Updated outcome", "--category", "internal"];
const confirm = ["--execute", "--confirm", "assignment outcome 5"];
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

it.each(["qux", "rux"] as const)("previews and sends create, edit and delete on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  await run("create", input);
  expect(seen).toEqual([]);
  await run("create", [...input, "--execute", "--confirm", "new assignment outcome"]);
  await run("edit", ["--id", "5", ...input]);
  await run("edit", ["--id", "5", ...input, ...confirm]);
  await run("delete", ["--id", "5"]);
  await run("delete", ["--id", "5", ...confirm]);
  const base = `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/assignment_outcomes`;
  const slash = kind === "rux" ? "/" : "";
  expect(seen.filter((call) => call.method !== "GET")).toEqual([
    { method: "POST", url: base + slash, body: JSON.stringify({ title: "Updated outcome", category: "internal" }) },
    { method: "PUT", url: base + "/5" + slash, body: JSON.stringify({ title: "Updated outcome", category: "internal" }) },
    { method: "DELETE", url: base + "/5" + slash },
  ]);
  expect(seen.filter((call) => call.method === "GET")).toHaveLength(6);
  expect(seen.filter((call) => call.method === "GET").every((call) => call.url === base + "/5" + slash)).toBe(true);
  expect(journal().map((row) => row.kind)).toEqual(["intent", "outcome", "intent", "outcome", "intent", "outcome"]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/Updated outcome|category|payload|synthetic-secret|synthetic-access/);
});

it.each(OUTCOME_CATEGORIES)("accepts documented category %s", async (category) => {
  expect((await harness().run("create", ["--title", "Example", "--category", category])).failed).toBe(false);
});

it.each(["edit", "delete"] as const)("refuses %s of builtin id 1", async (action) => {
  const { run, seen } = harness({ state: () => ({ ...custom, id: 1, builtin: true }) });
  await expect(run(action, ["--id", "1", ...(action === "edit" ? input : []), "--execute", "--confirm", "assignment outcome 1"]))
    .rejects.toMatchObject({ code: "BUILTIN_OUTCOME" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it.each([
  ["--title", "Example outcome"], ["--category", "internal"],
  ["--title", "Example outcome", "--category", "internal"],
])("skips equal edit %j", async (...args) => {
  const { run, seen } = harness();
  expect((await run("edit", ["--id", "5", ...args, ...confirm])).output.state).toContain("no-op");
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it.each([
  [{ allowWrites: false, operations: ["qux.assignment-outcome.create"] }, "WRITES_DISABLED"],
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
  expect(seen).toEqual([]);
});

it.each([
  [403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"],
] as const)("journals rejection or timeout without replay %s %s", async (status, timeout, outcome) => {
  const { run, seen } = harness({ status, timeout });
  expect((await run("create", [...input, "--execute", "--confirm", "new assignment outcome"])).failed).toBe(true);
  expect(seen).toHaveLength(1);
  expect(journal().at(-1)).toMatchObject({ outcome });
});

it("sends only the supplied edit field", async () => {
  const { run, seen } = harness();
  await run("edit", ["--id", "5", "--title", "Updated outcome", ...confirm]);
  expect(seen.filter((call) => call.method === "PUT")).toEqual([
    { method: "PUT", url: "https://fixture.invalid/api/v2.5/assignment_outcomes/5", body: JSON.stringify({ title: "Updated outcome" }) },
  ]);
});

it("skips an edit that reaches the desired state before sending", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ++reads === 1 ? custom : { ...custom, title: "Updated outcome" } });
  expect((await run("edit", ["--id", "5", ...input, ...confirm])).output.state).toContain("no-op");
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});

it.each([
  ["create", []], ["create", ["--title", " ", "--category", "internal"]],
  ["create", ["--title", "Example", "--category", "unknown"]], ["edit", ["--id", "5"]],
  ["delete", ["--id", "0"]], ["delete", ["--id", "9007199254740992"]],
] as const)("refuses invalid %s input %j", async (action, args) => {
  const { run, seen } = harness();
  await expect(run(action, [...args])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  [{ ...custom, builtin: true }, "BUILTIN_OUTCOME"],
  [{ ...custom, title: "Concurrent edit" }, "VERSION_CONFLICT"],
  [{ ...custom, builtin: null }, "MALFORMED_RESPONSE"],
] as const)("refuses changed or unsafe pre-send state %j", async (fresh, code) => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ++reads === 1 ? custom : fresh });
  await expect(run("edit", ["--id", "5", ...input, ...confirm])).rejects.toMatchObject({ code });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});
