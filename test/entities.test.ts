import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { runAccountList, runAccountShow, runEntityList, runEntityShow, runHostList, runHostShow } from "../src/entities.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".entities-test-"));
const path = join(scratch, "config.json");
const tokenProfile = {
  kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
};
const token = "fake-token-SENTINEL";

beforeEach(() => {
  process.env.SENTINEL_TOKEN = token;
  process.env.CLOUD_SECRET = "fake-cloud-secret-SENTINEL";
});
afterEach(() => {
  delete process.env.SENTINEL_TOKEN;
  delete process.env.CLOUD_SECRET;
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

// Fixtures deliberately give a host and an account the same numeric ID with
// different threat/certainty values; the leaves must keep them distinct.
const host = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `synthetic-host-${id}`, state: "active", threat: 90, certainty: 80, ...extra,
});
const account = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `synthetic-account-${id}`, state: "active", threat: 10, certainty: 20, ...extra,
});
const listPage = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200, bodyText: JSON.stringify({ results: rows, ...extra }),
});
const hostNext = "https://fixture.invalid/api/v2.5/hosts?min_id=2";

it("maps host flags to the wire score keys before any HTTP", async () => {
  const transport: RawTransport = async () => listPage([host(1)], { count: 1 });
  let url = "";
  const spy: RawTransport = async (request) => {
    url = request.url;
    return transport(request);
  };
  const result = await runHostList(session(spy),
    flags(["host", "list", "--threat-gte", "70", "--certainty-gte", "50", "--min-id", "1"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/hosts?min_id=1&t_score_gte=70&c_score_gte=50");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 1,
    count: "1 hosts",
    hosts: [{ id: 1, name: "synthetic-host-1", state: "active", threat: 90, certainty: 80 }],
    complete: true,
    help: ["Run `vectra-axi host show --profile lab --id 1` for full detail"],
  } });
});

it("routes the entity facade by --type to the matching route", async () => {
  const urls: string[] = [];
  const transport: RawTransport = async (request) => {
    urls.push(request.url);
    const row = request.url.includes("/hosts") ? host(1) : account(1);
    return listPage([row], { count: 1 });
  };
  const owned = session(transport);
  const hosts = await runEntityList(owned, flags(["entity", "list", "--type", "host"]));
  expect(urls).toEqual(["https://fixture.invalid/api/v2.5/hosts"]);
  expect(hosts.output).toMatchObject({ profile: "lab", type: "host", count: "1 hosts" });
  expect(hosts.output.entities).toEqual([
    { id: 1, name: "synthetic-host-1", threat: 90, certainty: 80 }]);
  expect(hosts.output.help).toEqual(
    ["Run `vectra-axi entity show --profile lab --type host --id 1` for full detail"]);
  const accounts = await runEntityList(owned, flags(["entity", "list", "--type", "account"]));
  expect(urls[1]).toBe("https://fixture.invalid/api/v2.5/accounts");
  expect(accounts.output).toMatchObject({ profile: "lab", type: "account", count: "1 accounts" });
});

it("keeps the same numeric host and account IDs distinct", async () => {
  const transport: RawTransport = async (request) => {
    if (request.url === "https://fixture.invalid/api/v2.5/hosts/7") {
      return { status: 200, bodyText: JSON.stringify(host(7)) };
    }
    if (request.url === "https://fixture.invalid/api/v2.5/accounts/7") {
      return { status: 200, bodyText: JSON.stringify(account(7)) };
    }
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const owned = session(transport);
  const shownHost = await runHostShow(owned, flags(["host", "show", "--id", "7"]));
  expect(shownHost).toEqual({ failed: false, output: {
    profile: "lab", type: "host",
    id: 7, name: "synthetic-host-7", state: "active", threat: 90, certainty: 80,
  } });
  const shownAccount = await runAccountShow(owned, flags(["account", "show", "--id", "7"]));
  expect(shownAccount).toEqual({ failed: false, output: {
    profile: "lab", type: "account",
    id: 7, name: "synthetic-account-7", state: "active", threat: 10, certainty: 20,
  } });
  const entityHost = await runEntityShow(owned, flags(["entity", "show", "--type", "host", "--id", "7"]));
  expect(entityHost.output).toMatchObject({ type: "host", threat: 90, certainty: 80 });
  expect(entityHost.output).not.toHaveProperty("state");
  const entityAccount = await runEntityShow(owned, flags(["entity", "show", "--type", "account", "--id", "7"]));
  expect(entityAccount.output).toMatchObject({ type: "account", threat: 10, certainty: 20 });
  expect(entityAccount.output).not.toHaveProperty("state");
});

it.each([
  ["list", [] as string[]],
  ["show", ["--id", "7"]],
])("rejects an entity %s without --type before any HTTP call", async (_leaf, args) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return listPage([]);
  };
  const run = _leaf === "list" ? runEntityList : runEntityShow;
  await expect(run(session(transport), flags(["entity", _leaf, ...args])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--type") });
  expect(calls).toBe(0);
});

it.each([
  ["list", ["--type", "detection"]],
  ["show", ["--type", "detection", "--id", "7"]],
])("rejects an entity %s with an unknown --type before any HTTP call", async (_leaf, args) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return listPage([]);
  };
  const run = _leaf === "list" ? runEntityList : runEntityShow;
  await expect(run(session(transport), flags(["entity", _leaf, ...args])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--type must be") });
  expect(calls).toBe(0);
});

it.each([
  ["host", "min-id", "min_id"],
  ["host", "max-id", "max_id"],
  ["account", "min-id", "min_id"],
  ["account", "max-id", "max_id"],
])("rejects facade %s %s filters before any HTTP call", async (kind, flag, key) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return listPage([]);
  };
  await expect(runEntityList(session(transport),
    new Map([["type", kind], [flag, "1"]])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining(key) });
  expect(calls).toBe(0);
});

it.each([
  ["host", "min_id", "hosts", host],
  ["host", "max_id", "hosts", host],
  ["account", "min_id", "accounts", account],
  ["account", "max_id", "accounts", account],
])("collects %s facade pages using %s continuation", async (kind, key, route, row) => {
  const initial = `https://fixture.invalid/api/v2.5/${route}?t_score_gte=5`;
  const next = `/api/v2.5/${route}?t_score_gte=5&${key}=2`;
  const urls: string[] = [];
  const transport: RawTransport = async (request) => {
    urls.push(request.url);
    if (request.url === initial) return listPage([row(1)], { count: 2, next });
    if (request.url === `https://fixture.invalid${next}`) return listPage([row(2)], { count: 2 });
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const result = await runEntityList(session(transport),
    flags(["entity", "list", "--type", kind, "--threat-gte", "5"]));
  expect(result).toMatchObject({ failed: false, output: {
    type: kind, total: 2, complete: true, entities: [{ id: 1 }, { id: 2 }],
  } });
  expect(result.output).not.toHaveProperty("cursor");
  expect(urls).toEqual([initial, `https://fixture.invalid${next}`]);
});

it.each([
  ["host", "min_id", "hosts", host],
  ["host", "max_id", "hosts", host],
  ["account", "min_id", "accounts", account],
  ["account", "max_id", "accounts", account],
])("resumes %s facade pages using %s continuation", async (kind, key, route, row) => {
  const initial = `https://fixture.invalid/api/v2.5/${route}?t_score_gte=5`;
  const next = `https://fixture.invalid/api/v2.5/${route}?t_score_gte=5&${key}=2`;
  const urls: string[] = [];
  const transport: RawTransport = async (request) => {
    urls.push(request.url);
    if (request.url === initial) return listPage([row(1)], { count: 2, next });
    if (request.url === next) return listPage([row(2)], { count: 2 });
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const owned = session(transport);
  const first = await runEntityList(owned,
    flags(["entity", "list", "--type", kind, "--threat-gte", "5", "--limit", "1"]));
  expect(first).toMatchObject({ failed: false, output: {
    complete: true, entities: [{ id: 1 }], cursor: expect.any(String),
  } });
  const second = await runEntityList(owned,
    flags(["entity", "list", "--type", kind, "--threat-gte", "5", "--cursor", first.output.cursor as string]));
  expect(second).toMatchObject({ failed: false, output: {
    type: kind, total: 2, complete: true, entities: [{ id: 2 }],
  } });
  expect(second.output).not.toHaveProperty("cursor");
  expect(urls).toEqual([initial, next]);
});

it("keeps QUX threat/certainty labels and null scores instead of zero", async () => {
  const row = host(1, { threat: null, certainty: null });
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...row, results: [row], count: 1 }),
  });
  const owned = session(transport);
  const listed = await runHostList(owned, flags(["host", "list"]));
  expect(listed.output.hosts).toEqual([
    { id: 1, name: "synthetic-host-1", state: "active", threat: null, certainty: null }]);
  const shown = await runHostShow(owned, flags(["host", "show", "--id", "1"]));
  expect(shown.output).toMatchObject({ threat: null, certainty: null });
  expect(shown.output).not.toHaveProperty("urgency");
  expect(shown.output).not.toHaveProperty("importance");
});

it("projects a --fields subset and rejects state on the facade", async () => {
  const transport: RawTransport = async () => listPage([host(1)], { count: 1 });
  const owned = session(transport);
  const direct = await runHostList(owned, flags(["host", "list", "--fields", "name,state"]));
  expect(direct.output.hosts).toEqual([{ name: "synthetic-host-1", state: "active" }]);
  await expect(runEntityList(owned, flags(["entity", "list", "--type", "host", "--fields", "id,state"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("state") });
});

it("rejects an unknown --fields value before any HTTP call", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return listPage([]);
  };
  await expect(runAccountList(session(transport), flags(["account", "list", "--fields", "id,urgency"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("urgency") });
  expect(calls).toBe(0);
});

it("states an explicit empty result with its filters", async () => {
  const transport: RawTransport = async () => listPage([], { count: 0 });
  const result = await runAccountList(session(transport),
    flags(["account", "list", "--threat-gte", "70"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 0,
    count: "0 accounts",
    accounts: "0 accounts found with t_score_gte 70",
    complete: true,
    help: ["Widen the filters or omit them to list every entity of this kind"],
  } });
});

it("keeps a partial window with its error and cursor on access denial", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  const result = await runHostList(session(transport), flags(["host", "list"]));
  expect(result).toEqual({ failed: true, output: {
    profile: "lab",
    total: null,
    count: "0 hosts",
    hosts: [],
    complete: false,
    error: "API access was denied",
    code: "ACCESS_DENIED",
    cursor: expect.any(String),
    help: expect.arrayContaining([
      "Check the API credential's role, permissions and licence for this operation",
      "Pass --cursor <cursor> with the same filters to resume the pending page",
    ]),
  } });
});

it("caps a list window with a cursor and resumes the same filters without losing a row", async () => {
  const responses = [
    listPage([host(1)], { count: 2, next: hostNext }),
    listPage([host(2)], { count: 2 }),
  ];
  let calls = 0;
  const transport: RawTransport = async () => responses[calls++ % responses.length]!;
  const owned = session(transport);
  const first = await runHostList(owned,
    flags(["host", "list", "--threat-gte", "70", "--limit", "1"]));
  expect(first.output).toMatchObject({
    count: "1 of 2 hosts", complete: true, cursor: expect.any(String),
  });
  const second = await runHostList(owned,
    flags(["host", "list", "--threat-gte", "70", "--cursor", first.output.cursor as string]));
  expect(second).toEqual({ failed: false, output: {
    profile: "lab",
    total: 2,
    count: "1 of 2 hosts",
    hosts: [{ id: 2, name: "synthetic-host-2", state: "active", threat: 90, certainty: 80 }],
    complete: true,
    help: ["Run `vectra-axi host show --profile lab --id 2` for full detail"],
  } });
  expect(calls).toBe(2);
});

it("rejects a resumed list with changed filters through the cursor binding", async () => {
  const transport: RawTransport = async () => listPage([host(1)], { count: 2, next: hostNext });
  const owned = session(transport);
  const first = await runHostList(owned,
    flags(["host", "list", "--threat-gte", "70", "--limit", "1"]));
  await expect(runHostList(owned,
    flags(["host", "list", "--threat-gte", "80", "--cursor", first.output.cursor as string])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("query context") });
});

it("returns a partial result for a malformed row", async () => {
  const transport: RawTransport = async () => listPage([{ ...host(2), threat: "high" }], { count: 1 });
  const result = await runHostList(session(transport), flags(["host", "list"]));
  expect(result).toMatchObject({ failed: true, output: {
    hosts: [], complete: false, code: "RESPONSE_INVALID", cursor: expect.any(String),
  } });
});

it.each([
  ["--threat-gte", "high"],
  ["--certainty-gte", "high"],
  ["--min-id", "1.5"],
  ["--max-id", "1.5"],
  ["--limit", "0"],
])("rejects an invalid %s value before any HTTP call", async (flag, value) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return listPage([]);
  };
  await expect(runHostList(session(transport),
    flags(["host", "list", flag, value]))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("requires --id before any HTTP call", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  const owned = session(transport);
  await expect(runHostShow(owned, flags(["host", "show"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--id") });
  await expect(runAccountShow(owned, flags(["account", "show", "--id", "0"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("rejects a malformed detail body", async () => {
  const transport: RawTransport = async () => ({ status: 200, bodyText: "[1,2]" });
  await expect(runHostShow(session(transport), flags(["host", "show", "--id", "7"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("surfaces a denied show as an access error and a missing entity as a failed read", async () => {
  const denied: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  await expect(runAccountShow(session(denied), flags(["account", "show", "--id", "7"])))
    .rejects.toMatchObject({ code: "ACCESS_DENIED" });
  const missing: RawTransport = async () => ({ status: 404, bodyText: "{}" });
  await expect(runHostShow(session(missing), flags(["host", "show", "--id", "7"])))
    .rejects.toMatchObject({ code: "REQUEST_FAILED" });
});

it.each([
  [["host", "list"], "host list"],
  [["host", "show", "--id", "7"], "host show"],
  [["account", "list"], "account list"],
  [["account", "show", "--id", "7"], "account show"],
  [["entity", "list", "--type", "host"], "entity list"],
  [["entity", "show", "--type", "account", "--id", "7"], "entity show"],
])("resolves %s to the %s leaf", (argv, leaf) => {
  expect(parseInvocation(argv)).toMatchObject({ leaf, home: false });
});

it.each([
  [["host"], "Unknown command: host"],
  [["host", "note"], "Unknown command: host note"],
  [["host", "list", "--state", "active"], "Unknown flag: --state"],
  [["host", "list", "--ordering", "-id"], "Unknown flag: --ordering"],
  [["host", "show", "--limit", "5"], "Unknown flag: --limit"],
  [["account", "list", "--id", "7"], "Unknown flag: --id"],
  [["entity", "list", "--type", "host", "--min-id", "1"], "Unknown flag: --min-id"],
  [["entity", "list", "--type", "host", "--max-id", "1"], "Unknown flag: --max-id"],
  [["entity", "list", "--type", "account", "--min-id", "1"], "Unknown flag: --min-id"],
  [["entity", "list", "--type", "account", "--max-id", "1"], "Unknown flag: --max-id"],
  [["entity", "list", "--type", "host", "--state", "active"], "Unknown flag: --state"],
])("rejects %s at the catalogue", (argv, message) => {
  expect(() => parseInvocation(argv)).toThrow(expect.objectContaining({
    code: "VALIDATION_ERROR", message: expect.stringContaining(message),
  }));
});

// RUX-02: the same caller operations run against the documented v3.4 routes
// on a cloud profile. Host/account threat/certainty keep their labels; the
// entities route returns urgency_score/importance as distinct fields. The
// fake answers the named unversioned exchange, then delegates resource GETs
// to the per-test responder.
const ruxProfile = {
  kind: "rux", origin: "https://fixture.invalid", apiVersion: "3.4", auth: "oauth",
  clientId: "synthetic-client", secretEnv: "CLOUD_SECRET",
};

function cloudSession(transport: RawTransport): Session {
  writeFileSync(path, JSON.stringify({ profiles: { cloud: ruxProfile } }));
  const loaded = loadConfig(path, new SecretRedactor());
  return createSession({ profile: selectProfile(loaded.config, "cloud"), configPath: loaded.path,
    redactor: new SecretRedactor(), transport });
}

function cloudFixture(respond: (url: string) => { status: number; bodyText: string }): RawTransport {
  return async (request) => {
    if (request.method === "POST") {
      expect(request.url).toBe("https://fixture.invalid/oauth2/token");
      return { status: 200, bodyText: JSON.stringify(
        { access_token: "fake-cloud-access-token", token_type: "Bearer", expires_in: 3600 }) };
    }
    return respond(request.url);
  };
}

// Fixtures deliberately give a host, an account and both entity kinds the
// same numeric ID with different urgency/importance values; the leaves must
// keep every identity distinct and never fold urgency into threat scores.
const ruxHost = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `synthetic-host-${id}`, state: "active", threat: 90, certainty: 80, ...extra,
});
const ruxAccount = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `synthetic-account-${id}`, state: "active", threat: 10, certainty: 20, ...extra,
});
const ruxEntity = (kind: string, id: number, extra: Record<string, unknown> = {}) => ({
  id, name: kind === "host" ? `synthetic-host-${id}` : `synthetic-account-${id}`,
  type: kind, urgency_score: kind === "host" ? 76 : 31,
  importance: kind === "host" ? 3 : 1, ...extra,
});
const ruxListPage = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200, bodyText: JSON.stringify({ results: rows, ...extra }),
});

it("maps host flags to the v3.4 host route on a cloud profile", async () => {
  let url = "";
  const transport = cloudFixture((next) => {
    url = next;
    return ruxListPage([ruxHost(1)], { count: 1 });
  });
  const result = await runHostList(cloudSession(transport),
    flags(["host", "list", "--profile", "cloud", "--threat-gte", "70", "--min-id", "1"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/hosts/?min_id=1&t_score_gte=70&page_size=100");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    total: 1,
    count: "1 hosts",
    hosts: [{ id: 1, name: "synthetic-host-1", state: "active", threat: 90, certainty: 80 }],
    complete: true,
    help: ["Run `vectra-axi host show --profile cloud --id 1` for full detail"],
  } });
});

it("maps account flags to the v3.4 account route on a cloud profile", async () => {
  let url = "";
  const transport = cloudFixture((next) => {
    url = next;
    return ruxListPage([ruxAccount(1)], { count: 1 });
  });
  const result = await runAccountList(cloudSession(transport),
    flags(["account", "list", "--profile", "cloud", "--certainty-gte", "50"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/accounts/?c_score_gte=50&page_size=100");
  expect(result.output).toMatchObject({ profile: "cloud", count: "1 accounts",
    accounts: [{ id: 1, name: "synthetic-account-1", state: "active", threat: 10, certainty: 20 }] });
});

it("keeps the same numeric host and account IDs distinct on a cloud profile", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((url) => {
    urls.push(url);
    if (url === "https://fixture.invalid/api/v3.4/hosts/7/") {
      return { status: 200, bodyText: JSON.stringify(ruxHost(7)) };
    }
    if (url === "https://fixture.invalid/api/v3.4/accounts/7/") {
      return { status: 200, bodyText: JSON.stringify(ruxAccount(7)) };
    }
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  const owned = cloudSession(transport);
  const shownHost = await runHostShow(owned,
    flags(["host", "show", "--profile", "cloud", "--id", "7"]));
  expect(shownHost).toEqual({ failed: false, output: {
    profile: "cloud", type: "host",
    id: 7, name: "synthetic-host-7", state: "active", threat: 90, certainty: 80,
  } });
  const shownAccount = await runAccountShow(owned,
    flags(["account", "show", "--profile", "cloud", "--id", "7"]));
  expect(shownAccount).toEqual({ failed: false, output: {
    profile: "cloud", type: "account",
    id: 7, name: "synthetic-account-7", state: "active", threat: 10, certainty: 20,
  } });
  expect(urls).toEqual([
    "https://fixture.invalid/api/v3.4/hosts/7/",
    "https://fixture.invalid/api/v3.4/accounts/7/",
  ]);
});

it("lists cloud entities with urgency and importance apart from scores", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((url) => {
    urls.push(url);
    const row = url.includes("type=account") ? ruxEntity("account", 7) : ruxEntity("host", 7);
    return ruxListPage([row], { count: 1 });
  });
  const owned = cloudSession(transport);
  const hosts = await runEntityList(owned,
    flags(["entity", "list", "--profile", "cloud", "--type", "host"]));
  expect(urls[0]).toBe("https://fixture.invalid/api/v3.4/entities/?type=host&page_size=100");
  expect(hosts.output).toMatchObject({ profile: "cloud", type: "host", count: "1 hosts" });
  expect(hosts.output.entities).toEqual([
    { id: 7, name: "synthetic-host-7", type: "host", urgency_score: 76, importance: 3 }]);
  expect(hosts.output.help).toEqual(
    ["Run `vectra-axi entity show --profile cloud --type host --id 7` for full detail"]);
  const accounts = await runEntityList(owned,
    flags(["entity", "list", "--profile", "cloud", "--type", "account"]));
  expect(urls[1]).toBe("https://fixture.invalid/api/v3.4/entities/?type=account&page_size=100");
  expect(accounts.output.entities).toEqual([
    { id: 7, name: "synthetic-account-7", type: "account", urgency_score: 31, importance: 1 }]);
});

it("shows one cloud entity with its required type selector", async () => {
  let url = "";
  const transport = cloudFixture((next) => {
    url = next;
    return { status: 200, bodyText: JSON.stringify(ruxEntity("host", 7)) };
  });
  const result = await runEntityShow(cloudSession(transport),
    flags(["entity", "show", "--profile", "cloud", "--type", "host", "--id", "7"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/entities/7/?type=host");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud", type: "host",
    id: 7, name: "synthetic-host-7", urgency_score: 76, importance: 3,
  } });
});

it.each([["--threat-gte", "70"], ["--certainty-gte", "50"]])(
  "refuses the %s entity filter on a cloud profile before any HTTP call", async (flag, value) => {
    let calls = 0;
    const transport = cloudFixture(() => {
      calls += 1;
      return ruxListPage([]);
    });
    await expect(runEntityList(cloudSession(transport),
      flags(["entity", "list", "--profile", "cloud", "--type", "host", flag, value])))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("Unsupported RUX v3.4 entity filter") });
    expect(calls).toBe(0);
  });

it("projects a cloud entity --fields subset and rejects score fields", async () => {
  const transport = cloudFixture(() => ruxListPage([ruxEntity("host", 7)], { count: 1 }));
  const owned = cloudSession(transport);
  const projected = await runEntityList(owned,
    flags(["entity", "list", "--profile", "cloud", "--type", "host",
      "--fields", "id,urgency_score,importance"]));
  expect(projected.output.entities).toEqual([{ id: 7, urgency_score: 76, importance: 3 }]);
  await expect(runEntityList(owned,
    flags(["entity", "list", "--profile", "cloud", "--type", "host", "--fields", "id,threat"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("threat") });
  await expect(runEntityList(owned,
    flags(["entity", "list", "--profile", "cloud", "--type", "host", "--fields", "id,state"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("state") });
});

it("preserves null urgency and importance instead of zero on a cloud profile", async () => {
  const row = ruxEntity("host", 7, { urgency_score: null, importance: null });
  const transport = cloudFixture(() => ({
    status: 200, bodyText: JSON.stringify({ ...row, results: [row], count: 1 }),
  }));
  const owned = cloudSession(transport);
  const listed = await runEntityList(owned,
    flags(["entity", "list", "--profile", "cloud", "--type", "host"]));
  expect(listed.output.entities).toEqual([
    { id: 7, name: "synthetic-host-7", type: "host", urgency_score: null, importance: null }]);
  const shown = await runEntityShow(owned,
    flags(["entity", "show", "--profile", "cloud", "--type", "host", "--id", "7"]));
  expect(shown.output).toMatchObject({ urgency_score: null, importance: null });
  expect(shown.output).not.toHaveProperty("threat");
  expect(shown.output).not.toHaveProperty("certainty");
});

it("returns a partial cloud entity window for a malformed urgency value", async () => {
  const transport = cloudFixture(() =>
    ruxListPage([{ ...ruxEntity("host", 7), urgency_score: "high" }], { count: 1 }));
  const result = await runEntityList(cloudSession(transport),
    flags(["entity", "list", "--profile", "cloud", "--type", "host"]));
  expect(result).toMatchObject({ failed: true, output: {
    entities: [], complete: false, code: "RESPONSE_INVALID", cursor: expect.any(String),
  } });
});

it("caps a cloud entity window with a cursor and resumes without losing a row", async () => {
  const initial = "https://fixture.invalid/api/v3.4/entities/?type=host&page_size=100";
  const next = "https://fixture.invalid/api/v3.4/entities/?type=host&page=2";
  const urls: string[] = [];
  const transport = cloudFixture((url) => {
    urls.push(url);
    if (url === initial) return ruxListPage([ruxEntity("host", 7)], { count: 2, next });
    if (url === next) return ruxListPage([ruxEntity("host", 8)], { count: 2 });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  const owned = cloudSession(transport);
  const first = await runEntityList(owned,
    flags(["entity", "list", "--profile", "cloud", "--type", "host", "--limit", "1"]));
  expect(first.output).toMatchObject({
    count: "1 of 2 hosts", complete: true, cursor: expect.any(String),
  });
  const second = await runEntityList(owned,
    flags(["entity", "list", "--profile", "cloud", "--type", "host",
      "--cursor", first.output.cursor as string]));
  expect(second).toEqual({ failed: false, output: {
    profile: "cloud",
    type: "host",
    total: 2,
    count: "1 of 2 hosts",
    entities: [{ id: 8, name: "synthetic-host-8", type: "host", urgency_score: 76, importance: 3 }],
    complete: true,
    help: ["Run `vectra-axi entity show --profile cloud --type host --id 8` for full detail"],
  } });
  expect(urls).toEqual([initial, next]);
});

it("surfaces an embedded note summary without a note-list hint on a cloud host", async () => {
  const transport = cloudFixture(() => ({
    status: 200, bodyText: JSON.stringify({ ...ruxHost(7), note: "cloud summary" }),
  }));
  const result = await runHostShow(cloudSession(transport),
    flags(["host", "show", "--profile", "cloud", "--id", "7"]));
  expect(result.output).toMatchObject({ profile: "cloud", type: "host", note_summary: "cloud summary" });
  expect(result.output).not.toHaveProperty("help");
});
