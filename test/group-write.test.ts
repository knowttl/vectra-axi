import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runGroupMemberWrite, runGroupWrite } from "../src/group-write.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".group-write-test-"));
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
  kind?: "qux" | "rux"; state?: () => unknown[]; group?: Record<string, unknown>; incomplete?: boolean;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean;
  release?: string; lifecycle?: boolean; metadata?: () => Record<string, unknown>;
} = {}) {
  const kind = options.kind ?? "qux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(options.release ? { applianceRelease: options.release } : {}),
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true, operations: options.lifecycle
      ? ["create", "edit", "delete"].map((action) => `${kind}.group.${action}`) : [`${kind}.group.member.set`] },
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
    if (request.method === "GET") {
      if (!request.url.includes("/members")) return {
        status: 200, bodyText: JSON.stringify({ id: 8, type: "host", name: "Example", description: "Example group", importance: "medium", ...options.group, ...options.metadata?.() }),
      };
      const rows = options.state ? options.state() : [{ id: 7 }];
      const second = new URL(request.url).searchParams.has("page");
      return { status: 200, bodyText: JSON.stringify({
        count: rows.length + (options.incomplete ? 1 : 0), results: second ? rows.slice(1) : rows.slice(0, 1),
        next: !second && (rows.length > 1 || options.incomplete)
          ? request.url.split("?")[0] + "?page=2" : null,
      }) };
    }
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return {
    seen,
    lifecycle: async (action: "create" | "edit" | "delete", args: string[]) => runGroupWrite(session, coordinator,
      new Map(parseInvocation(["group", action, ...args]).flags), action),
    run: async (args: string[] = [], action: "add" | "remove" | "set" = "add", stdin?: () => string) => runGroupMemberWrite(session, coordinator,
      new Map(parseInvocation(["group", "member", action, ...args]).flags), action, stdin),
  };
}
const input = ["--id", "8", "--members", "9"];
const execute = ["--execute", "--confirm", "group 8"];
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

const createInput = ["--type", "host", "--name", "Example", "--description", "Example group", "--importance", "medium"];
const createExecute = ["--execute", "--confirm", "new group"];

it.each(["qux", "rux"] as const)("previews and creates a %s group with the required payload", async (kind) => {
  const { lifecycle, seen } = harness({ kind, lifecycle: true });
  const args = [...createInput, "--members", "7,9"];
  expect((await lifecycle("create", args)).output).toMatchObject({ proposed: {
    type: "host", name: "Example", description: "Example group", importance: "medium", members: [7, 9],
  } });
  expect(seen).toEqual([]);
  await lifecycle("create", [...args, ...createExecute]);
  expect(seen).toEqual([{
    method: "POST", url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/groups${kind === "rux" ? "/" : ""}`,
    body: JSON.stringify({ name: "Example", description: "Example group", importance: "medium", type: "host", members: [7, 9] }),
  }]);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/Example|payload|members|synthetic-secret|synthetic-access/);
});

it.each(["qux", "rux"] as const)("edits only supplied %s group metadata and skips an equal edit", async (kind) => {
  const { lifecycle, seen } = harness({ kind, lifecycle: true });
  await lifecycle("edit", ["--id", "8", "--importance", "medium", ...execute]);
  expect(seen.filter((call) => call.method !== "GET")).toEqual([]);
  await lifecycle("edit", ["--id", "8", "--description", "Updated description", ...execute]);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([{
    method: "PATCH", url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/groups/8${kind === "rux" ? "/" : ""}`,
    body: JSON.stringify({ description: "Updated description" }),
  }]);
});

it("deletes a RUX group only with the exact confirmation and journals disruptive intent", async () => {
  const { lifecycle, seen } = harness({ kind: "rux", lifecycle: true });
  expect((await lifecycle("delete", ["--id", "8"])).output).toMatchObject({ warning: expect.stringContaining("orphans") });
  await expect(lifecycle("delete", ["--id", "8", "--execute"])).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
  await expect(lifecycle("delete", ["--id", "8", "--execute", "--confirm", "group 9"])).rejects.toMatchObject({ code: "CONFIRM_MISMATCH" });
  expect(seen.filter((call) => call.method === "DELETE")).toEqual([]);
  await lifecycle("delete", ["--id", "8", ...execute]);
  expect(seen.filter((call) => call.method === "DELETE")).toEqual([{ method: "DELETE", url: "https://fixture.invalid/api/v3.4/groups/8/" }]);
  expect(journal()[0]).toMatchObject({ effect: "disruptive" });
});

it.each([
  [], ["--members", "7", "--regex", ".*"], ["--members", "7", "--ad-group-dn", "CN=Example"],
  ["--regex", ".*", "--ad-group-dn", "CN=Example"], ["--members", "0"], ["--members", "7,"],
].map((args) => ({ args })))("refuses invalid create membership $args before any request", async ({ args }) => {
  const { lifecycle, seen } = harness({ lifecycle: true });
  await expect(lifecycle("create", [...createInput, ...args, ...createExecute])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  ["8.9", "--regex", ".*"], ["9.5", "--ad-group-dn", "CN=Example"],
] as const)("refuses unsupported release %s %s before any request", async (release, flag, value) => {
  const { lifecycle, seen } = harness({ lifecycle: true, release });
  await expect(lifecycle("create", [...createInput, flag, value])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  ["create", ["--type", "host", "--members", "7"]],
  ["create", [...createInput, "--members", "7", "--id", "8"]],
  ["create", ["--type", "domain", "--name", "Example", "--description", "Example", "--importance", "medium", "--regex", ".*"]],
  ["create", ["--type", "ip", "--name", "Example", "--description", "Example", "--importance", "medium", "--ad-group-dn", "CN=Example"]],
  ["edit", ["--id", "8"]], ["edit", ["--id", "8", "--importance", "unknown"]],
  ["delete", ["--id", "0"]], ["delete", ["--id", "9007199254740992"]],
] as const)("rejects invalid lifecycle input %s %j without requests", async (action, args) => {
  const { lifecycle, seen } = harness({ lifecycle: true });
  await expect(lifecycle(action, [...args])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  ["9.0", "--regex", ".*", "regex"], ["9.6", "--ad-group-dn", "CN=Example", "ad_group_dn"],
] as const)("creates automatic groups on supported release %s", async (release, flag, value, key) => {
  const { lifecycle, seen } = harness({ lifecycle: true, release });
  await lifecycle("create", [...createInput, flag, value, ...createExecute]);
  expect(JSON.parse(seen.find((call) => call.method === "POST")!.body!)).toMatchObject({ [key]: value });
});

it.each(["edit", "delete"] as const)("refuses changed metadata before %s", async (action) => {
  let reads = 0;
  const { lifecycle, seen } = harness({ lifecycle: true, metadata: () => ({ name: ++reads === 1 ? "Example" : "Changed" }) });
  await expect(lifecycle(action, ["--id", "8", ...(action === "edit" ? ["--importance", "high"] : []), ...execute]))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});

it.each([
  [{ allowWrites: false, operations: ["qux.group.create"] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["qux.group.member.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses lifecycle writes without matching scope %j", async (writes, code) => {
  const { lifecycle, seen } = harness({ lifecycle: true, writes: { ...writes, operations: [...writes.operations] } });
  await expect(lifecycle("create", [...createInput, "--members", "7", ...createExecute])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("forced read-only overrides lifecycle opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { lifecycle, seen } = harness({ lifecycle: true });
  await expect(lifecycle("create", [...createInput, "--members", "7", ...createExecute])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)(
  "records lifecycle failures without replay %s %s", async (status, timeout, outcome) => {
    const { lifecycle, seen } = harness({ lifecycle: true, status, timeout });
    expect((await lifecycle("create", [...createInput, "--members", "7", ...createExecute])).failed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(journal().at(-1)).toMatchObject({ outcome });
  });

it.each(["qux", "rux"] as const)("previews paged membership then sends one full %s replacement", async (kind) => {
  const { run, seen } = harness({ kind, state: () => [{ id: 7 }, { id: 10 }] });
  expect((await run(input)).output).toMatchObject({
    before: [10, 7], after: [10, 7, 9], added: [9], removed: [],
    warning: "Groups drive triage rules and importance",
  });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect((await run([...input, ...execute])).failed).toBe(false);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([{
    method: "PATCH", url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/groups/8${kind === "rux" ? "/" : ""}`,
    body: JSON.stringify({ members: [10, 7, 9] }),
  }]);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/members|payload|synthetic-secret|synthetic-access/);
});

it.each([
  ["add", "7", [7]], ["remove", "7", []], ["set", "9,10,9", [10, 9]],
] as const)("computes %s full membership", async (action, members, desired) => {
  const { run, seen } = harness();
  expect((await run(["--id", "8", "--members", members], action)).output).toMatchObject({ after: desired });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it("adding an existing member is a no-op", async () => {
  const { run, seen } = harness();
  expect((await run(["--id", "8", "--members", "7", ...execute])).output).toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  ["account", { uid: "synthetic-uid" }, "other-uid", ["other-uid", "synthetic-uid"]],
  ["ip", { ip: "192.0.2.1" }, "192.0.2.2", ["192.0.2.1", "192.0.2.2"]],
  ["domain", { domain: "one.example" }, "two.example", ["one.example", "two.example"]],
] as const)("preserves %s member identity", async (type, row, value, desired) => {
  const { run, seen } = harness({ kind: "rux", group: { type }, state: () => [row] });
  await run(["--id", "8", "--members", value, ...execute]);
  expect(JSON.parse(seen.find((call) => call.method === "PATCH")!.body!)).toEqual({ members: desired });
});

it("reads a JSON file for replacement", async () => {
  const file = join(scratch, "members.json");
  writeFileSync(file, "[9,10]");
  const { run } = harness();
  expect((await run(["--id", "8", "--members-file", file], "set")).output).toMatchObject({ after: [10, 9] });
});

it("clears membership using an empty stdin array", async () => {
  const { run, seen } = harness();
  await run(["--id", "8", "--members-file", "-", ...execute], "set", () => "[]");
  expect(JSON.parse(seen.find((call) => call.method === "PATCH")!.body!)).toEqual({ members: [] });
});

it.each([{ regex: ".*" }, { is_regex: true }, { is_ad_group: true }, { ad_group_dn: "synthetic-dn" }, { type: "ad" }])(
  "refuses automatic membership %j", async (group) => {
    const { run, seen } = harness({ group });
    await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
  });

it("refuses a concurrent membership change before sending", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => [{ id: ++reads < 2 ? 7 : 10 }] });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});

it("refuses incomplete membership instead of replacing an unseen member", async () => {
  const { run, seen } = harness({ incomplete: true });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "INCOMPLETE_READ" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  [{ allowWrites: false, operations: ["qux.group.member.set"] }, "WRITES_DISABLED"],
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
  [["--execute", "--confirm", "group 9"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run([...input, ...args])).rejects.toMatchObject({ code });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  [], ["--id", "0", "--members", "7"], ["--id", "9007199254740992", "--members", "7"],
  ["--id", "8"], ["--id", "8", "--members", ""],
  ["--id", "8", "--members", "7", "--members-file", "-"],
].map((args) => ({ args })))("refuses invalid input $args", async ({ args }) => {
  const { run, seen } = harness();
  await expect(run(args)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each(["{}", "[null]", "invalid", "[0]"])("refuses invalid file content %s", async (content) => {
  const { run, seen } = harness();
  await expect(run(["--id", "8", "--members-file", "-"], "set", () => content)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)(
  "journals failure or ambiguity without replay %s %s", async (status, timeout, outcome) => {
    const { run, seen } = harness({ status, timeout });
    expect((await run([...input, ...execute])).failed).toBe(true);
    expect(seen.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(journal().at(-1)).toMatchObject({ outcome });
  });
