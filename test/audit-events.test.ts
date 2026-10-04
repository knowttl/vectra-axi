import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { auditEventFlags, runAuditEventList } from "../src/audit-events.js";
import { auditFlagShapes, runAuditList } from "../src/audits.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".audit-events-test-"));
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
const firstEvent = { id: 301, event_action: "created", event_object: "filter",
  event_timestamp: "2026-10-01T12:00:00Z" };
const secondEvent = { id: 302, event_action: "updated", event_object: "filter",
  event_timestamp: "2026-10-01T12:05:00Z" };
const batch = (events: unknown[], checkpoint: number | null, remaining = 0): { status: number; bodyText: string } =>
  body({ next_checkpoint: checkpoint, remaining_count: remaining, events });

it.each([
  { state: "empty batch", events: [], limit: "5", checkpointFlag: "from" },
  { state: "cursor resume", events: [firstEvent, secondEvent], limit: "1", checkpointFlag: "cursor" },
  { state: "drained batch", events: [firstEvent], limit: "5", checkpointFlag: "from" },
])("preserves invocation context in the $state command", async ({ events, limit, checkpointFlag }) => {
  const urls: string[] = [];
  const checkpoint = 2;
  const owned = cloudSession(cloudFixture((url) => {
    urls.push(url);
    return batch(events, urls.length === 1 ? checkpoint : 3);
  }));
  const config = join(scratch, "config's file.json");
  const initial = await runAuditEventList(owned, flags([
    "audit", "list", "--config", config, "--from", "1", "--limit", limit,
    "--start-date", "2026-10-01", "--end-date", "2026-10-02",
  ]));
  const command = (initial.output.help as string[])[0]!.split("`")[1]!;
  const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" }).split("\0").slice(1, -1);
  const resumedFlags = flags(argv);
  expect(resumedFlags.get("config")).toBe(config);
  expect(resumedFlags.get("profile")).toBe("cloud");
  expect(resumedFlags.get("limit")).toBe(limit);
  expect(resumedFlags.get("start-date")).toBe("2026-10-01");
  expect(resumedFlags.get("end-date")).toBe("2026-10-02");
  expect(resumedFlags.get(checkpointFlag)).toBe(checkpointFlag === "cursor" ? initial.output.cursor : String(checkpoint));
  const resumed = await runAuditEventList(owned, resumedFlags);
  expect(resumed.failed).toBe(false);
  expect(new URL(urls[1]!).searchParams.get("from")).toBe(checkpointFlag === "cursor" ? "1" : String(checkpoint));
  expect(new URL(urls[1]!).searchParams.get("event_timestamp_gte")).toBe("2026-10-01T00:00:00Z");
  expect(new URL(urls[1]!).searchParams.get("event_timestamp_lte")).toBe("2026-10-02T23:59:59Z");
});

it("reads one event batch and returns its checkpoint for continuation", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstEvent, secondEvent], 2, 0);
  });
  const result = await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/audits/");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    checkpoint: 2,
    remaining_count: 0,
    count: "2 audit events",
    events: [firstEvent, secondEvent],
    complete: true,
    help: ["Run `vectra-axi audit list --profile cloud --from 2` to continue from the returned checkpoint"],
  } });
});

it("expands a date pair to whole-day timestamp bounds", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstEvent], 3, 4);
  });
  const result = await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud", "--from", "1",
      "--start-date", "2026-10-01", "--end-date", "2026-10-02"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/audits/"
    + "?from=1&event_timestamp_gte=2026-10-01T00%3A00%3A00Z&event_timestamp_lte=2026-10-02T23%3A59%3A59Z");
  expect(result.output).toMatchObject({ checkpoint: 3, remaining_count: 4, count: "1 audit events" });
});

it("expands a single-day pair to the full day", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstEvent], 3, 0);
  });
  await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud",
      "--start-date", "2026-10-01", "--end-date", "2026-10-01"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/audits/"
    + "?event_timestamp_gte=2026-10-01T00%3A00%3A00Z&event_timestamp_lte=2026-10-01T23%3A59%3A59Z");
});

it("passes explicit timestamp bounds through for the server to apply inclusively", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstEvent], 3, 4);
  });
  const result = await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud", "--from", "1",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z", "--event-timestamp-lte", "2026-10-01T12:05:00Z"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/audits/"
    + "?from=1&event_timestamp_gte=2026-10-01T12%3A00%3A00Z&event_timestamp_lte=2026-10-01T12%3A05%3A00Z");
  expect(result.output).toMatchObject({ checkpoint: 3, remaining_count: 4, count: "1 audit events" });
});

it("keeps boundary-timestamped rows exactly as returned without client-side filtering", async () => {
  const transport = cloudFixture(() => batch([firstEvent, secondEvent], 2, 0));
  const result = await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z", "--event-timestamp-lte", "2026-10-01T12:05:00Z"]));
  expect(result.output.events).toEqual([firstEvent, secondEvent]);
});

it("never sends the output limit as the upstream batch limit", async () => {
  let url = "";
  const transport = cloudFixture((requestUrl) => {
    url = requestUrl;
    return batch([firstEvent, secondEvent], 2, 0);
  });
  await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud", "--limit", "1"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/audits/");
});

it("caps a batch at the output limit and resumes the remainder from its cursor", async () => {
  let calls = 0;
  const transport = cloudFixture(() => {
    calls += 1;
    return batch([firstEvent, secondEvent], 2, 0);
  });
  const owned = cloudSession(transport);
  const capped = await runAuditEventList(owned,
    flags(["audit", "list", "--profile", "cloud", "--limit", "1"]));
  expect(capped.output).toMatchObject({ count: "1 audit events", complete: true });
  expect(capped.output.events).toEqual([firstEvent]);
  const cursor = capped.output.cursor as string;
  expect(typeof cursor).toBe("string");
  expect(capped.output.help).toEqual([
    `Run \`vectra-axi audit list --profile cloud --limit 1 --cursor ${cursor}\` for the rest of this batch`,
  ]);
  const resumed = await runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud", "--limit", "1"]), ["cursor", cursor]]));
  expect(resumed.output).toMatchObject({ count: "1 audit events", complete: true });
  expect(resumed.output.events).toEqual([secondEvent]);
  expect(resumed.output.help).toEqual([
    "Run `vectra-axi audit list --profile cloud --limit 1 --from 2` to continue from the returned checkpoint",
  ]);
  expect(calls).toBe(2);
});

it("preserves the window size across successive resumes without --limit", async () => {
  const thirdEvent = { id: 303 };
  const fourthEvent = { id: 304 };
  const owned = cloudSession(cloudFixture(() => batch([firstEvent, secondEvent, thirdEvent, fourthEvent], 2)));
  const first = await runAuditEventList(owned,
    flags(["audit", "list", "--profile", "cloud", "--limit", "1"]));
  const second = await runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud"]), ["cursor", first.output.cursor as string]]));
  const third = await runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud"]), ["cursor", second.output.cursor as string]]));
  const fourth = await runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud"]), ["cursor", third.output.cursor as string]]));
  expect(first.output.events).toEqual([firstEvent]);
  expect(second.output.events).toEqual([secondEvent]);
  expect(third.output.events).toEqual([thirdEvent]);
  expect(fourth.output.events).toEqual([fourthEvent]);
  expect(second.output.help).toEqual([
    `Run \`vectra-axi audit list --profile cloud --cursor ${second.output.cursor}\` for the rest of this batch`,
  ]);
  expect(third.output.help).toEqual([
    `Run \`vectra-axi audit list --profile cloud --cursor ${third.output.cursor}\` for the rest of this batch`,
  ]);
  expect(fourth.output.help).toEqual([
    "Run `vectra-axi audit list --profile cloud --from 2` to continue from the returned checkpoint",
  ]);
  expect(fourth.output).not.toHaveProperty("cursor");
});

it("resumes a --from cursor without repeating --from and re-sends the checkpoint", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((requestUrl) => {
    urls.push(requestUrl);
    return batch([firstEvent, secondEvent], 2, 0);
  });
  const owned = cloudSession(transport);
  const capped = await runAuditEventList(owned,
    flags(["audit", "list", "--profile", "cloud", "--from", "1", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  const resumed = await runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud"]), ["cursor", cursor]]));
  expect(resumed.output.events).toEqual([secondEvent]);
  expect(urls).toEqual([
    "https://fixture.invalid/api/v3.4/events/audits/?from=1",
    "https://fixture.invalid/api/v3.4/events/audits/?from=1",
  ]);
});

it("rejects a replay with changed rows before applying its offset", async () => {
  let events: readonly unknown[] = [firstEvent, secondEvent];
  const owned = cloudSession(cloudFixture(() => batch([...events], 2)));
  const initial = await runAuditEventList(owned,
    flags(["audit", "list", "--profile", "cloud", "--limit", "1"]));
  expect(initial.output.events).toEqual([firstEvent]);
  events = [firstEvent, { id: 303 }];
  await expect(runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud"]),
      ["cursor", initial.output.cursor as string]]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID", message: "Vectra audit event feed changed since the cursor was issued",
  });
});

it("rejects resuming with changed filters or a different --from", async () => {
  const transport = cloudFixture(() => batch([firstEvent, secondEvent], 2, 0));
  const owned = cloudSession(transport);
  const capped = await runAuditEventList(owned,
    flags(["audit", "list", "--profile", "cloud", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  await expect(runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud",
      "--event-timestamp-gte", "2026-10-01T12:00:00Z"]), ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("query context changed"),
  });
  await expect(runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud", "--from", "9"]),
      ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("cannot combine --from with --cursor"),
  });
});

it.each(["1", "0001"])("fails a non-advancing integer checkpoint requested as %s with its rows retained", async (from) => {
  const transport = cloudFixture(() => batch([firstEvent], 1, 1));
  const result = await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud", "--from", from]));
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    count: "1 audit events",
    events: [firstEvent],
    complete: false,
    code: "CONTINUATION_REPEATED",
    checkpoint: 1,
  });
  expect(result.output).not.toHaveProperty("cursor");
});

it("counts only offset rows retained when a resumed checkpoint stops advancing", async () => {
  let checkpoint = 2;
  const owned = cloudSession(cloudFixture(() => batch([firstEvent, secondEvent], checkpoint)));
  const first = await runAuditEventList(owned,
    flags(["audit", "list", "--profile", "cloud", "--from", "1", "--limit", "1"]));
  checkpoint = 1;
  const result = await runAuditEventList(owned,
    new Map([...flags(["audit", "list", "--profile", "cloud"]),
      ["cursor", first.output.cursor as string]]));
  expect(result).toMatchObject({ failed: true, output: {
    count: "1 audit events",
    events: [secondEvent],
    code: "CONTINUATION_REPEATED",
  } });
  expect(result.output).not.toHaveProperty("cursor");
});

it("reports an empty batch as success with an explicit zero and its checkpoint", async () => {
  const transport = cloudFixture(() => batch([], 5, 0));
  const result = await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud", "--from", "4"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    checkpoint: 5,
    remaining_count: 0,
    count: "0 audit events",
    events: "0 audit events found from checkpoint 4",
    complete: true,
    help: ["Run `vectra-axi audit list --profile cloud --from 5` to continue from the returned checkpoint"],
  } });
});

it.each([{ events: [] }, { events: [firstEvent] }])("retains a zero checkpoint and advertises its continuation for %j", async ({ events }) => {
  const result = await runAuditEventList(cloudSession(cloudFixture(() => batch(events, 0))),
    flags(["audit", "list", "--profile", "cloud"]));
  expect(result.failed).toBe(false);
  expect(result.output.checkpoint).toBe(0);
  expect(result.output.help).toEqual([
    "Run `vectra-axi audit list --profile cloud --from 0` to continue from the returned checkpoint",
  ]);
});

it.each(["2", 2.5, Number.MAX_SAFE_INTEGER + 1])("rejects a non-integer wire checkpoint %j", async (checkpoint) => {
  const owned = cloudSession(cloudFixture(() => body({ next_checkpoint: checkpoint, events: [firstEvent] })));
  await expect(runAuditEventList(owned,
    flags(["audit", "list", "--profile", "cloud"]))).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("reports remaining_count as returned and never invents a total", async () => {
  const transport = cloudFixture(() => batch([firstEvent, secondEvent], 2, 37));
  const result = await runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud"]));
  expect(result.output).toMatchObject({ remaining_count: 37, count: "2 audit events" });
  expect(result.output).not.toHaveProperty("total");
});

it("reports event denial as a thrown error rather than an empty result", async () => {
  const transport = cloudFixture(() => ({ status: 403, bodyText: "{}" }));
  await expect(runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("rejects a batch without events or without a checkpoint for returned rows", async () => {
  const owned = cloudSession(cloudFixture(() => body({ next_checkpoint: 1, remaining_count: 0 })));
  await expect(runAuditEventList(owned,
    flags(["audit", "list", "--profile", "cloud"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
  });
  const missing = cloudSession(cloudFixture(() => body({ next_checkpoint: null, remaining_count: 1, events: [firstEvent] })));
  await expect(runAuditEventList(missing,
    flags(["audit", "list", "--profile", "cloud"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID", message: expect.stringContaining("no checkpoint"),
  });
});

it("cancels cleanly with no HTTP call when already aborted", async () => {
  let calls = 0;
  const transport = cloudFixture(() => {
    calls += 1;
    return batch([firstEvent], 1, 0);
  });
  const controller = new AbortController();
  controller.abort();
  await expect(runAuditEventList(cloudSession(transport),
    flags(["audit", "list", "--profile", "cloud"]), { signal: controller.signal })).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
  });
  expect(calls).toBe(0);
});

it("refuses the feed on an on-prem profile before any credential or HTTP work", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return batch([firstEvent], 1, 0);
  };
  await expect(runAuditEventList(quxSession(transport),
    flags(["audit", "list", "--profile", "lab"]))).rejects.toMatchObject({
    code: "OPERATION_UNKNOWN",
  });
  expect(calls).toBe(0);
});

it.each([
  ["from", ["--from", "1"]],
  ["limit", ["--limit", "1"]],
  ["cursor", ["--cursor", "opaque"]],
  ["event-timestamp-gte", ["--event-timestamp-gte", "2026-10-01T12:00:00Z"]],
  ["event-timestamp-lte", ["--event-timestamp-lte", "2026-10-01T12:00:00Z"]],
])("refuses the QUX date-windowed read with RUX-only flag %s", async (_name, extra) => {
  const owned = quxSession(async () => body([]));
  await expect(runAuditList(owned,
    flags(["audit", "list", "--start-date", "2026-10-01", "--end-date", "2026-10-02", ...extra])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR",
      message: expect.stringContaining("only to audit event reads on a RUX v3.4 cloud profile") });
});

// Flag validation runs before profile selection in cli.ts, so these unit
// cases assert the validators throw without any session or transport.
describe("flag validation before profile selection", () => {
  it.each([
    ["bad limit", () => auditEventFlags(
      flags(["audit", "list", "--profile", "cloud", "--limit", "0"])),
      "--limit must be a positive integer"],
    ["empty from", () => auditEventFlags(new Map([["from", ""]])),
      "--from requires a non-empty value"],
    ["string checkpoint", () => auditEventFlags(new Map([["from", "evt-1"]])),
      "--from must be an integer checkpoint"],
    ["fractional checkpoint", () => auditEventFlags(new Map([["from", "1.5"]])),
      "--from must be an integer checkpoint"],
    ["unsafe checkpoint", () => auditEventFlags(new Map([["from", "9007199254740992"]])),
      "--from must be an integer checkpoint"],
    ["empty timestamp bound", () => auditEventFlags(new Map([["event-timestamp-gte", "  "]])),
      "--event-timestamp-gte requires a non-empty value"],
    ["lone start date", () => auditEventFlags(new Map([["start-date", "2026-10-01"]])),
      "requires --end-date"],
    ["lone end date", () => auditEventFlags(new Map([["end-date", "2026-10-02"]])),
      "requires --start-date"],
    ["bad date shape", () => auditEventFlags(
      new Map([["start-date", "2026-1-1"], ["end-date", "2026-10-02"]])),
      "--start-date must be a YYYY-MM-DD UTC calendar day"],
    ["impossible day", () => auditEventFlags(
      new Map([["start-date", "2026-02-30"], ["end-date", "2026-10-02"]])),
      "--start-date is not a real calendar day"],
    ["reversed dates", () => auditEventFlags(
      new Map([["start-date", "2026-10-03"], ["end-date", "2026-10-02"]])),
      "--start-date 2026-10-03 is after --end-date 2026-10-02"],
    ["dates with timestamps", () => auditEventFlags(
      new Map([["start-date", "2026-10-01"], ["end-date", "2026-10-02"],
        ["event-timestamp-gte", "2026-10-01T12:00:00Z"]])),
      "cannot combine date flags with explicit timestamp filters"],
    ["from with cursor", () => auditEventFlags(
      new Map([...flags(["audit", "list", "--profile", "cloud", "--from", "1"]),
        ["cursor", "opaque"]])),
      "cannot combine --from with --cursor"],
  ])("rejects %s before profile selection", (_name, run, message) => {
    expect(run).toThrowError(message);
  });

  it("leaves lone dates to the runners instead of failing shapes early", () => {
    expect(() => auditFlagShapes(new Map([["end-date", "2026-10-02"]]))).not.toThrow();
  });
});
