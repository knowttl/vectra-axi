import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { RAW_TRUNCATE_AT, runApiGet } from "../src/api-get.js";
import { parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".api-get-test-"));
const path = join(scratch, "config.json");
const tokenProfile = {
  kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
};
const ruxProfile = {
  kind: "rux", origin: "https://fixture.invalid", apiVersion: "3.4", auth: "oauth",
  clientId: "synthetic-client", secretEnv: "CLOUD_SECRET",
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

function cloudSession(transport: RawTransport): Session {
  const fixture: RawTransport = async (request) => {
    if (request.method === "POST") {
      return { status: 200, bodyText: JSON.stringify(
        { access_token: "fake-cloud-access-token", token_type: "Bearer", expires_in: 3600 }) };
    }
    return transport(request);
  };
  writeFileSync(path, JSON.stringify({ profiles: { cloud: ruxProfile } }));
  const loaded = loadConfig(path, new SecretRedactor());
  return createSession({ profile: selectProfile(loaded.config, "cloud"), configPath: loaded.path,
    redactor: new SecretRedactor(), transport: fixture });
}

const flags = (argv: string[]): Map<string, string | boolean> =>
  new Map(parseInvocation(argv).flags);

const detection = (id: number) => ({ id, detection_type: "synthetic-type", state: "active", threat: 71, certainty: 80 });
const listPage = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200, bodyText: JSON.stringify({ results: rows, ...extra }),
});

it("reads a collection through the operation ID with recorded query keys", async () => {
  let url = "";
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    url = request.url;
    expect(request.method).toBe("GET");
    return listPage([detection(1)], { count: 1 });
  };
  const result = await runApiGet(session(spy),
    flags(["api", "get", "--operation", "qux.detection.list", "--query", "state=active&threat_gte=70"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/detections?state=active&threat_gte=70");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    operation: "qux.detection.list",
    total: 1,
    count: "1 rows",
    rows: [detection(1)],
    complete: true,
  } });
});

it("refuses an unknown operation before any HTTP", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return listPage([]);
  };
  await expect(runApiGet(session(spy), flags(["api", "get", "--operation", "qux.nope.list"])))
    .rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect(calls).toBe(0);
});

it("refuses a blocked sensitive route before any HTTP", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  await expect(runApiGet(session(spy), flags(["api", "get", "--operation", "qux.sensor-token.export"])))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(calls).toBe(0);
});

it("refuses a planned operation that has no reviewed read contract", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  await expect(runApiGet(session(spy), flags(["api", "get", "--operation", "rux.entity.note.list"])))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(calls).toBe(0);
});

it("refuses a write operation before any HTTP", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  await expect(runApiGet(session(spy),
    flags(["api", "get", "--operation", "qux.detection.tag.set", "--path", "id=42"])))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(calls).toBe(0);
});

it("refuses a checkpoint feed with guidance to its named leaf", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return listPage([]);
  };
  const error = await runApiGet(session(spy),
    flags(["api", "get", "--operation", "rux.detection.event.list"])).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
  expect(String((error as { message: string }).message)).toContain("not raw-addressable");
  expect(calls).toBe(0);
});

it("refuses the date-window audit feed with guidance to its named leaf", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return listPage([]);
  };
  await expect(runApiGet(session(spy), flags(["api", "get", "--operation", "qux.audit.list"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("refuses a query key outside the operation allowlist before any HTTP", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return listPage([]);
  };
  await expect(runApiGet(session(spy),
    flags(["api", "get", "--operation", "qux.detection.list", "--query", "token=abc"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("shows one resource through its path template with truncated long text", async () => {
  const description = "synthetic detail ".repeat(100);
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...detection(1), description }),
  });
  const result = await runApiGet(session(transport),
    flags(["api", "get", "--operation", "qux.detection.show", "--path", "id=1"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    operation: "qux.detection.show",
    result: { ...detection(1),
      description: `${description.slice(0, RAW_TRUNCATE_AT)}\n... (truncated, ${description.length} chars total)` },
    complete: true,
    help: ["Re-run with --full for the complete text"],
  } });
});

it("reveals the complete text with --full", async () => {
  const description = "synthetic detail ".repeat(100);
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ ...detection(1), description }),
  });
  const result = await runApiGet(session(transport),
    flags(["api", "get", "--operation", "qux.detection.show", "--path", "id=1", "--full"]));
  expect(result.output).toMatchObject({
    result: { ...detection(1), description },
  });
  expect(result.output).not.toHaveProperty("help");
});

it("projects a --fields subset and refuses unknown fields before any HTTP", async () => {
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify(detection(1)),
  });
  const result = await runApiGet(session(transport),
    flags(["api", "get", "--operation", "qux.detection.show", "--path", "id=1", "--fields", "state,threat"]));
  expect(result.output).toMatchObject({ result: { state: "active", threat: 71 } });
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  await expect(runApiGet(session(spy),
    flags(["api", "get", "--operation", "qux.detection.show", "--path", "id=1", "--fields", "token"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it.each([
  [session, "qux.detection.list", [], { results: [{ ...detection(1), metadata: "private" }], count: 1 },
    "rows", [detection(1)]],
  [cloudSession, "rux.detection.list", [], { results: [{ ...detection(1), metadata: "private" }], count: 1 },
    "rows", [detection(1)]],
  [session, "qux.host.note.list", ["--path", "id=1"],
    [{ id: 1, note: "synthetic note", created_by: "private", date_created: "private" }],
    "rows", [{ id: 1, note: "synthetic note" }]],
  [cloudSession, "rux.host.note.list", ["--path", "id=1"],
    [{ id: 1, note: "synthetic note", created_by: "private", modified_by: "private",
      date_created: "private", date_modified: "private" }],
    "rows", [{ id: 1, note: "synthetic note" }]],
  [session, "qux.detection.show", ["--path", "id=1"], { ...detection(1), metadata: "private" },
    "result", detection(1)],
  [cloudSession, "rux.host.tag.list", ["--path", "id=1"], { tags: ["synthetic"], status: "private", tag_id: 9 },
    "result", { tags: ["synthetic"] }],
] as const)("limits %s %s output to recorded fields", async (create, operation, bindings, body, key, expected) => {
  const transport: RawTransport = async () => ({ status: 200, bodyText: JSON.stringify(body) });
  const result = await runApiGet(create(transport), flags(["api", "get", "--operation", operation, ...bindings]));
  expect(result.failed).toBe(false);
  expect(result.output[key]).toEqual(expected);
});

it.each(["private", 42, null, ["private"]])("rejects unprojectable array row %s", async (row) => {
  const transport: RawTransport = async () => ({ status: 200, bodyText: JSON.stringify([row]) });
  await expect(runApiGet(cloudSession(transport),
    flags(["api", "get", "--operation", "rux.host.note.list", "--path", "id=1"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

const queryFieldOperations = [
  [session, "qux.triage-rule.list", "fields"],
  [cloudSession, "rux.triage-rule.list", "fields"],
  [cloudSession, "rux.detection.list", "fields"],
  [cloudSession, "rux.entity.list", "fields"],
  [cloudSession, "rux.detection.list", "exclude_fields"],
  [cloudSession, "rux.entity.list", "exclude_fields"],
] as const;

it.each(queryFieldOperations)("accepts recorded query selections for %s %s %s", async (create, operation, selector) => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return listPage([{ id: 1 }], { count: 1 });
  };
  const result = await runApiGet(create(transport),
    flags(["api", "get", "--operation", operation, "--query", `${selector}=id`]));
  expect(result.failed).toBe(false);
  expect(new URL(url).searchParams.get(selector)).toBe("id");
});

it.each(queryFieldOperations)("refuses unrecorded query selections for %s %s %s", async (create, operation, selector) => {
  const transport = vi.fn<RawTransport>();
  await expect(runApiGet(create(transport),
    flags(["api", "get", "--operation", operation, "--query", `${selector}=id,metadata`])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(transport).not.toHaveBeenCalled();
});

it.each(["fields", "exclude_fields"])("refuses an empty %s query selection", async (selector) => {
  const transport = vi.fn<RawTransport>();
  await expect(runApiGet(cloudSession(transport),
    flags(["api", "get", "--operation", "rux.detection.list", "--query", `${selector}=,`])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(transport).not.toHaveBeenCalled();
});

it("projects retained collection rows after a later page fails", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(listPage([{ ...detection(1), metadata: "private" }],
      { count: 2, next: "https://fixture.invalid/api/v2.5/detections?min_id=2" }))
    .mockResolvedValueOnce({ status: 403, bodyText: "{}" });
  const result = await runApiGet(session(transport),
    flags(["api", "get", "--operation", "qux.detection.list"]));
  expect(result).toMatchObject({ failed: true, output: { code: "ACCESS_DENIED", complete: false } });
  expect(result.output.rows).toEqual([detection(1)]);
});

it.each(["fields", "exclude_fields"])("refuses unrecorded %s in a continuation", async (selector) => {
  const transport = vi.fn<RawTransport>().mockResolvedValueOnce(listPage([detection(1)],
    { count: 2, next: `https://fixture.invalid/api/v3.4/detections/?${selector}=metadata` }));
  const result = await runApiGet(cloudSession(transport),
    flags(["api", "get", "--operation", "rux.detection.list"]));
  expect(result).toMatchObject({ failed: true, output: { code: "VALIDATION_ERROR", complete: false } });
  expect(result.output.rows).toEqual([detection(1)]);
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each(["fields", "exclude_fields"])("refuses unrecorded %s in a redirect", async (selector) => {
  const transport = vi.fn<RawTransport>().mockResolvedValueOnce({
    status: 302, location: `?${selector}=metadata`, bodyText: "",
  });
  await expect(runApiGet(cloudSession(transport),
    flags(["api", "get", "--operation", "rux.detection.list"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each(["fields", "exclude_fields"])("refuses unrecorded %s in a cursor page before HTTP", async (selector) => {
  const first: RawTransport = async () => listPage([detection(1), detection(2)], { count: 2 });
  const started = await runApiGet(cloudSession(first),
    flags(["api", "get", "--operation", "rux.detection.list", "--limit", "1"]));
  const cursor = JSON.parse(Buffer.from(started.output.cursor as string, "base64url").toString("utf8"));
  cursor.page[selector] = "metadata";
  const modified = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const transport = vi.fn<RawTransport>();
  await expect(runApiGet(cloudSession(transport),
    flags(["api", "get", "--operation", "rux.detection.list", "--cursor", modified])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(transport).not.toHaveBeenCalled();
});

it("requires the route template variable before any HTTP", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  await expect(runApiGet(session(spy), flags(["api", "get", "--operation", "qux.detection.show"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it.each([
  [session, "qux.health.show", "check=external_connectors"],
  [session, "qux.health.show", "check=edr"],
  [session, "qux.health.show", "check=unknown"],
  [cloudSession, "rux.health.show", "check_type=external_connectors"],
  [cloudSession, "rux.health.show", "check_type=edr"],
  [cloudSession, "rux.health.show", "check_type=unknown"],
] as const)("refuses raw health binding %s %s %s before resource HTTP", async (create, operation, binding) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return { status: 200, bodyText: JSON.stringify({ results: [], updated_at: "synthetic-time" }) };
  };
  await expect(runApiGet(create(transport),
    flags(["api", "get", "--operation", operation, "--path", binding, "--fields", "cpu"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("refuses a generation mismatch without sending a credential", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return listPage([]);
  };
  await expect(runApiGet(session(spy), flags(["api", "get", "--operation", "rux.detection.list"])))
    .rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect(calls).toBe(0);
});

it("resumes a capped collection with the bound query and refuses a changed one", async () => {
  const next = "https://fixture.invalid/api/v2.5/detections?state=active&min_id=2";
  const first: RawTransport = async () => listPage([{ ...detection(1), metadata: "private" }], { count: 2, next });
  const started = await runApiGet(session(first),
    flags(["api", "get", "--operation", "qux.detection.list", "--query", "state=active", "--limit", "1"]));
  expect(started.output).toMatchObject({ count: "1 of 2 rows", cursor: expect.any(String) });
  expect(started.output.rows).toEqual([detection(1)]);
  const cursor = (started.output as { cursor: string }).cursor;
  const second: RawTransport = async () => listPage([{ ...detection(2), metadata: "private" }], { count: 2, next: null });
  const resumed = await runApiGet(session(second),
    flags(["api", "get", "--operation", "qux.detection.list", "--query", "state=active", "--cursor", cursor]));
  expect(resumed.output).toMatchObject({ rows: [detection(2)], complete: true });
  expect(resumed.output.rows).toEqual([detection(2)]);
  expect(resumed.output).not.toHaveProperty("cursor");
  const changed: RawTransport = async () => listPage([detection(2)], { count: 2, next: null });
  await expect(runApiGet(session(changed),
    flags(["api", "get", "--operation", "qux.detection.list", "--query", "state=closed", "--cursor", cursor])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

it("reports an explicit zero for an empty collection", async () => {
  const transport: RawTransport = async () => listPage([], { count: 0 });
  const result = await runApiGet(session(transport),
    flags(["api", "get", "--operation", "qux.detection.list", "--query", "state=empty"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    operation: "qux.detection.list",
    total: 0,
    count: "0 rows",
    rows: "0 rows found for qux.detection.list",
    complete: true,
    help: ["Widen the filters or omit --query to read every row"],
  } });
});

it("rejects window flags on a single-response operation", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  await expect(runApiGet(session(spy),
    flags(["api", "get", "--operation", "qux.detection.show", "--path", "id=1", "--limit", "5"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("reads a RUX collection on a cloud profile with recorded query keys", async () => {
  let url = "";
  const spy: RawTransport = async (request) => {
    url = request.url;
    return listPage([{ id: 1, detection_type: "synthetic-type", state: "active", threat: 71, certainty: 80 }],
      { count: 1 });
  };
  const result = await runApiGet(cloudSession(spy),
    flags(["api", "get", "--operation", "rux.detection.list", "--query", "state=active"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/detections/?state=active&page_size=100");
  expect(result.output).toMatchObject({ profile: "cloud", operation: "rux.detection.list", count: "1 rows" });
});

it("binds a collection path template for member reads", async () => {
  let url = "";
  const spy: RawTransport = async (request) => {
    url = request.url;
    return listPage([{ id: 7, name: "synthetic-host-7" }], { count: 1 });
  };
  const result = await runApiGet(session(spy),
    flags(["api", "get", "--operation", "qux.group.member.list", "--path", "id=8"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/groups/8/members?page_size=100");
  expect(result.output).toMatchObject({ rows: [{ id: 7, name: "synthetic-host-7" }] });
});

it("requires --operation before any HTTP", async () => {
  let calls = 0;
  const spy: RawTransport = async (request) => {
    calls += 1;
    return listPage([]);
  };
  await expect(runApiGet(session(spy), flags(["api", "get"])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("requires --operation and rejects unknown flags at parse time", () => {
  expect(() => parseInvocation(["api", "get", "--operation", "qux.detection.list", "--url", "https://x.invalid"]))
    .toThrow(/Unknown flag/);
  expect(() => parseInvocation(["api", "get"])).not.toThrow();
});
