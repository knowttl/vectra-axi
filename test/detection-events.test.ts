import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { detectionEventFlags, runDetectionEventList } from "../src/detection-events.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".detection-events-test-"));
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
const firstEvent = { id: 201, detection_id: 1, event_timestamp: "2026-10-01T12:00:00Z" };
const secondEvent = { id: 202, detection_id: 1, event_timestamp: "2026-10-01T12:05:00Z" };
const batch = (events: unknown[], checkpoint: string | null, remaining = 0): { status: number; bodyText: string } =>
  body({ next_checkpoint: checkpoint, remaining_count: remaining, events });

it("reads one event batch and returns its checkpoint for continuation", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstEvent, secondEvent], "evt-2", 0);
  });
  const result = await runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/detections/");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    checkpoint: "evt-2",
    remaining_count: 0,
    count: "2 detection events",
    events: [firstEvent, secondEvent],
    complete: true,
    help: ["Pass --from evt-2 to continue from the returned checkpoint"],
  } });
});

it("starts from a requested checkpoint and maps inclusive timestamp bounds", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstEvent], "evt-3", 4);
  });
  const result = await runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud", "--from", "evt-1",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z", "--event-timestamp-lte", "2026-10-01T12:05:00Z"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/detections/"
    + "?from=evt-1&event_timestamp_gte=2026-10-01T12%3A00%3A00Z&event_timestamp_lte=2026-10-01T12%3A05%3A00Z");
  expect(result.output).toMatchObject({ checkpoint: "evt-3", remaining_count: 4, count: "1 detection events" });
});

it("keeps boundary-timestamped rows exactly as returned without client-side filtering", async () => {
  const transport = cloudFixture(() => batch([firstEvent, secondEvent], "evt-2", 0));
  const result = await runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z", "--event-timestamp-lte", "2026-10-01T12:05:00Z"]));
  expect(result.output.events).toEqual([firstEvent, secondEvent]);
});

it("never sends the output limit as the upstream batch limit", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstEvent, secondEvent], "evt-2", 0);
  });
  await runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud", "--limit", "1"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/detections/");
});

it("caps a batch at the output limit and resumes the remainder from its cursor", async () => {
  let calls = 0;
  const transport = cloudFixture(() => {
    calls += 1;
    return batch([firstEvent, secondEvent], "evt-2", 0);
  });
  const owned = cloudSession(transport);
  const capped = await runDetectionEventList(owned,
    flags(["detection", "event", "list", "--profile", "cloud", "--limit", "1"]));
  expect(capped.output).toMatchObject({ count: "1 detection events", complete: true });
  expect(capped.output.events).toEqual([firstEvent]);
  const cursor = capped.output.cursor as string;
  expect(typeof cursor).toBe("string");
  const resumed = await runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud", "--limit", "1"]), ["cursor", cursor]]));
  expect(resumed.output).toMatchObject({ count: "1 detection events", complete: true });
  expect(resumed.output.events).toEqual([secondEvent]);
  expect(calls).toBe(2);
});

it("preserves the window size across successive resumes without --limit", async () => {
  const thirdEvent = { id: 203 };
  const fourthEvent = { id: 204 };
  const owned = cloudSession(cloudFixture(() => batch([firstEvent, secondEvent, thirdEvent, fourthEvent], "evt-2")));
  const first = await runDetectionEventList(owned,
    flags(["detection", "event", "list", "--profile", "cloud", "--limit", "1"]));
  const second = await runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud"]), ["cursor", first.output.cursor as string]]));
  const third = await runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud"]), ["cursor", second.output.cursor as string]]));
  const fourth = await runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud"]), ["cursor", third.output.cursor as string]]));
  expect(first.output.events).toEqual([firstEvent]);
  expect(second.output.events).toEqual([secondEvent]);
  expect(third.output.events).toEqual([thirdEvent]);
  expect(fourth.output.events).toEqual([fourthEvent]);
  expect(fourth.output).not.toHaveProperty("cursor");
});

it("resumes a --from cursor without repeating --from and re-sends the checkpoint", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((requestUrl) => {
    urls.push(requestUrl);
    return batch([firstEvent, secondEvent], "evt-2", 0);
  });
  const owned = cloudSession(transport);
  const capped = await runDetectionEventList(owned,
    flags(["detection", "event", "list", "--profile", "cloud", "--from", "evt-1", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  const resumed = await runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud"]), ["cursor", cursor]]));
  expect(resumed.output.events).toEqual([secondEvent]);
  expect(urls).toEqual([
    "https://fixture.invalid/api/v3.4/events/detections/?from=evt-1",
    "https://fixture.invalid/api/v3.4/events/detections/?from=evt-1",
  ]);
});

it("rejects a replay with changed rows before applying its offset", async () => {
  let events: readonly unknown[] = [firstEvent, secondEvent];
  const owned = cloudSession(cloudFixture(() => batch([...events], "evt-2")));
  const initial = await runDetectionEventList(owned,
    flags(["detection", "event", "list", "--profile", "cloud", "--limit", "1"]));
  expect(initial.output.events).toEqual([firstEvent]);
  events = [firstEvent, { id: 203 }];
  await expect(runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud"]),
      ["cursor", initial.output.cursor as string]]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID", message: "Vectra detection event feed changed since the cursor was issued",
  });
});

it("rejects resuming with changed filters or a different --from", async () => {
  const transport = cloudFixture(() => batch([firstEvent, secondEvent], "evt-2", 0));
  const owned = cloudSession(transport);
  const capped = await runDetectionEventList(owned,
    flags(["detection", "event", "list", "--profile", "cloud", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  await expect(runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z"]), ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("query context changed"),
  });
  await expect(runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud", "--from", "evt-9"]),
      ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("cannot combine --from with --cursor"),
  });
});

it("fails a non-advancing checkpoint with its rows retained instead of a resumption loop", async () => {
  const transport = cloudFixture(() => batch([firstEvent], "evt-1", 1));
  const result = await runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud", "--from", "evt-1"]));
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    count: "1 detection events",
    events: [firstEvent],
    complete: false,
    code: "CONTINUATION_REPEATED",
    checkpoint: "evt-1",
  });
  expect(result.output).not.toHaveProperty("cursor");
});

it("counts only offset rows retained when a resumed checkpoint stops advancing", async () => {
  let checkpoint = "evt-2";
  const owned = cloudSession(cloudFixture(() => batch([firstEvent, secondEvent], checkpoint)));
  const first = await runDetectionEventList(owned,
    flags(["detection", "event", "list", "--profile", "cloud", "--from", "evt-1", "--limit", "1"]));
  checkpoint = "evt-1";
  const result = await runDetectionEventList(owned,
    new Map([...flags(["detection", "event", "list", "--profile", "cloud"]),
      ["cursor", first.output.cursor as string]]));
  expect(result).toMatchObject({ failed: true, output: {
    count: "1 detection events",
    events: [secondEvent],
    code: "CONTINUATION_REPEATED",
  } });
  expect(result.output).not.toHaveProperty("cursor");
});

it("reports an empty batch as success with an explicit zero and its checkpoint", async () => {
  const transport = cloudFixture(() => batch([], "evt-5", 0));
  const result = await runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud", "--from", "evt-4"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    checkpoint: "evt-5",
    remaining_count: 0,
    count: "0 detection events",
    events: "0 detection events found from checkpoint evt-4",
    complete: true,
    help: ["Pass --from evt-5 to continue from the returned checkpoint"],
  } });
});

it("reports remaining_count as returned and never invents a total", async () => {
  const transport = cloudFixture(() => batch([firstEvent, secondEvent], "evt-2", 37));
  const result = await runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud"]));
  expect(result.output).toMatchObject({ remaining_count: 37, count: "2 detection events" });
  expect(result.output).not.toHaveProperty("total");
});

it("reports event denial as a thrown error rather than an empty result", async () => {
  const transport = cloudFixture(() => ({ status: 403, bodyText: "{}" }));
  await expect(runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("rejects a batch without events or without a checkpoint for returned rows", async () => {
  const owned = cloudSession(cloudFixture(() => body({ next_checkpoint: "evt-1", remaining_count: 0 })));
  await expect(runDetectionEventList(owned,
    flags(["detection", "event", "list", "--profile", "cloud"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
  });
  const missing = cloudSession(cloudFixture(() => body({ next_checkpoint: null, remaining_count: 1, events: [firstEvent] })));
  await expect(runDetectionEventList(missing,
    flags(["detection", "event", "list", "--profile", "cloud"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID", message: expect.stringContaining("no checkpoint"),
  });
});

it("cancels cleanly with no HTTP call when already aborted", async () => {
  let calls = 0;
  const transport = cloudFixture(() => {
    calls += 1;
    return batch([firstEvent], "evt-1", 0);
  });
  const controller = new AbortController();
  controller.abort();
  await expect(runDetectionEventList(cloudSession(transport),
    flags(["detection", "event", "list", "--profile", "cloud"]), { signal: controller.signal })).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
  });
  expect(calls).toBe(0);
});

it("refuses the feed on an on-prem profile before any credential or HTTP work", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return batch([firstEvent], "evt-1", 0);
  };
  await expect(runDetectionEventList(quxSession(transport),
    flags(["detection", "event", "list", "--profile", "lab"]))).rejects.toMatchObject({
    code: "OPERATION_UNKNOWN",
  });
  expect(calls).toBe(0);
});

// Flag validation runs before profile selection in cli.ts, so these unit
// cases assert the validators throw without any session or transport.
describe("flag validation before profile selection", () => {
  it.each([
    ["bad limit", () => detectionEventFlags(
      flags(["detection", "event", "list", "--profile", "cloud", "--limit", "0"])),
      "--limit must be a positive integer"],
    ["empty from", () => detectionEventFlags(new Map([["from", ""]])),
      "--from requires a non-empty value"],
    ["empty timestamp bound", () => detectionEventFlags(new Map([["event-timestamp-gte", "  "]])),
      "--event-timestamp-gte requires a non-empty value"],
    ["from with cursor", () => detectionEventFlags(
      new Map([...flags(["detection", "event", "list", "--profile", "cloud", "--from", "evt-1"]),
        ["cursor", "opaque"]])),
      "cannot combine --from with --cursor"],
  ])("rejects %s before profile selection", (_name, run, message) => {
    expect(run).toThrowError(message);
  });
});
