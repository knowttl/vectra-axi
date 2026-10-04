import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { DETECTION_TRUNCATE_AT, runDetectionList, runDetectionShow } from "../src/detections.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".detections-test-"));
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

const detection = (id: number, extra: Record<string, unknown> = {}) => ({
  id, detection_type: "synthetic-type", state: "active", threat: 70 + id, certainty: 80, ...extra,
});
const listPage = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200, bodyText: JSON.stringify({ results: rows, ...extra }),
});
const nextPage = "https://fixture.invalid/api/v2.5/detections?min_id=2";

it("maps catalogue flags to server-side query keys before any HTTP", async () => {
  const transport: RawTransport = async () => listPage([detection(1)], { count: 1 });
  let url = "";
  const spy: RawTransport = async (request) => {
    url = request.url;
    return transport(request);
  };
  const result = await runDetectionList(session(spy),
    flags(["detection", "list", "--state", "active", "--threat-gte", "70", "--min-id", "1"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/detections?state=active&threat_gte=70&min_id=1");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 1,
    count: "1 detections",
    detections: [{ id: 1, detection_type: "synthetic-type", state: "active", threat: 71, certainty: 80 }],
    complete: true,
    help: ["Run `vectra-axi detection show --profile lab --id 1` for full detail"],
  } });
});

it("reports an unknown total when the page carries no count", async () => {
  const transport: RawTransport = async () => listPage([detection(1)]);
  const result = await runDetectionList(session(transport), flags(["detection", "list"]));
  expect(result.output).toMatchObject({ total: null, count: "1 detections", complete: true });
});

it("projects a --fields subset over the inventory fields", async () => {
  const transport: RawTransport = async () => listPage([detection(1)], { count: 1 });
  const result = await runDetectionList(session(transport),
    flags(["detection", "list", "--fields", "state,threat"]));
  expect(result.output).toMatchObject({ detections: [{ state: "active", threat: 71 }] });
  expect(result.output.help).toContain("Run `vectra-axi detection show --profile lab --id 1` for full detail");
});

it.each([
  { extra: { detection_type: null, state: null, threat: null, certainty: null },
    expected: { id: 1, detection_type: null, state: null, threat: null, certainty: null } },
  { extra: { detection_type: undefined, state: undefined, threat: undefined, certainty: undefined },
    expected: { id: 1 } },
])("preserves null and absent detection fields: $expected", async ({ extra, expected }) => {
  const row = detection(1, extra);
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...row, results: [row], count: 1 }),
  });
  const owned = session(transport);
  const listed = await runDetectionList(owned, flags(["detection", "list"]));
  expect(listed.output.detections).toEqual([expected]);
  const shown = await runDetectionShow(owned, flags(["detection", "show", "--id", "1"]));
  expect(shown.output).toEqual({ profile: "lab", ...expected });
});

it.each([
  ["id", undefined], ["id", null], ["id", "1"], ["id", 0], ["id", 1.5],
  ["detection_type", 1], ["state", []], ["threat", "high"], ["certainty", {}],
])("rejects malformed %s value %j in list and detail", async (field, value) => {
  const row = detection(1, { [field as string]: value });
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...row, results: [row], count: 1 }),
  });
  const owned = session(transport);
  const listed = await runDetectionList(owned, flags(["detection", "list", "--fields", "state"]));
  expect(listed).toMatchObject({ failed: true, output: { code: "RESPONSE_INVALID", detections: [] } });
  await expect(runDetectionShow(owned, flags(["detection", "show", "--id", "1"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it.each([
  [null, []], [null, ["--full"]],
  [undefined, []], [undefined, ["--full"]],
] as const)("preserves description %j with flags %j", async (description, extraFlags) => {
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...detection(1), description }),
  });
  const shown = await runDetectionShow(session(transport),
    flags(["detection", "show", "--id", "1", ...extraFlags]));
  expect(shown.output).toEqual({ profile: "lab", ...JSON.parse(JSON.stringify({ ...detection(1), description })) });
  expect(shown.output).not.toHaveProperty("help");
});

it.each([
  [42, []], [42, ["--full"]],
  [{}, []], [{}, ["--full"]],
  [[], []], [[], ["--full"]],
] as const)("rejects malformed description %j with flags %j", async (description, extraFlags) => {
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...detection(1), description }),
  });
  await expect(runDetectionShow(session(transport),
    flags(["detection", "show", "--id", "1", ...extraFlags])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it.each([
  ["list", runDetectionList, [], []],
  ["show", runDetectionShow, ["--id", "7"], ["--full"]],
] as const)("preserves shell arguments in the %s follow-up command", async (leaf, run, args, followUp) => {
  const config = "./lab's config $(printf injected) `printf injected`.json";
  const profile = "lab's $(printf injected) `printf injected`";
  const transport: RawTransport = async () => ({
    status: 200,
    bodyText: JSON.stringify({ ...detection(7), description: "x".repeat(DETECTION_TRUNCATE_AT + 1),
      results: [detection(7)], count: 1 }),
  });
  const result = await run(session(transport, profile),
    flags(["detection", leaf, "--config", config, "--profile", profile, ...args]));
  const [hint] = result.output.help as string[];
  const command = /^Run `([\s\S]*)` for /.exec(hint!)![1]!;
  const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`],
    { encoding: "utf8" }).trimEnd().split("\n");
  expect(argv).toEqual(["vectra-axi", "detection", "show", "--config", config,
    "--profile", profile, "--id", "7", ...followUp]);
  expect(parseInvocation(argv.slice(1)).flags.get("config")).toBe(config);
});

it("rejects an unknown --fields value before any HTTP call", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return listPage([]);
  };
  await expect(runDetectionList(session(transport), flags(["detection", "list", "--fields", "id,score"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("score") });
  expect(calls).toBe(0);
});

it("caps a list window with a cursor and resumes the same filters without losing a row", async () => {
  const responses = [
    listPage([detection(1)], { count: 2, next: nextPage }),
    listPage([detection(2)], { count: 2 }),
  ];
  let calls = 0;
  const transport: RawTransport = async () => responses[calls++ % responses.length]!;
  const owned = session(transport);
  const first = await runDetectionList(owned,
    flags(["detection", "list", "--state", "active", "--limit", "1"]));
  expect(first.output).toMatchObject({
    count: "1 of 2 detections", complete: true, cursor: expect.any(String),
  });
  const second = await runDetectionList(owned,
    flags(["detection", "list", "--state", "active", "--cursor", first.output.cursor as string]));
  expect(second).toEqual({ failed: false, output: {
    profile: "lab",
    total: 2,
    count: "1 of 2 detections",
    detections: [{ id: 2, detection_type: "synthetic-type", state: "active", threat: 72, certainty: 80 }],
    complete: true,
    help: ["Run `vectra-axi detection show --profile lab --id 2` for full detail"],
  } });
  expect(calls).toBe(2);
});

it("states an explicit empty result with its filters", async () => {
  const transport: RawTransport = async () => listPage([], { count: 0 });
  const result = await runDetectionList(session(transport),
    flags(["detection", "list", "--state", "active"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 0,
    count: "0 detections",
    detections: "0 detections found with state active",
    complete: true,
    help: ["Widen the filters or omit them to list every detection"],
  } });
});

it("keeps a partial window with its error and cursor on access denial", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  const result = await runDetectionList(session(transport), flags(["detection", "list"]));
  expect(result).toEqual({ failed: true, output: {
    profile: "lab",
    total: null,
    count: "0 detections",
    detections: [],
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

it.each([
  ["--threat-gte", "high"],
  ["--min-id", "1.5"],
  ["--limit", "0"],
])("rejects an invalid %s value before any HTTP call", async (flag, value) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return listPage([]);
  };
  await expect(runDetectionList(session(transport),
    flags(["detection", "list", flag, value]))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("rejects a resumed list with changed filters through the cursor binding", async () => {
  const transport: RawTransport = async () => listPage([detection(1)], { count: 2, next: nextPage });
  const owned = session(transport);
  const first = await runDetectionList(owned,
    flags(["detection", "list", "--state", "active", "--limit", "1"]));
  await expect(runDetectionList(owned,
    flags(["detection", "list", "--state", "closed", "--cursor", first.output.cursor as string])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("query context") });
});

it("rejects a malformed cursor before any HTTP call", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return listPage([]);
  };
  await expect(runDetectionList(session(transport),
    flags(["detection", "list", "--cursor", "opaque"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("cursor") });
  expect(calls).toBe(0);
});

it.each([[null], ["nope"], [[]]])("returns a partial result for malformed row %j", async (row) => {
  const transport: RawTransport = async () => listPage([row], { count: 1 });
  const result = await runDetectionList(session(transport), flags(["detection", "list"]));
  expect(result).toMatchObject({ failed: true, output: {
    detections: [], complete: false, code: "RESPONSE_INVALID", cursor: expect.any(String),
  } });
});

it("retains validated rows across pages and resumes at a malformed row", async () => {
  const responses = [
    listPage([detection(1)], { count: 4, next: nextPage }),
    listPage([detection(2), null, detection(4)], { count: 4 }),
    listPage([detection(2), detection(3), detection(4)], { count: 4 }),
  ];
  const urls: string[] = [];
  const transport: RawTransport = async (request) => {
    urls.push(request.url);
    return responses.shift()!;
  };
  const owned = session(transport);
  const first = await runDetectionList(owned, flags(["detection", "list", "--fields", "id"]));
  expect(first).toMatchObject({ failed: true, output: {
    detections: [{ id: 1 }, { id: 2 }], complete: false, code: "RESPONSE_INVALID", cursor: expect.any(String),
  } });
  const second = await runDetectionList(owned,
    flags(["detection", "list", "--fields", "id", "--cursor", first.output.cursor as string]));
  expect(second).toMatchObject({ failed: false, output: {
    detections: [{ id: 3 }, { id: 4 }], complete: true,
  } });
  expect(urls).toEqual(["https://fixture.invalid/api/v2.5/detections", nextPage, nextPage]);
});

it("retains validated rows when a resumed split page contains a malformed row", async () => {
  const responses = [
    listPage([detection(1), detection(2), null, detection(4)], { count: 4 }),
    listPage([detection(1), detection(2), null, detection(4)], { count: 4 }),
    listPage([detection(1), detection(2), detection(3), detection(4)], { count: 4 }),
  ];
  const transport: RawTransport = async () => responses.shift()!;
  const owned = session(transport);
  const first = await runDetectionList(owned,
    flags(["detection", "list", "--fields", "id", "--limit", "1"]));
  expect(first).toMatchObject({ failed: false, output: { detections: [{ id: 1 }], cursor: expect.any(String) } });
  const second = await runDetectionList(owned,
    flags(["detection", "list", "--fields", "id", "--cursor", first.output.cursor as string]));
  expect(second).toMatchObject({ failed: true, output: {
    detections: [{ id: 2 }], complete: false, code: "RESPONSE_INVALID", cursor: expect.any(String),
  } });
  const third = await runDetectionList(owned,
    flags(["detection", "list", "--fields", "id", "--cursor", second.output.cursor as string]));
  expect(third).toMatchObject({ failed: false, output: {
    detections: [{ id: 3 }, { id: 4 }], complete: true,
  } });
});

it("previews a long description with its total and a --full hint", async () => {
  const description = "x".repeat(DETECTION_TRUNCATE_AT + 40);
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...detection(7), description }),
  });
  const result = await runDetectionShow(session(transport),
    flags(["detection", "show", "--id", "7"]));
  expect(result.output.description).toBe(
    `${"x".repeat(DETECTION_TRUNCATE_AT)}\n... (truncated, ${description.length} chars total)`);
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    id: 7,
    detection_type: "synthetic-type",
    state: "active",
    threat: 77,
    certainty: 80,
    description: result.output.description,
    help: ["Run `vectra-axi detection show --profile lab --id 7 --full` for the complete text"],
  } });
});

it("reads full detail with --full and no truncation hint", async () => {
  const description = "x".repeat(DETECTION_TRUNCATE_AT + 40);
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...detection(7), description }),
  });
  const result = await runDetectionShow(session(transport),
    flags(["detection", "show", "--id", "7", "--full"]));
  expect(result.output).toMatchObject({ description, id: 7 });
  expect(result.output).not.toHaveProperty("help");
});

it("shows a short description without a truncation hint", async () => {
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...detection(7), description: "short synthetic detail" }),
  });
  const result = await runDetectionShow(session(transport),
    flags(["detection", "show", "--id", "7"]));
  expect(result.output).toMatchObject({ description: "short synthetic detail" });
  expect(result.output).not.toHaveProperty("help");
});

it("requires --id before any HTTP call", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  await expect(runDetectionShow(session(transport), flags(["detection", "show"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--id") });
  await expect(runDetectionShow(session(transport), flags(["detection", "show", "--id", "4.5"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("rejects a malformed detail body", async () => {
  const transport: RawTransport = async () => ({ status: 200, bodyText: "[1,2]" });
  await expect(runDetectionShow(session(transport), flags(["detection", "show", "--id", "7"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("surfaces a denied show as an access error", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  await expect(runDetectionShow(session(transport), flags(["detection", "show", "--id", "7"])))
    .rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

it("lists a detection, shows it with the same profile, and resumes the capped list", async () => {
  const detail = { ...detection(1), description: "full synthetic detail" };
  const calls: string[] = [];
  const transport: RawTransport = async (request) => {
    calls.push(request.url);
    if (request.url.includes("/detections/1")) {
      return { status: 200, bodyText: JSON.stringify(detail) };
    }
    if (request.url === nextPage) return listPage([detection(2)], { count: 2 });
    return listPage([detection(1)], { count: 2, next: nextPage });
  };
  const owned = session(transport);
  // List one synthetic detection in a capped window.
  const listed = await runDetectionList(owned,
    flags(["detection", "list", "--profile", "lab", "--state", "active", "--limit", "1"]));
  expect(listed).toMatchObject({ failed: false });
  expect(listed.output).toMatchObject({
    profile: "lab", count: "1 of 2 detections", complete: true, cursor: expect.any(String),
  });
  const [row] = listed.output.detections as Record<string, unknown>[];
  // Follow the suggested show command with the same profile and read full detail.
  expect(listed.output.help).toContain(
    `Run \`vectra-axi detection show --profile lab --id ${row!.id}\` for full detail`);
  const shown = await runDetectionShow(owned,
    flags(["detection", "show", "--profile", "lab", "--id", String(row!.id), "--full"]));
  expect(shown).toEqual({ failed: false, output: {
    profile: "lab",
    id: 1,
    detection_type: "synthetic-type",
    state: "active",
    threat: 71,
    certainty: 80,
    description: "full synthetic detail",
  } });
  // Resume the capped list without losing a row.
  const resumed = await runDetectionList(owned,
    flags(["detection", "list", "--profile", "lab", "--state", "active",
      "--cursor", listed.output.cursor as string]));
  expect(resumed.output).toMatchObject({ complete: true });
  const seen = [...listed.output.detections as unknown[], ...resumed.output.detections as unknown[]];
  expect(seen).toHaveLength(2);
  expect(calls).toEqual([
    "https://fixture.invalid/api/v2.5/detections?state=active",
    "https://fixture.invalid/api/v2.5/detections/1",
    nextPage,
  ]);
});

it.each([
  [["detection", "list"], "detection list"],
  [["detection", "show", "--id", "7"], "detection show"],
])("resolves %s to the %s leaf", (argv, leaf) => {
  expect(parseInvocation(argv)).toMatchObject({ leaf, home: false });
});

it.each([
  [["detection"], "Unknown command: detection"],
  [["detection", "note"], "Unknown command: detection note"],
  [["detection", "list", "extra"], "Unexpected argument: extra"],
  [["detection", "list", "--stat", "active"], "Unknown flag: --stat"],
  [["detection", "show", "--limit", "5"], "Unknown flag: --limit"],
  [["detection", "list", "--id", "7"], "Unknown flag: --id"],
  [["detection", "list", "--certainty-gte", ""], "requires a non-empty value"],
  [["detection", "list", "--host-id", "-1"], "requires a non-empty value"],
])("rejects %s at the catalogue", (argv, message) => {
  expect(() => parseInvocation(argv)).toThrow(expect.objectContaining({
    code: "VALIDATION_ERROR", message: expect.stringContaining(message),
  }));
});

it("keeps --help exclusive with --profile on detection leaves", () => {
  expect(() => parseInvocation(["detection", "list", "--help", "--profile", "lab"]))
    .toThrow(expect.objectContaining({
      code: "VALIDATION_ERROR", message: "--help cannot be combined with --profile",
    }));
});

// RUX-02: the same caller operations run against the documented v3.4 routes
// on a cloud profile. The fake answers the named unversioned exchange, then
// delegates resource GETs to the per-test responder.
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

const ruxDetection = (id: number, extra: Record<string, unknown> = {}) => ({
  id, detection_type: "synthetic-type", state: "active", threat: 70 + id, certainty: 80, ...extra,
});
const ruxListPage = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200, bodyText: JSON.stringify({ results: rows, ...extra }),
});
const ruxNext = "https://fixture.invalid/api/v3.4/detections/?state=active&page=2";

it("maps catalogue flags to the v3.4 detection route on a cloud profile", async () => {
  let url = "";
  const transport = cloudFixture((next) => {
    url = next;
    return ruxListPage([ruxDetection(1)], { count: 1 });
  });
  const result = await runDetectionList(cloudSession(transport),
    flags(["detection", "list", "--profile", "cloud", "--state", "active",
      "--threat-gte", "70", "--min-id", "1"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/detections/?state=active&threat_gte=70&min_id=1&page_size=100");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    total: 1,
    count: "1 detections",
    detections: [{ id: 1, detection_type: "synthetic-type", state: "active", threat: 71, certainty: 80 }],
    complete: true,
    help: ["Run `vectra-axi detection show --profile cloud --id 1` for full detail"],
  } });
});

it("shows one cloud detection with its cloud-scoped ID", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((url) => {
    urls.push(url);
    return { status: 200, bodyText: JSON.stringify({ ...ruxDetection(7), description: "cloud detail" }) };
  });
  const result = await runDetectionShow(cloudSession(transport),
    flags(["detection", "show", "--profile", "cloud", "--id", "7"]));
  expect(urls).toEqual(["https://fixture.invalid/api/v3.4/detections/7/"]);
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    id: 7,
    detection_type: "synthetic-type",
    state: "active",
    threat: 77,
    certainty: 80,
    description: "cloud detail",
  } });
});

it("lists a cloud detection, shows it, and resumes the capped window", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((url) => {
    urls.push(url);
    if (url === "https://fixture.invalid/api/v3.4/detections/1/") {
      return { status: 200, bodyText: JSON.stringify({ ...ruxDetection(1), description: "cloud detail" }) };
    }
    if (url === ruxNext) return ruxListPage([ruxDetection(2)], { count: 2 });
    return ruxListPage([ruxDetection(1)], { count: 2, next: ruxNext });
  });
  const owned = cloudSession(transport);
  const listed = await runDetectionList(owned,
    flags(["detection", "list", "--profile", "cloud", "--state", "active", "--limit", "1"]));
  expect(listed.output).toMatchObject({
    profile: "cloud", count: "1 of 2 detections", complete: true, cursor: expect.any(String),
  });
  expect(listed.output.help).toContain("Run `vectra-axi detection show --profile cloud --id 1` for full detail");
  const shown = await runDetectionShow(owned,
    flags(["detection", "show", "--profile", "cloud", "--id", "1"]));
  expect(shown.output).toMatchObject({ profile: "cloud", id: 1, description: "cloud detail" });
  const resumed = await runDetectionList(owned,
    flags(["detection", "list", "--profile", "cloud", "--state", "active",
      "--cursor", listed.output.cursor as string]));
  expect(resumed.output).toMatchObject({ profile: "cloud", complete: true });
  expect([...listed.output.detections as unknown[], ...resumed.output.detections as unknown[]]).toHaveLength(2);
  expect(urls).toEqual([
    "https://fixture.invalid/api/v3.4/detections/?state=active&page_size=100",
    "https://fixture.invalid/api/v3.4/detections/1/",
    ruxNext,
  ]);
});

it("refuses an on-prem cursor on a cloud profile", async () => {
  let calls = 0;
  const quxTransport: RawTransport = async () => {
    calls += 1;
    return listPage([detection(1)], { count: 2, next: nextPage });
  };
  const first = await runDetectionList(session(quxTransport),
    flags(["detection", "list", "--state", "active", "--limit", "1"]));
  const owned = cloudSession(cloudFixture(() => {
    calls += 1;
    return ruxListPage([]);
  }));
  await expect(runDetectionList(owned,
    flags(["detection", "list", "--state", "active", "--cursor", first.output.cursor as string])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR",
      message: expect.stringContaining("the cursor belongs to qux.detection.list, not rux.detection.list") });
  expect(calls).toBe(1);
});

it("surfaces an embedded note summary without a note-list hint on a cloud profile", async () => {
  const transport = cloudFixture(() => ({
    status: 200, bodyText: JSON.stringify({ ...ruxDetection(1), description: "cloud detail", note: "cloud summary" }),
  }));
  const result = await runDetectionShow(cloudSession(transport),
    flags(["detection", "show", "--profile", "cloud", "--id", "1"]));
  expect(result.output).toMatchObject({ profile: "cloud", id: 1, note_summary: "cloud summary" });
  expect(result.output).not.toHaveProperty("help");
});

it("reports a denied cloud detection window with its error and cursor", async () => {
  const transport = cloudFixture(() => ({ status: 403, bodyText: "{}" }));
  const result = await runDetectionList(cloudSession(transport),
    flags(["detection", "list", "--profile", "cloud"]));
  expect(result).toMatchObject({ failed: true, output: {
    profile: "cloud", complete: false, code: "ACCESS_DENIED", cursor: expect.any(String),
  } });
});
