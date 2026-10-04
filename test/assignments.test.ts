import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { ASSIGNMENT_LIST_FIELDS, assignmentQuery, listFields, listLimit,
  OUTCOME_LIST_FIELDS, outcomeId, runAssignmentList, runOutcomeList, runOutcomeShow, runUserList, runUserShow,
  USER_LIST_FIELDS, userId } from "../src/assignments.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".assignments-test-"));
const path = join(scratch, "config.json");
const tokenProfile = {
  kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
};
const token = "fake-token-SENTINEL";

beforeEach(() => {
  process.env.SENTINEL_TOKEN = token;
});
afterEach(() => {
  delete process.env.SENTINEL_TOKEN;
  rmSync(path, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function session(transport: RawTransport, profile = "lab"): Session {
  writeFileSync(path, JSON.stringify({ profiles: { [profile]: tokenProfile } }));
  const loaded = loadConfig(path, new SecretRedactor());
  return createSession({ profile: selectProfile(loaded.config, profile), configPath: loaded.path,
    redactor: new SecretRedactor(), transport });
}

const flags = (argv: string[]): Map<string, string | boolean> =>
  new Map(parseInvocation(argv).flags);

// Fixtures keep assignment targets kind-scoped: a host assignment carries
// host_id with a null account_id, and an account assignment the reverse.
const openAssignment = { id: 11, host_id: 7, account_id: null, date_resolved: null };
const resolvedAssignment = { id: 12, host_id: null, account_id: 7, date_resolved: "2026-09-30T12:00:00Z" };
const listPage = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200, bodyText: JSON.stringify({ results: rows, ...extra }),
});

it("maps singular assignment flags to the plural wire keys before any HTTP", async () => {
  const transport: RawTransport = async () => listPage([openAssignment], { count: 1 });
  let url = "";
  const spy: RawTransport = async (request) => {
    url = request.url;
    return transport(request);
  };
  const result = await runAssignmentList(session(spy),
    flags(["assignment", "list", "--account", "7", "--host", "8", "--assignee", "3",
      "--resolution", "1", "--resolved", "false", "--created-after", "2026-09-01T00:00:00Z"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/assignments?accounts=7&hosts=8"
    + "&assignees=3&resolution=1&resolved=false&created_after=2026-09-01T00%3A00%3A00Z&page_size=100");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 1,
    count: "1 assignments",
    assignments: [{ ...openAssignment, status: "unresolved" }],
    complete: true,
    help: ["Run `vectra-axi assignment outcome list --profile lab` for the resolution taxonomy"],
  } });
});

it("marks null date_resolved unresolved and keeps the null instead of a zero", async () => {
  const transport: RawTransport = async () =>
    listPage([openAssignment, resolvedAssignment], { count: 2 });
  const result = await runAssignmentList(session(transport), flags(["assignment", "list"]));
  expect(result.failed).toBe(false);
  expect(result.output.assignments).toEqual([
    { ...openAssignment, status: "unresolved" },
    { ...resolvedAssignment, status: "resolved" },
  ]);
  const [open] = result.output.assignments as Record<string, unknown>[];
  expect(open!.date_resolved).toBeNull();
  expect(open).not.toHaveProperty("resolution");
});

it.each([
  { target: "host", row: { id: 11, host_id: 7, account_id: null } },
  { target: "account", row: { id: 12, host_id: null, account_id: 7 } },
])("rejects missing resolution state for $target assignments on initial and resumed reads", async ({ row }) => {
  const transport: RawTransport = async () => listPage([row], { count: 1 });
  const owned = session(transport);
  const first = await runAssignmentList(owned, flags(["assignment", "list"]));
  expect(first).toMatchObject({ failed: true, output: {
    complete: false, code: "RESPONSE_INVALID", assignments: [], cursor: expect.any(String),
  } });
  const second = await runAssignmentList(owned,
    flags(["assignment", "list", "--cursor", first.output.cursor as string, "--fields", "status"]));
  expect(second).toMatchObject({ failed: true, output: {
    complete: false, code: "RESPONSE_INVALID", assignments: [],
  } });
});

it("keeps host-targeted and account-targeted assignments kind-scoped", async () => {
  const transport: RawTransport = async () => listPage([openAssignment, resolvedAssignment], { count: 2 });
  const result = await runAssignmentList(session(transport), flags(["assignment", "list"]));
  const rows = result.output.assignments as Record<string, unknown>[];
  expect(rows[0]).toMatchObject({ host_id: 7, account_id: null });
  expect(rows[1]).toMatchObject({ host_id: null, account_id: 7 });
});

it("rejects a non-boolean resolved filter before any HTTP", async () => {
  let calls = 0;
  const transport: RawTransport = async (request) => {
    calls += 1;
    return listPage([]);
  };
  await expect(runAssignmentList(session(transport),
    flags(["assignment", "list", "--resolved", "maybe"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  });
  expect(calls).toBe(0);
});

it("lists assignment outcomes without inventing a merged assignment ranking", async () => {
  const rows = [
    { id: 1, title: "Benign True Positive", category: "benign_true_positive", builtin: true },
    { id: 4, title: "Synthetic Custom", category: "false_positive", builtin: false },
  ];
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/assignment_outcomes?page_size=100");
    return listPage(rows, { count: 2 });
  };
  const result = await runOutcomeList(session(transport), flags(["assignment", "outcome", "list"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 2,
    count: "2 assignment outcomes",
    outcomes: rows,
    complete: true,
    help: ["Run `vectra-axi assignment outcome show --profile lab --id 1` for full detail"],
  } });
});

it("shows one assignment outcome with its builtin marker", async () => {
  const row = { id: 4, title: "Synthetic Custom", category: "false_positive", builtin: false };
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/assignment_outcomes/4");
    return { status: 200, bodyText: JSON.stringify(row) };
  };
  const result = await runOutcomeShow(session(transport), flags(["assignment", "outcome", "show", "--id", "4"]));
  expect(result).toEqual({ failed: false, output: { profile: "lab", ...row } });
});

it("keeps the same numeric outcome and user IDs on distinct routes", async () => {
  const transport: RawTransport = async (request) => {
    if (request.url === "https://fixture.invalid/api/v2.5/assignment_outcomes/3") {
      return { status: 200, bodyText: JSON.stringify({ id: 3, title: "False Positive",
        category: "false_positive", builtin: true }) };
    }
    if (request.url === "https://fixture.invalid/api/v2.5/users/3") {
      return { status: 200, bodyText: JSON.stringify({ id: 3, username: "soc-analyst" }) };
    }
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const owned = session(transport);
  const outcome = await runOutcomeShow(owned, flags(["assignment", "outcome", "show", "--id", "3"]));
  expect(outcome.output).toMatchObject({ id: 3, title: "False Positive" });
  const user = await runUserShow(owned, flags(["user", "show", "--id", "3"]));
  expect(user.output).toEqual({ profile: "lab", id: 3, username: "soc-analyst" });
});

it("filters users server-side by username", async () => {
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/users?username=soc-analyst&page_size=100");
    return listPage([{ id: 3, username: "soc-analyst" }], { count: 1 });
  };
  const result = await runUserList(session(transport), flags(["user", "list", "--username", "soc-analyst"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 1,
    count: "1 users",
    users: [{ id: 3, username: "soc-analyst" }],
    complete: true,
    help: ["Run `vectra-axi user show --profile lab --id 3` for full detail"],
  } });
});

it("reports an empty assignment window as success with an explicit zero", async () => {
  const transport: RawTransport = async () => listPage([], { count: 0 });
  const result = await runAssignmentList(session(transport),
    flags(["assignment", "list", "--resolved", "false"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 0,
    count: "0 assignments",
    assignments: "0 assignments found with resolved false",
    complete: true,
    help: ["Widen the filters or omit them to list every assignment"],
  } });
});

it("reports denial as a failed disposition rather than an empty result", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  for (const run of [
    (owned: Session) => runAssignmentList(owned, flags(["assignment", "list"])),
    (owned: Session) => runOutcomeList(owned, flags(["assignment", "outcome", "list"])),
    (owned: Session) => runUserList(owned, flags(["user", "list"])),
  ]) {
    const result = await run(session(transport));
    expect(result.failed).toBe(true);
    expect(result.output).toMatchObject({ profile: "lab", complete: false, code: "ACCESS_DENIED" });
    expect(result.output).not.toHaveProperty("assignments", "0 assignments found");
  }
});

it("retains validated assignment rows when a later page fails", async () => {
  const transport: RawTransport = async (request) => {
    if (request.url === "https://fixture.invalid/api/v2.5/assignments?page_size=100") {
      return listPage([openAssignment], { count: 2,
        next: "https://fixture.invalid/api/v2.5/assignments?page=2" });
    }
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/assignments?page=2");
    return { status: 503, bodyText: "{}" };
  };
  const result = await runAssignmentList(session(transport), flags(["assignment", "list"]));
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({ complete: false, cursor: expect.any(String) });
  expect(result.output.assignments).toEqual([{ ...openAssignment, status: "unresolved" }]);
});

it("resumes a capped assignment list with its original filters", async () => {
  const transport: RawTransport = async (request) => {
    if (request.url === "https://fixture.invalid/api/v2.5/assignments?resolved=false&page_size=100") {
      return listPage([openAssignment], { count: 2,
        next: "https://fixture.invalid/api/v2.5/assignments?resolved=false&page=2" });
    }
    if (request.url === "https://fixture.invalid/api/v2.5/assignments?resolved=false&page=2") {
      return listPage([resolvedAssignment], { count: 2 });
    }
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const owned = session(transport);
  const first = await runAssignmentList(owned, flags(["assignment", "list", "--resolved", "false", "--limit", "1"]));
  expect(first.output).toMatchObject({ count: "1 of 2 assignments", cursor: expect.any(String) });
  const cursor = first.output.cursor as string;
  const second = await runAssignmentList(owned,
    flags(["assignment", "list", "--resolved", "false", "--cursor", cursor]));
  expect(second.output).toMatchObject({
    assignments: [{ ...resolvedAssignment, status: "resolved" }],
    complete: true,
  });
  await expect(runAssignmentList(owned,
    flags(["assignment", "list", "--resolved", "true", "--cursor", cursor]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  });
});

it("rejects malformed assignment rows instead of projecting them", async () => {
  const transport: RawTransport = async () =>
    listPage([{ ...openAssignment, id: "eleven" }], { count: 1 });
  const result = await runAssignmentList(session(transport), flags(["assignment", "list"]));
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({ complete: false, code: "RESPONSE_INVALID" });
});

// Flag validation runs before profile selection in cli.ts, so these unit
// cases assert the validators throw without any session or transport.
it.each([
  ["non-boolean resolved", () => assignmentQuery(flags(["assignment", "list", "--resolved", "maybe"])),
    "--resolved must be true or false"],
  ["non-integer account", () => assignmentQuery(flags(["assignment", "list", "--account", "1.5"])),
    "--account must be a non-negative integer"],
  ["non-integer resolution", () => assignmentQuery(flags(["assignment", "list", "--resolution", "high"])),
    "--resolution must be a non-negative integer"],
  ["zero limit", () => listLimit(flags(["assignment", "list", "--limit", "0"])),
    "--limit must be a positive integer"],
  ["unknown assignment field", () => listFields(flags(["assignment", "list", "--fields", "urgency"]), ASSIGNMENT_LIST_FIELDS),
    "Unknown --fields value: urgency"],
  ["unknown outcome field", () => listFields(flags(["assignment", "outcome", "list", "--fields", "score"]), OUTCOME_LIST_FIELDS),
    "Unknown --fields value: score"],
  ["unknown user field", () => listFields(flags(["user", "list", "--fields", "role"]), USER_LIST_FIELDS),
    "Unknown --fields value: role"],
  ["missing outcome id", () => outcomeId(flags(["assignment", "outcome", "show"])),
    "assignment outcome show requires --id"],
  ["zero outcome id", () => outcomeId(flags(["assignment", "outcome", "show", "--id", "0"])),
    "--id must be a positive integer"],
  ["missing user id", () => userId(flags(["user", "show"])),
    "user show requires --id"],
  ["fractional user id", () => userId(flags(["user", "show", "--id", "1.5"])),
    "--id must be a positive integer"],
])("rejects %s before profile selection", (_name, run, message) => {
  expect(run).toThrowError(message);
});
