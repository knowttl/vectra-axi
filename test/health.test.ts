import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { healthCheck, healthEventFlags, healthEventRelease, runHealthEventList, runHealthList,
  runHealthShow } from "../src/health.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".health-test-"));
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

function session(transport: RawTransport, extra: Record<string, unknown> = {}): Session {
  writeFileSync(path, JSON.stringify({ profiles: { lab: { ...tokenProfile, ...extra } } }));
  const loaded = loadConfig(path, new SecretRedactor());
  return createSession({ profile: selectProfile(loaded.config, "lab"), configPath: loaded.path,
    redactor: new SecretRedactor(), transport });
}

const flags = (argv: string[]): Map<string, string | boolean> =>
  new Map(parseInvocation(argv).flags);

const body = (value: unknown): { status: number; bodyText: string } =>
  ({ status: 200, bodyText: JSON.stringify(value) });

// Synthetic snapshot bodies stay subscription-shaped: sections vary with
// enabled products, so fixtures carry different keys on purpose.
const cachedSnapshot = { network: { status: "ok" }, system: { status: "ok" }, updated_at: "2026-10-01T12:00:00Z" };
const freshSnapshot = { network: { status: "ok" } };
const cpuSnapshot = { cpu: { status: "ok", load: 12 } };

it("reads the cached snapshot by default without freshness query params", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return body(cachedSnapshot);
  };
  const result = await runHealthList(session(transport), flags(["health", "list"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/health");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    cached: true,
    health: cachedSnapshot,
  } });
});

it("sends cache=false for a fresh snapshot and reports fresh semantics", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return body(freshSnapshot);
  };
  const result = await runHealthList(session(transport), flags(["health", "list", "--fresh"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/health?cache=false");
  expect(result.output).toMatchObject({ cached: false, health: freshSnapshot });
});

it("sends vlans=false only when VLAN detail is omitted", async () => {
  const urls: string[] = [];
  const transport: RawTransport = async (request) => {
    urls.push(request.url);
    return body(freshSnapshot);
  };
  const owned = session(transport);
  await runHealthList(owned, flags(["health", "list", "--no-vlans"]));
  await runHealthList(owned, flags(["health", "list", "--fresh", "--no-vlans"]));
  expect(urls).toEqual([
    "https://fixture.invalid/api/v2.5/health?vlans=false",
    "https://fixture.invalid/api/v2.5/health?cache=false&vlans=false",
  ]);
});

it("passes the snapshot body through without synthesizing availability", async () => {
  const transport: RawTransport = async () => body({ unexpected_section: { status: "degraded" } });
  const result = await runHealthList(session(transport), flags(["health", "list"]));
  expect(result.output.health).toEqual({ unexpected_section: { status: "degraded" } });
  expect(result.output).not.toHaveProperty("status");
  expect(result.output).not.toHaveProperty("healthy");
});

it("reads one supported check through its versioned route", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return body(cpuSnapshot);
  };
  const result = await runHealthShow(session(transport), flags(["health", "show", "--check", "cpu"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/health/cpu");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    check: "cpu",
    cached: true,
    health: cpuSnapshot,
  } });
});

it("rejects an unsupported check before any HTTP", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body({});
  };
  await expect(runHealthShow(session(transport),
    flags(["health", "show", "--check", "battery"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("Unsupported health check"),
  });
  expect(calls).toBe(0);
});

it("requires --check before any HTTP", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body({});
  };
  await expect(runHealthShow(session(transport),
    new Map())).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("requires --check"),
  });
  expect(calls).toBe(0);
});

it("reports snapshot denial as a thrown error rather than an empty healthy result", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  const owned = session(transport);
  await expect(runHealthList(owned, flags(["health", "list"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(runHealthShow(owned, flags(["health", "show", "--check", "cpu"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("rejects a non-object snapshot instead of projecting it", async () => {
  const transport: RawTransport = async () => body([{ status: "ok" }]);
  await expect(runHealthList(session(transport), flags(["health", "list"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
  });
});

// Checkpoint feed fixtures carry the inventory's next_checkpoint,
// remaining_count and events shape; remaining_count is never a total.
const firstEvent = { id: 101, health_check_name: "cpu", status: "ok", event_timestamp: "2026-10-01T12:00:00Z" };
const secondEvent = { id: 102, health_check_name: "disk", status: "warning", event_timestamp: "2026-10-01T12:05:00Z" };
const batch = (events: unknown[], checkpoint: string | null, remaining = 0): { status: number; bodyText: string } =>
  body({ next_checkpoint: checkpoint, remaining_count: remaining, events });

it("reads one event batch and returns its checkpoint for continuation", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return batch([firstEvent, secondEvent], "chk-2", 0);
  };
  const result = await runHealthEventList(session(transport), flags(["health", "event", "list"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/events/health");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    checkpoint: "chk-2",
    remaining_count: 0,
    count: "2 health events",
    events: [firstEvent, secondEvent],
    complete: true,
    help: ["Pass --from chk-2 to continue from the returned checkpoint"],
  } });
});

it("starts from a requested checkpoint and maps server-side filters", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return batch([firstEvent], "chk-3", 4);
  };
  const result = await runHealthEventList(session(transport),
    flags(["health", "event", "list", "--from", "chk-1", "--status", "ok",
      "--health-check-name", "cpu", "--ordering=-event_timestamp"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/events/health"
    + "?from=chk-1&ordering=-event_timestamp&status=ok&health_check_name=cpu");
  expect(result.output).toMatchObject({ checkpoint: "chk-3", remaining_count: 4, count: "1 health events" });
});

it("caps a batch at the output limit and resumes the remainder from its cursor", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return batch([firstEvent, secondEvent], "chk-2", 0);
  };
  const owned = session(transport);
  const capped = await runHealthEventList(owned, flags(["health", "event", "list", "--limit", "1"]));
  expect(capped.output).toMatchObject({ count: "1 health events", complete: true });
  expect(capped.output.events).toEqual([firstEvent]);
  const cursor = capped.output.cursor as string;
  expect(typeof cursor).toBe("string");
  const resumed = await runHealthEventList(owned,
    new Map([...flags(["health", "event", "list", "--limit", "1"]), ["cursor", cursor]]));
  expect(resumed.output).toMatchObject({ count: "1 health events", complete: true });
  expect(resumed.output.events).toEqual([secondEvent]);
  expect(calls).toBe(2);
});

it("preserves the window size across successive resumes without --limit", async () => {
  const thirdEvent = { id: 103 };
  const fourthEvent = { id: 104 };
  const owned = session(async () => batch([firstEvent, secondEvent, thirdEvent, fourthEvent], "chk-2"));
  const first = await runHealthEventList(owned, flags(["health", "event", "list", "--limit", "1"]));
  const second = await runHealthEventList(owned, new Map([["cursor", first.output.cursor as string]]));
  const third = await runHealthEventList(owned, new Map([["cursor", second.output.cursor as string]]));
  const fourth = await runHealthEventList(owned, new Map([["cursor", third.output.cursor as string]]));
  expect(first.output.events).toEqual([firstEvent]);
  expect(second.output.events).toEqual([secondEvent]);
  expect(third.output.events).toEqual([thirdEvent]);
  expect(fourth.output.events).toEqual([fourthEvent]);
  expect(fourth.output).not.toHaveProperty("cursor");
});

it("resumes a --from cursor without repeating --from and re-sends the checkpoint", async () => {
  const urls: string[] = [];
  const transport: RawTransport = async (request) => {
    urls.push(request.url);
    return batch([firstEvent, secondEvent], "chk-2", 0);
  };
  const owned = session(transport);
  const capped = await runHealthEventList(owned,
    flags(["health", "event", "list", "--from", "chk-1", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  const resumed = await runHealthEventList(owned,
    new Map([...flags(["health", "event", "list"]), ["cursor", cursor]]));
  expect(resumed.output.events).toEqual([secondEvent]);
  expect(urls).toEqual([
    "https://fixture.invalid/api/v2.5/events/health?from=chk-1",
    "https://fixture.invalid/api/v2.5/events/health?from=chk-1",
  ]);
});

it.each([
  ["prepended rows", "-event_timestamp", [], [{ id: 103 }, secondEvent, firstEvent]],
  ["appended rows", "event_timestamp", ["--from", "chk-1"], [secondEvent, firstEvent, { id: 103 }]],
  ["removed rows", "-event_timestamp", ["--from", "chk-1"], [firstEvent]],
  ["reordered rows", "event_timestamp", [], [firstEvent, secondEvent]],
  ["changed fields", "-event_timestamp", [], [{ ...secondEvent, status: "ok" }, firstEvent]],
  ["replaced rows", "event_timestamp", ["--from", "chk-1"], [secondEvent, { id: 103 }]],
] as const)("rejects a replay with %s before applying its offset", async (_name, ordering, from, replay) => {
  let events: readonly unknown[] = [secondEvent, firstEvent];
  const owned = session(async () => batch([...events], "chk-2"));
  const initialFlags = flags(["health", "event", "list", "--limit", "1", `--ordering=${ordering}`, ...from]);
  const initial = await runHealthEventList(owned, initialFlags);
  expect(initial.output.events).toEqual([secondEvent]);
  events = replay;
  await expect(runHealthEventList(owned,
    new Map([["ordering", ordering], ["cursor", initial.output.cursor as string]]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID", message: "Vectra health event feed changed since the cursor was issued",
  });
});

it("resumes unchanged event contents despite object key order changes", async () => {
  let events = [{ id: 101, detail: { status: "ok", load: 12 } }, { id: 102 }];
  const owned = session(async () => batch(events, "chk-2"));
  const initial = await runHealthEventList(owned, flags(["health", "event", "list", "--limit", "1"]));
  events = [{ detail: { load: 12, status: "ok" }, id: 101 }, { id: 102 }];
  const resumed = await runHealthEventList(owned, new Map([["cursor", initial.output.cursor as string]]));
  expect(resumed).toMatchObject({ failed: false, output: { events: [{ id: 102 }], count: "1 health events" } });
});

it("rejects a cursor without its batch binding before requesting a replay", async () => {
  let calls = 0;
  const owned = session(async () => {
    calls += 1;
    return batch([firstEvent, secondEvent], "chk-2");
  });
  const initial = await runHealthEventList(owned, flags(["health", "event", "list", "--limit", "1"]));
  const cursor = JSON.parse(Buffer.from(initial.output.cursor as string, "base64url").toString("utf8"));
  delete cursor.batchHash;
  await expect(runHealthEventList(owned,
    new Map([["cursor", Buffer.from(JSON.stringify(cursor)).toString("base64url")]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  });
  expect(calls).toBe(1);
});

it("rejects resuming with changed filters or a different --from", async () => {
  const transport: RawTransport = async () => batch([firstEvent, secondEvent], "chk-2", 0);
  const owned = session(transport);
  const capped = await runHealthEventList(owned, flags(["health", "event", "list", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  await expect(runHealthEventList(owned,
    new Map([...flags(["health", "event", "list", "--status", "ok"]), ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("query context changed"),
  });
  await expect(runHealthEventList(owned,
    new Map([...flags(["health", "event", "list", "--from", "chk-9"]), ["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("cannot combine --from with --cursor"),
  });
});

it("fails a non-advancing checkpoint with its rows retained instead of a resumption loop", async () => {
  const transport: RawTransport = async () => batch([firstEvent], "chk-1", 1);
  const result = await runHealthEventList(session(transport),
    flags(["health", "event", "list", "--from", "chk-1"]));
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    count: "1 health events",
    events: [firstEvent],
    complete: false,
    code: "CONTINUATION_REPEATED",
    checkpoint: "chk-1",
  });
});

it("counts only capped rows retained from a non-advancing checkpoint", async () => {
  const owned = session(async () => batch([firstEvent, secondEvent], "chk-1"));
  const result = await runHealthEventList(owned,
    flags(["health", "event", "list", "--from", "chk-1", "--limit", "1"]));
  expect(result).toMatchObject({ failed: true, output: {
    count: "1 health events",
    events: [firstEvent],
    code: "CONTINUATION_REPEATED",
  } });
  expect(result.output).not.toHaveProperty("cursor");
});

it("counts only offset rows retained when a resumed checkpoint stops advancing", async () => {
  let checkpoint = "chk-2";
  const owned = session(async () => batch([firstEvent, secondEvent], checkpoint));
  const first = await runHealthEventList(owned,
    flags(["health", "event", "list", "--from", "chk-1", "--limit", "1"]));
  checkpoint = "chk-1";
  const result = await runHealthEventList(owned, new Map([["cursor", first.output.cursor as string]]));
  expect(result).toMatchObject({ failed: true, output: {
    count: "1 health events",
    events: [secondEvent],
    code: "CONTINUATION_REPEATED",
  } });
  expect(result.output).not.toHaveProperty("cursor");
});

it("reports an empty batch as success with an explicit zero and its checkpoint", async () => {
  const transport: RawTransport = async () => batch([], "chk-5", 0);
  const result = await runHealthEventList(session(transport),
    flags(["health", "event", "list", "--from", "chk-4"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    checkpoint: "chk-5",
    remaining_count: 0,
    count: "0 health events",
    events: "0 health events found from checkpoint chk-4",
    complete: true,
    help: ["Pass --from chk-5 to continue from the returned checkpoint"],
  } });
});

it("reports event denial as a thrown error rather than an empty result", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  await expect(runHealthEventList(session(transport),
    flags(["health", "event", "list"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("rejects a batch without events or without a checkpoint for returned rows", async () => {
  const owned = session(async () => body({ next_checkpoint: "chk-1", remaining_count: 0 }));
  await expect(runHealthEventList(owned, flags(["health", "event", "list"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
  });
  const missing = session(async () => body({ next_checkpoint: null, remaining_count: 1, events: [firstEvent] }));
  await expect(runHealthEventList(missing, flags(["health", "event", "list"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID", message: expect.stringContaining("no checkpoint"),
  });
});

it("refuses the event feed on an older appliance release before any HTTP", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return batch([], "chk-1", 0);
  };
  await expect(runHealthEventList(session(transport, { applianceRelease: "9.3" }),
    flags(["health", "event", "list"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("requires appliance release 9.4"),
  });
  expect(calls).toBe(0);
});

it("allows the event feed on release 9.4 and later, including double-digit minors", async () => {
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/events/health");
    return batch([], "chk-1", 0);
  };
  for (const release of ["9.4", "9.6", "9.10", "10.0"]) {
    const result = await runHealthEventList(session(transport, { applianceRelease: release }),
      flags(["health", "event", "list"]));
    expect(result.output).toMatchObject({ count: "0 health events" });
  }
  const undeclared = await runHealthEventList(session(transport), flags(["health", "event", "list"]));
  expect(undeclared.output).toMatchObject({ count: "0 health events" });
});

it("rejects a non-positive limit before any HTTP", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return batch([], "chk-1", 0);
  };
  const owned = session(transport);
  await expect(runHealthEventList(owned,
    flags(["health", "event", "list", "--limit", "0"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  });
  expect(calls).toBe(0);
});

// Flag validation runs before profile selection in cli.ts, so these unit
// cases assert the validators throw without any session or transport.
it.each([
  ["missing check", () => healthCheck(new Map()), "health show requires --check"],
  ["unsupported check", () => healthCheck(new Map([["check", "battery"]])), "Unsupported health check"],
  ["bad limit", () => healthEventFlags(flags(["health", "event", "list", "--limit", "0"])),
    "--limit must be a positive integer"],
  ["from with cursor", () => healthEventFlags(
    new Map([...flags(["health", "event", "list", "--from", "chk-1"]), ["cursor", "opaque"]])),
    "cannot combine --from with --cursor"],
  ["old release", () => healthEventRelease({ applianceRelease: "9.3" }), "requires appliance release 9.4"],
])("rejects %s before profile selection", (_name, run, message) => {
  expect(run).toThrowError(message);
});
