import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { entityScoringFlags, runEntityScoringList } from "../src/entity-scoring.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".entity-scoring-test-"));
const path = join(scratch, "config.json");
const quxProfile = {
  kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
};
const ruxProfile = {
  kind: "rux", origin: "https://fixture.invalid", apiVersion: "3.4", auth: "oauth",
  clientId: "synthetic-client", secretEnv: "CLOUD_SECRET",
};

beforeEach(() => {
  process.env.SENTINEL_TOKEN = "fake-token-SENTINEL";
  process.env.CLOUD_SECRET = "fake-cloud-secret-SENTINEL";
});
afterEach(() => {
  delete process.env.SENTINEL_TOKEN;
  delete process.env.CLOUD_SECRET;
  rmSync(path, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function cloudSession(transport: RawTransport): Session {
  writeFileSync(path, JSON.stringify({ profiles: { cloud: ruxProfile } }));
  const loaded = loadConfig(path, new SecretRedactor());
  return createSession({ profile: selectProfile(loaded.config, "cloud"), configPath: loaded.path,
    redactor: new SecretRedactor(), transport });
}

function quxSession(transport: RawTransport): Session {
  writeFileSync(path, JSON.stringify({ profiles: { lab: quxProfile } }));
  const loaded = loadConfig(path, new SecretRedactor());
  return createSession({ profile: selectProfile(loaded.config, "lab"), configPath: loaded.path,
    redactor: new SecretRedactor(), transport });
}

// The fake answers the named unversioned exchange, then delegates resource
// GETs to the per-test responder; every RUX route carries its trailing slash.
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

const flags = (argv: string[]): Map<string, string | boolean> =>
  new Map(parseInvocation(argv).flags);

const body = (value: unknown): { status: number; bodyText: string } =>
  ({ status: 200, bodyText: JSON.stringify(value) });

// Checkpoint feed fixtures carry the inventory's next_checkpoint,
// remaining_count and events shape; remaining_count is never a total.
// Scores pass through untouched: no conversion happens in this feed.
const firstScore = { id: 301, entity_id: 7, entity_type: "host", urgency_score: 76,
  event_timestamp: "2026-10-01T12:00:00Z" };
const secondScore = { id: 302, entity_id: 7, entity_type: "host", urgency_score: 81,
  event_timestamp: "2026-10-01T12:05:00Z" };
const batch = (events: unknown[], checkpoint: number | null, remaining = 0): { status: number; bodyText: string } =>
  body({ next_checkpoint: checkpoint, remaining_count: remaining, events });

it.each([
  { state: "empty batch", events: [], limit: "5", checkpointFlag: "from" },
  { state: "cursor resume", events: [firstScore, secondScore], limit: "1", checkpointFlag: "cursor" },
  { state: "drained batch", events: [firstScore], limit: "5", checkpointFlag: "from" },
])("preserves invocation context in the $state command", async ({ events, limit, checkpointFlag }) => {
  const urls: string[] = [];
  const checkpoint = 2;
  const owned = cloudSession(cloudFixture((url) => {
    urls.push(url);
    return batch(events, urls.length === 1 ? checkpoint : 3);
  }));
  const config = join(scratch, "config's file.json");
  const initial = await runEntityScoringList(owned, flags([
    "entity", "scoring", "list", "--config", config, "--type", "host", "--from", "1", "--limit", limit,
    "--event-timestamp-gte", "2026-10-01T12:00:00Z", "--event-timestamp-lte", "2026-10-01T12:05:00Z",
  ]));
  const command = (initial.output.help as string[])[0]!.split("`")[1]!;
  const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" }).split("\0").slice(1, -1);
  const resumedFlags = flags(argv);
  expect(resumedFlags.get("config")).toBe(config);
  expect(resumedFlags.get("profile")).toBe("cloud");
  expect(resumedFlags.get("type")).toBe("host");
  expect(resumedFlags.get("limit")).toBe(limit);
  expect(resumedFlags.get("event-timestamp-gte")).toBe("2026-10-01T12:00:00Z");
  expect(resumedFlags.get("event-timestamp-lte")).toBe("2026-10-01T12:05:00Z");
  expect(resumedFlags.get(checkpointFlag)).toBe(checkpointFlag === "cursor" ? initial.output.cursor : String(checkpoint));
  const resumed = await runEntityScoringList(owned, resumedFlags);
  expect(resumed.failed).toBe(false);
  expect(new URL(urls[1]!).searchParams.get("type")).toBe("host");
  expect(new URL(urls[1]!).searchParams.get("from")).toBe(checkpointFlag === "cursor" ? "1" : String(checkpoint));
  expect(new URL(urls[1]!).searchParams.get("event_timestamp_gte")).toBe("2026-10-01T12:00:00Z");
  expect(new URL(urls[1]!).searchParams.get("event_timestamp_lte")).toBe("2026-10-01T12:05:00Z");
});

it("reads one scoring batch for the required type and returns its checkpoint for continuation", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstScore, secondScore], 2, 0);
  });
  const result = await runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/entity_scoring/?type=host");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    checkpoint: 2,
    remaining_count: 0,
    count: "2 entity scoring events",
    events: [firstScore, secondScore],
    complete: true,
    help: ["Run `vectra-axi entity scoring list --profile cloud --type host --from 2` to continue from the returned checkpoint"],
  } });
});

it("starts from a requested checkpoint and maps inclusive timestamp bounds", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstScore], 3, 4);
  });
  const result = await runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--from", "1",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z", "--event-timestamp-lte", "2026-10-01T12:05:00Z"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/entity_scoring/"
    + "?type=host&from=1&event_timestamp_gte=2026-10-01T12%3A00%3A00Z&event_timestamp_lte=2026-10-01T12%3A05%3A00Z");
  expect(result.output).toMatchObject({ checkpoint: 3, remaining_count: 4, count: "1 entity scoring events" });
});

it("keeps boundary-timestamped rows exactly as returned without client-side filtering", async () => {
  const transport = cloudFixture(() => batch([firstScore, secondScore], 2, 0));
  const result = await runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z", "--event-timestamp-lte", "2026-10-01T12:05:00Z"]));
  expect(result.output.events).toEqual([firstScore, secondScore]);
});

it("never sends the output limit as the upstream batch limit", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstScore, secondScore], 2, 0);
  });
  await runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--limit", "1"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/entity_scoring/?type=host");
});

it("caps a batch at the output limit and resumes the remainder from its cursor", async () => {
  let calls = 0;
  const transport = cloudFixture(() => {
    calls += 1;
    return batch([firstScore, secondScore], 2, 0);
  });
  const owned = cloudSession(transport);
  const capped = await runEntityScoringList(owned,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--limit", "1"]));
  expect(capped.output).toMatchObject({ count: "1 entity scoring events", complete: true });
  expect(capped.output.events).toEqual([firstScore]);
  const cursor = capped.output.cursor as string;
  expect(typeof cursor).toBe("string");
  expect(capped.output.help).toEqual([
    `Run \`vectra-axi entity scoring list --profile cloud --type host --limit 1 --cursor ${cursor}\` for the rest of this batch`,
  ]);
  const resumed = await runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--limit", "1"]),
      ["cursor", cursor]]));
  expect(resumed.output).toMatchObject({ count: "1 entity scoring events", complete: true });
  expect(resumed.output.events).toEqual([secondScore]);
  expect(resumed.output.help).toEqual([
    "Run `vectra-axi entity scoring list --profile cloud --type host --limit 1 --from 2` to continue from the returned checkpoint",
  ]);
  expect(calls).toBe(2);
});

it("preserves the window size across successive resumes without --limit", async () => {
  const thirdScore = { id: 303 };
  const fourthScore = { id: 304 };
  const owned = cloudSession(cloudFixture(() => batch([firstScore, secondScore, thirdScore, fourthScore], 2)));
  const first = await runEntityScoringList(owned,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--limit", "1"]));
  const second = await runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]),
      ["cursor", first.output.cursor as string]]));
  const third = await runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]),
      ["cursor", second.output.cursor as string]]));
  const fourth = await runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]),
      ["cursor", third.output.cursor as string]]));
  expect(first.output.events).toEqual([firstScore]);
  expect(second.output.events).toEqual([secondScore]);
  expect(third.output.events).toEqual([thirdScore]);
  expect(fourth.output.events).toEqual([fourthScore]);
  expect(second.output.help).toEqual([
    `Run \`vectra-axi entity scoring list --profile cloud --type host --cursor ${second.output.cursor}\` for the rest of this batch`,
  ]);
  expect(third.output.help).toEqual([
    `Run \`vectra-axi entity scoring list --profile cloud --type host --cursor ${third.output.cursor}\` for the rest of this batch`,
  ]);
  expect(fourth.output.help).toEqual([
    "Run `vectra-axi entity scoring list --profile cloud --type host --from 2` to continue from the returned checkpoint",
  ]);
  expect(fourth.output).not.toHaveProperty("cursor");
});

it("resumes a --from cursor without repeating --from and re-sends the checkpoint", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((requestUrl) => {
    urls.push(requestUrl);
    return batch([firstScore, secondScore], 2, 0);
  });
  const owned = cloudSession(transport);
  const capped = await runEntityScoringList(owned,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--from", "1", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  const resumed = await runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]),
      ["cursor", cursor]]));
  expect(resumed.output.events).toEqual([secondScore]);
  expect(urls).toEqual([
    "https://fixture.invalid/api/v3.4/events/entity_scoring/?type=host&from=1",
    "https://fixture.invalid/api/v3.4/events/entity_scoring/?type=host&from=1",
  ]);
});

it("rejects a replay with changed rows before applying its offset", async () => {
  let events: readonly unknown[] = [firstScore, secondScore];
  const owned = cloudSession(cloudFixture(() => batch([...events], 2)));
  const initial = await runEntityScoringList(owned,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--limit", "1"]));
  expect(initial.output.events).toEqual([firstScore]);
  events = [firstScore, { id: 303 }];
  await expect(runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]),
      ["cursor", initial.output.cursor as string]]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID", message: "Vectra entity scoring event feed changed since the cursor was issued",
  });
});

it("rejects resuming with a changed type, changed filters or a different --from", async () => {
  const transport = cloudFixture(() => batch([firstScore, secondScore], 2, 0));
  const owned = cloudSession(transport);
  const capped = await runEntityScoringList(owned,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  await expect(runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "account"]),
      ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("query context changed"),
  });
  await expect(runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z"]), ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("query context changed"),
  });
  await expect(runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--from", "9"]),
      ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("cannot combine --from with --cursor"),
  });
});

it("refuses a detection-event cursor instead of resuming another feed", async () => {
  const forged = Buffer.from(JSON.stringify({
    v: 1,
    profile: { name: "cloud", kind: "rux", origin: "https://fixture.invalid", apiVersion: "3.4" },
    operation: "rux.detection.event.list",
    query: { type: "host" },
    offset: 0,
    remaining: 1,
    batchHash: "a".repeat(64),
  }), "utf8").toString("base64url");
  await expect(runEntityScoringList(
    cloudSession(cloudFixture(() => batch([firstScore], 1))),
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]),
      ["cursor", forged]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
    message: "Invalid entity scoring event cursor: the cursor belongs to rux.detection.event.list, not rux.entity.scoring.list",
  });
});

it.each(["1", "0001"])("fails a non-advancing integer checkpoint requested as %s with its rows retained", async (from) => {
  const transport = cloudFixture(() => batch([firstScore], 1, 1));
  const result = await runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--from", from]));
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    count: "1 entity scoring events",
    events: [firstScore],
    complete: false,
    code: "CONTINUATION_REPEATED",
    checkpoint: 1,
  });
  expect(result.output).not.toHaveProperty("cursor");
});

it("counts only offset rows retained when a resumed checkpoint stops advancing", async () => {
  let checkpoint = 2;
  const owned = cloudSession(cloudFixture(() => batch([firstScore, secondScore], checkpoint)));
  const first = await runEntityScoringList(owned,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--from", "1", "--limit", "1"]));
  checkpoint = 1;
  const result = await runEntityScoringList(owned,
    new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]),
      ["cursor", first.output.cursor as string]]));
  expect(result).toMatchObject({ failed: true, output: {
    count: "1 entity scoring events",
    events: [secondScore],
    code: "CONTINUATION_REPEATED",
  } });
  expect(result.output).not.toHaveProperty("cursor");
});

it("reports an empty batch as success with an explicit zero and its checkpoint", async () => {
  const transport = cloudFixture(() => batch([], 5, 0));
  const result = await runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--from", "4"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    checkpoint: 5,
    remaining_count: 0,
    count: "0 entity scoring events",
    events: "0 entity scoring events found from checkpoint 4",
    complete: true,
    help: ["Run `vectra-axi entity scoring list --profile cloud --type host --from 5` to continue from the returned checkpoint"],
  } });
});

it.each([{ events: [] }, { events: [firstScore] }])("retains a zero checkpoint and advertises its continuation for %j", async ({ events }) => {
  const result = await runEntityScoringList(cloudSession(cloudFixture(() => batch(events, 0))),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]));
  expect(result.failed).toBe(false);
  expect(result.output.checkpoint).toBe(0);
  expect(result.output.help).toEqual([
    "Run `vectra-axi entity scoring list --profile cloud --type host --from 0` to continue from the returned checkpoint",
  ]);
});

it.each(["2", 2.5, Number.MAX_SAFE_INTEGER + 1])("rejects a non-integer wire checkpoint %j", async (checkpoint) => {
  const owned = cloudSession(cloudFixture(() => body({ next_checkpoint: checkpoint, events: [firstScore] })));
  await expect(runEntityScoringList(owned,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
  });
});

it("reports remaining_count as returned and never invents a total", async () => {
  const transport = cloudFixture(() => batch([firstScore, secondScore], 2, 37));
  const result = await runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]));
  expect(result.output).toMatchObject({ remaining_count: 37, count: "2 entity scoring events" });
  expect(result.output).not.toHaveProperty("total");
});

it("reports event denial as a thrown error rather than an empty result", async () => {
  const transport = cloudFixture(() => ({ status: 403, bodyText: "{}" }));
  await expect(runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("rejects a batch without events or without a checkpoint for returned rows", async () => {
  const owned = cloudSession(cloudFixture(() => body({ next_checkpoint: 1, remaining_count: 0 })));
  await expect(runEntityScoringList(owned,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
  });
  const missing = cloudSession(cloudFixture(() => body({ next_checkpoint: null, remaining_count: 1, events: [firstScore] })));
  await expect(runEntityScoringList(missing,
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID", message: expect.stringContaining("no checkpoint"),
  });
});

it("cancels cleanly with no HTTP call when already aborted", async () => {
  let calls = 0;
  const transport = cloudFixture(() => {
    calls += 1;
    return batch([firstScore], 1, 0);
  });
  const controller = new AbortController();
  controller.abort();
  await expect(runEntityScoringList(cloudSession(transport),
    flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host"]),
    { signal: controller.signal })).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
  });
  expect(calls).toBe(0);
});

it("refuses the feed on an on-prem profile before any credential or HTTP work", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return batch([firstScore], 1, 0);
  };
  await expect(runEntityScoringList(quxSession(transport),
    flags(["entity", "scoring", "list", "--profile", "lab", "--type", "host"]))).rejects.toMatchObject({
    code: "OPERATION_UNKNOWN",
  });
  expect(calls).toBe(0);
});

// Flag validation runs before profile selection in cli.ts, so these unit
// cases assert the validators throw without any session or transport.
describe("flag validation before profile selection", () => {
  it.each([
    ["missing type", () => entityScoringFlags(
      flags(["entity", "scoring", "list", "--profile", "cloud"])),
      "entity scoring list requires --type"],
    ["empty type", () => entityScoringFlags(new Map([["type", ""]])),
      "--type must be one of: host, account"],
    ["unsupported type", () => entityScoringFlags(new Map([["type", "detection"]])),
      "--type must be one of: host, account"],
    ["bad limit", () => entityScoringFlags(
      flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--limit", "0"])),
      "--limit must be a positive integer"],
    ["empty from", () => entityScoringFlags(new Map([["type", "host"], ["from", ""]])),
      "--from requires a non-empty value"],
    ["string checkpoint", () => entityScoringFlags(new Map([["type", "host"], ["from", "evt-1"]])),
      "--from must be an integer checkpoint"],
    ["fractional checkpoint", () => entityScoringFlags(new Map([["type", "host"], ["from", "1.5"]])),
      "--from must be an integer checkpoint"],
    ["unsafe checkpoint", () => entityScoringFlags(new Map([["type", "host"], ["from", "9007199254740992"]])),
      "--from must be an integer checkpoint"],
    ["empty timestamp bound", () => entityScoringFlags(new Map([["type", "host"], ["event-timestamp-gte", "  "]])),
      "--event-timestamp-gte requires a non-empty value"],
    ["from with cursor", () => entityScoringFlags(
      new Map([...flags(["entity", "scoring", "list", "--profile", "cloud", "--type", "host", "--from", "1"]),
        ["cursor", "opaque"]])),
      "cannot combine --from with --cursor"],
  ])("rejects %s before profile selection", (_name, run, message) => {
    expect(run).toThrowError(message);
  });
});
