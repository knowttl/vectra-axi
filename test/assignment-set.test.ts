import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runAssignmentSet } from "../src/assignment-set.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile, type SelectedProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createMutationCoordinator, type MutationCoordinator } from "../src/writes.js";
import type { LeafResult } from "../src/notes.js";

// WRITE-03 acceptance: desired-state host/account assignment sets through
// the WRITE-00 gate pipeline. Every transport is a synthetic fixture; no
// live instance, real credential or customer data.
const scratch = mkdtempSync(join(import.meta.dirname, ".assignment-set-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const token = "fake-token-SENTINEL";
const NOW = 1_700_000_000_000;

const ASSIGNMENT_OPERATIONS = [
  "qux.host.assignment.create", "qux.host.assignment.reassign", "qux.host.assignment.unassign",
  "qux.account.assignment.create", "qux.account.assignment.reassign", "qux.account.assignment.unassign",
];
const enabledProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN", writes: { allowWrites: true, operations: ASSIGNMENT_OPERATIONS } };

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", token);
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configPath, { force: true });
  rmSync(auditPath, { force: true, recursive: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function selected(profile: Record<string, unknown> = { ...enabledProfile }): SelectedProfile {
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: profile } }));
  const loaded = loadConfig(configPath, new SecretRedactor());
  return selectProfile(loaded.config, "lab");
}

function harness(args: {
  profile?: SelectedProfile; transport: RawTransport;
}): { session: Session; coordinator: MutationCoordinator; run: (argv: string[]) => Promise<LeafResult> } {
  const profile = args.profile ?? selected();
  const redactor = new SecretRedactor();
  const session = createSession({ profile, configPath, redactor, transport: args.transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor,
    transport: args.transport, clock: () => NOW, auditPath });
  const run = (argv: string[]): Promise<LeafResult> => {
    const flags = new Map(parseInvocation(argv).flags);
    return runAssignmentSet(session, coordinator, flags);
  };
  return { session, coordinator, run };
}

type SeenCall = { method: string; url: string; body?: string };

// Fixture assignment transport: assignment-list GETs serve the current rows,
// user-show GETs serve the user (or a status override), and POST/PUT/DELETE
// record the mutation. Overrides simulate denial, failures and timeouts.
function assignmentTransport(args: {
  assignments: () => unknown[];
  user?: (id: number) => unknown;
  seen: SeenCall[];
  listStatus?: number;
  userStatus?: number;
  sendStatus?: number;
  sendThrows?: unknown;
}): RawTransport {
  return async (request) => {
    args.seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET" && request.url.includes("/assignments")) {
      return { status: args.listStatus ?? 200,
        bodyText: JSON.stringify({ results: args.assignments(), count: args.assignments().length }) };
    }
    if (request.method === "GET" && request.url.includes("/users/")) {
      const id = Number(request.url.split("/users/")[1]!.split("?")[0]);
      if ((args.userStatus ?? 200) !== 200) return { status: args.userStatus!, bodyText: "{}" };
      return { status: 200, bodyText: JSON.stringify(args.user?.(id) ?? { id, username: `analyst-${id}` }) };
    }
    if (args.sendThrows !== undefined) throw args.sendThrows;
    return { status: args.sendStatus ?? 200, bodyText: request.method === "DELETE" ? "" : "{}" };
  };
}

const openHost = { id: 11, host_id: 7, account_id: null, date_resolved: null,
  assigned_to: { id: 5, username: "analyst-5" } };
const openAccount = { id: 12, host_id: null, account_id: 7, date_resolved: null,
  assigned_to: { id: 5, username: "analyst-5" } };
const resolvedHost = { id: 13, host_id: 7, account_id: null, date_resolved: "2026-09-30T12:00:00Z",
  assigned_to: { id: 5, username: "analyst-5" } };

const auditLines = (): Record<string, unknown>[] =>
  readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

const sends = (seen: SeenCall[]): SeenCall[] =>
  seen.filter((call) => ["POST", "PUT", "DELETE"].includes(call.method));

it("reads current state through the entity-filtered unresolved list route", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  await run(["assignment", "set", "--host", "7", "--user", "3"]);
  expect(seen.filter((call) => call.method === "GET").map((call) => call.url)).toEqual([
    "https://fixture.invalid/api/v2.5/assignments?hosts=7&resolved=false&page_size=100",
    "https://fixture.invalid/api/v2.5/users/3",
  ]);
});

it("previews an assign without sending", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3"]);
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "host",
    id: 7,
    operation: "qux.host.assignment.create",
    current: "unassigned",
    desired: "user 3",
    action: "assign host 7 to user 3",
    help: ["Re-run with --execute --confirm 'host 7' to assign host 7 to user 3"],
  } });
  expect(sends(seen)).toEqual([]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("previews a reassign from the current user without sending", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [openHost], seen }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3"]);
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "host",
    id: 7,
    operation: "qux.host.assignment.reassign",
    current: "user 5",
    desired: "user 3",
    action: "reassign host 7 from user 5 to user 3",
    help: ["Re-run with --execute --confirm 'host 7' to reassign host 7 from user 5 to user 3"],
  } });
  expect(sends(seen)).toEqual([]);
});

it("previews an unassign without sending", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [openAccount], seen }) });
  const result = await run(["assignment", "set", "--account", "7", "--unassign"]);
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "account",
    id: 7,
    operation: "qux.account.assignment.unassign",
    current: "user 5",
    desired: "unassigned",
    action: "unassign account 7 from user 5",
    help: ["Re-run with --execute --confirm 'account 7' to unassign account 7 from user 5"],
  } });
  expect(sends(seen)).toEqual([]);
});

it("assigns an unassigned host through its POST route", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"]);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    operation: "qux.host.assignment.create",
    assignment: "assigned host 7 to user 3",
    audit: expect.any(String),
  });
  expect(sends(seen)).toEqual([{ method: "POST", url: "https://fixture.invalid/api/v2.5/assignments",
    body: JSON.stringify({ assign_host_id: 7, assign_to_user_id: 3 }) }]);
});

it("assigns an unassigned account with the account payload key", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  const result = await run(["assignment", "set", "--account", "7", "--user", "3",
    "--execute", "--confirm", "account 7"]);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    operation: "qux.account.assignment.create",
    assignment: "assigned account 7 to user 3",
  });
  expect(sends(seen)).toEqual([{ method: "POST", url: "https://fixture.invalid/api/v2.5/assignments",
    body: JSON.stringify({ assign_account_id: 7, assign_to_user_id: 3 }) }]);
});

it("reassigns through the assignment PUT route without moving the entity", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [openHost], seen }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"]);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    operation: "qux.host.assignment.reassign",
    assignment: "reassigned host 7 from user 5 to user 3",
    audit: expect.any(String),
  });
  expect(sends(seen)).toEqual([{ method: "PUT", url: "https://fixture.invalid/api/v2.5/assignments/11",
    body: JSON.stringify({ assign_to_user_id: 3 }) }]);
});

it("unassigns through the assignment DELETE route", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [openAccount], seen }) });
  const result = await run(["assignment", "set", "--account", "7", "--unassign",
    "--execute", "--confirm", "account 7"]);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    operation: "qux.account.assignment.unassign",
    assignment: "unassigned account 7 (was user 5)",
    audit: expect.any(String),
  });
  expect(sends(seen)).toEqual([{ method: "DELETE", url: "https://fixture.invalid/api/v2.5/assignments/12" }]);
});

it("sends nothing when the assignment already matches", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [openHost], seen }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "5",
    "--execute", "--confirm", "host 7"]);
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "host",
    id: 7,
    operation: "qux.host.assignment.reassign",
    assignment: "host 7 is already assigned to user 5 (no-op)",
  } });
  expect(sends(seen)).toEqual([]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("sends nothing when unassigning an unassigned entity", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  const result = await run(["assignment", "set", "--host", "7", "--unassign",
    "--execute", "--confirm", "host 7"]);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ assignment: "host 7 is already unassigned (no-op)" });
  expect(sends(seen)).toEqual([]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("treats resolved history as no open assignment and assigns fresh", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [resolvedHost], seen }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"]);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    operation: "qux.host.assignment.create",
    assignment: "assigned host 7 to user 3",
  });
  expect(sends(seen)).toHaveLength(1);
  expect(sends(seen)[0]!.method).toBe("POST");
});

it("refuses an unknown target user before any send", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => [], seen, userStatus: 404,
  }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "99",
    "--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  expect(sends(seen)).toEqual([]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("revalidates the target user before sending", async () => {
  const seen: SeenCall[] = [];
  let calls = 0;
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => [], seen,
    user: () => {
      calls += 1;
      if (calls === 1) return { id: 3, username: "analyst-3" };
      throw Object.assign(new Error("socket hang up"), { status: 404 });
    },
  }) });
  // The routing read sees the user, but the pre-send re-read must refuse it.
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"])).rejects.toThrow();
  expect(sends(seen)).toEqual([]);
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 0, outcome: "NOT_SENT" })]);
});

it("refuses the send when the assignment moves between preview and pre-send re-read", async () => {
  const seen: SeenCall[] = [];
  let calls = 0;
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => (calls++ === 0 ? [] : [{ ...openHost, assigned_to: { id: 9 } }]),
    seen,
  }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(sends(seen)).toEqual([]);
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 0, outcome: "NOT_SENT" })]);
});

it("treats a concurrent change that already matches as a no-op", async () => {
  const seen: SeenCall[] = [];
  let calls = 0;
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => (calls++ === 0 ? [] : [{ ...openHost, assigned_to: { id: 3 } }]),
    seen,
  }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"]);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ assignment: "host 7 is already assigned to user 3 (no-op)" });
  expect(sends(seen)).toEqual([]);
});

it("blocks assignment writes without confirmation before audit intent", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3", "--execute"]))
    .rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 8"])).rejects.toMatchObject({ code: "CONFIRM_MISMATCH" });
  expect(sends(seen)).toEqual([]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("refuses writes without hand opt-in", async () => {
  const seen: SeenCall[] = [];
  const profile = selected({ kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5",
    auth: "token", tokenEnv: "SENTINEL_TOKEN" });
  const { run } = harness({ profile,
    transport: assignmentTransport({ assignments: () => [], seen }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(sends(seen)).toEqual([]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("lets forced read-only override a hand-enabled profile", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(sends(seen)).toEqual([]);
});

it("refuses operations outside the configured scope", async () => {
  const seen: SeenCall[] = [];
  const profile = selected({ ...enabledProfile,
    writes: { allowWrites: true, operations: ["qux.host.assignment.create"] } });
  const { run } = harness({ profile,
    transport: assignmentTransport({ assignments: () => [openHost], seen }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code: "OPERATION_NOT_WRITABLE" });
  expect(sends(seen)).toEqual([]);
});

it("records intent and outcome in the journal on success", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"]);
  expect(result.failed).toBe(false);
  const auditId = (result.output as { audit: string }).audit;
  expect(auditId).toEqual(expect.any(String));
  const lines = auditLines();
  expect(lines.map((line) => [line.kind, line.operation, line.method, line.target, line.outcome ?? null])).toEqual([
    ["intent", "qux.host.assignment.create", "POST", "host 7", null],
    ["outcome", "qux.host.assignment.create", "POST", "host 7", "SUCCESS"],
  ]);
  expect(lines[0]!.url).toBe("https://fixture.invalid/api/v2.5/assignments");
  expect(lines[0]).not.toHaveProperty("httpStatus");
});

it("reports a definitive failure when the server rejects the change", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => [], seen, sendStatus: 403,
  }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"]);
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    error: "assignment for host 7 was rejected with status 403",
    audit: expect.any(String),
    help: ["Read back `vectra-axi assignment list --profile lab --host 7` before doing anything else"],
  });
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 403, outcome: "FAILED" })]);
});

it("reports OUTCOME_UNKNOWN without replay when the send times out", async () => {
  const seen: SeenCall[] = [];
  const failure = new Error("socket timed out");
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => [], seen, sendThrows: failure,
  }) });
  const result = await run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"]);
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({ audit: expect.any(String) });
  expect(result.output.error).toContain("read back");
  const auditId = (result.output as { audit: string }).audit;
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ id: auditId, httpStatus: 0, outcome: "OUTCOME_UNKNOWN" })]);
  expect(sends(seen)).toHaveLength(1);
});

it("rejects flag mistakes before any HTTP call", async () => {
  const cases: [string, string[], string][] = [
    ["missing entity", ["assignment", "set", "--user", "3"], "requires --host <id> or --account <id>"],
    ["combined entities", ["assignment", "set", "--host", "7", "--account", "7", "--user", "3"],
      "--host cannot be combined with --account"],
    ["invalid entity", ["assignment", "set", "--host", "0", "--user", "3"], "--host must be a positive integer"],
    ["missing desired", ["assignment", "set", "--host", "7"], "requires --user <id> or --unassign"],
    ["combined desired", ["assignment", "set", "--host", "7", "--user", "3", "--unassign"],
      "--user cannot be combined with --unassign"],
    ["invalid user", ["assignment", "set", "--host", "7", "--user", "0"], "--user must be a positive integer"],
  ];
  for (const [_name, argv, message] of cases) {
    const seen: SeenCall[] = [];
    const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
    await expect(run(argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR",
      message: expect.stringContaining(message) });
    expect(seen).toEqual([]);
  }
});

it("rejects --dry-run combined with --execute before any HTTP call", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3", "--execute", "--dry-run"]))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it("refuses duplicate open assignments instead of choosing a target", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => [openHost, { ...openHost, id: 14 }], seen,
  }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code: "VALIDATION_ERROR",
    message: expect.stringContaining("2 open assignments") });
  expect(sends(seen)).toEqual([]);
});

it("refuses duplicate open assignments spread across pages", async () => {
  const seen: SeenCall[] = [];
  const page2 = "https://fixture.invalid/api/v2.5/assignments?hosts=7&resolved=false&page=2";
  const transport: RawTransport = async (request) => {
    seen.push({ method: request.method, url: request.url });
    if (request.url === page2) {
      return { status: 200,
        bodyText: JSON.stringify({ results: [{ ...openHost, id: 14 }], count: 2 }) };
    }
    return { status: 200,
      bodyText: JSON.stringify({ results: [openHost], count: 2, next: page2 }) };
  };
  const { run } = harness({ transport });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code: "VALIDATION_ERROR",
    message: expect.stringContaining("2 open assignments") });
  expect(sends(seen)).toEqual([]);
});

it("rejects a malformed assignment read before shaping output", async () => {
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => [{ id: 11, host_id: 7 }], seen: [],
  }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3"]))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("surfaces a denied assignment read as an access error before any send", async () => {
  const seen: SeenCall[] = [];
  const { run } = harness({ transport: assignmentTransport({
    assignments: () => [], seen, listStatus: 403,
  }) });
  await expect(run(["assignment", "set", "--host", "7", "--user", "3",
    "--execute", "--confirm", "host 7"])).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(sends(seen)).toEqual([]);
});

it("never exposes the assignment mutations through the read session", async () => {
  const { session } = harness({ transport: assignmentTransport({ assignments: () => [], seen: [] }) });
  await expect(session.request("qux.host.assignment.create", {})).rejects.toMatchObject({
    code: "OPERATION_BLOCKED",
  });
  await expect(session.request("qux.host.assignment.reassign", { pathParams: { id: 11 } }))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
});

it("keeps assignment set out of the detection grammar", () => {
  const seen: SeenCall[] = [];
  harness({ transport: assignmentTransport({ assignments: () => [], seen }) });
  // Detections inherit their entity assignment and have no assignment
  // route, so no detection-flavoured leaf or flag exists.
  expect(() => parseInvocation(["assignment", "set", "--detection", "42", "--user", "3"]))
    .toThrow("Unknown flag: --detection");
  expect(seen).toEqual([]);
});
