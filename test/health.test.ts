import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { healthCheck, healthEventFlags, healthEventRelease, healthShowFlags, runHealthEventList, runHealthList,
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
  process.env.CLOUD_SECRET = "fake-cloud-secret-SENTINEL";
});
afterEach(() => {
  delete process.env.SENTINEL_TOKEN;
  delete process.env.CLOUD_SECRET;
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

// RUX-06: the same leaves run against the documented v3.4 routes on a
// cloud profile. The fake answers the named unversioned exchange, then
// delegates resource GETs to the per-test responder. Subscription bodies
// vary with Network, AWS and M365 products, so cloud fixtures carry
// subscription-shaped keys on purpose and the runner passes them through.
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

it("reads the cloud snapshot through the v3.4 route with subscription passthrough", async () => {
  let url = "";
  const subscriptionBody = { aws: { status: "ok" }, m365: { status: "degraded" } };
  const transport = cloudFixture((seen) => {
    url = seen;
    return body(subscriptionBody);
  });
  const result = await runHealthList(cloudSession(transport), flags(["health", "list"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/health/");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    cached: true,
    health: subscriptionBody,
    help: ["Health response varies with Network, AWS and M365 subscriptions"],
  } });
});

it("sends cache and vlan flags to the cloud snapshot route", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((seen) => {
    urls.push(seen);
    return body({ network: { status: "ok" } });
  });
  const owned = cloudSession(transport);
  await runHealthList(owned, flags(["health", "list", "--fresh", "--no-vlans"]));
  expect(urls).toEqual(["https://fixture.invalid/api/v3.4/health/?cache=false&vlans=false"]);
});

it("reads one supported check through the v3.4 check_type route", async () => {
  let url = "";
  const transport = cloudFixture((seen) => {
    url = seen;
    return body(cpuSnapshot);
  });
  const result = await runHealthShow(cloudSession(transport), flags(["health", "show", "--check", "cpu"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/health/cpu/");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    check: "cpu",
    cached: true,
    health: cpuSnapshot,
    help: ["Health response varies with Network, AWS and M365 subscriptions"],
  } });
});

it("rejects an unsupported check on a cloud profile before any HTTP", async () => {
  let calls = 0;
  const transport = cloudFixture(() => {
    calls += 1;
    return body({});
  });
  await expect(runHealthShow(cloudSession(transport),
    flags(["health", "show", "--check", "battery"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("Unsupported health check"),
  });
  expect(calls).toBe(0);
});

it.each([
  ["list", runHealthList, ["health", "list"]],
  ["show", runHealthShow, ["health", "show", "--check", "cpu"]],
] as const)("points malformed cloud health %s responses to the RUX contract", async (_leaf, run, argv) => {
  const transport = cloudFixture(() => body([]));
  await expect(run(cloudSession(transport), flags([...argv]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
    suggestions: ["Check the RUX v3.4 API contract for this operation"],
  });
});

it("reports cloud snapshot denial as a thrown error rather than an empty healthy result", async () => {
  const transport = cloudFixture(() => ({ status: 403, bodyText: "{}" }));
  const owned = cloudSession(transport);
  await expect(runHealthList(owned, flags(["health", "list"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(runHealthShow(owned, flags(["health", "show", "--check", "cpu"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("reads a cloud event batch with integer checkpoints in decimal form", async () => {
  let url = "";
  const transport = cloudFixture((seen) => {
    url = seen;
    return body({ next_checkpoint: 102, remaining_count: 0, events: [firstEvent, secondEvent] });
  });
  const result = await runHealthEventList(cloudSession(transport), flags(["health", "event", "list"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/events/health/");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    checkpoint: "102",
    remaining_count: 0,
    count: "2 health events",
    events: [firstEvent, secondEvent],
    complete: true,
    help: ["Pass --from 102 to continue from the returned checkpoint"],
  } });
});

it("resumes a cloud batch from a numeric checkpoint and detects a repeated one", async () => {
  const urls: string[] = [];
  const transport = cloudFixture((seen) => {
    urls.push(seen);
    return body({ next_checkpoint: 102, remaining_count: 1, events: [firstEvent] });
  });
  const owned = cloudSession(transport);
  const resumed = await runHealthEventList(owned, flags(["health", "event", "list", "--from", "101"]));
  expect(urls).toEqual(["https://fixture.invalid/api/v3.4/events/health/?from=101"]);
  expect(resumed.output).toMatchObject({ checkpoint: "102", count: "1 health events", complete: true });
  const stuck = await runHealthEventList(owned, flags(["health", "event", "list", "--from", "102"]));
  expect(stuck).toMatchObject({ failed: true, output: {
    count: "1 health events",
    code: "CONTINUATION_REPEATED",
    checkpoint: "102",
  } });
});

it("rejects a non-numeric cloud checkpoint before any HTTP", async () => {
  let calls = 0;
  const transport = cloudFixture(() => {
    calls += 1;
    return body({ next_checkpoint: 102, remaining_count: 0, events: [] });
  });
  await expect(runHealthEventList(cloudSession(transport),
    flags(["health", "event", "list", "--from", "chk-1"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("numeric checkpoints"),
  });
  expect(calls).toBe(0);
});

it("runs the cloud event feed with no appliance-release gate", async () => {
  const transport = cloudFixture(() => body({ next_checkpoint: 5, remaining_count: 0, events: [] }));
  const result = await runHealthEventList(cloudSession(transport), flags(["health", "event", "list"]));
  expect(result.output).toMatchObject({ profile: "cloud", checkpoint: "5", count: "0 health events" });
});

it("reports an empty cloud batch as success with an explicit zero and its checkpoint", async () => {
  const transport = cloudFixture(() => body({ next_checkpoint: 9, remaining_count: 0, events: [] }));
  const result = await runHealthEventList(cloudSession(transport),
    flags(["health", "event", "list", "--from", "8"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    checkpoint: "9",
    remaining_count: 0,
    count: "0 health events",
    events: "0 health events found from checkpoint 8",
    complete: true,
    help: ["Pass --from 9 to continue from the returned checkpoint"],
  } });
});

it("reports cloud event denial as a thrown error rather than an empty result", async () => {
  const transport = cloudFixture(() => ({ status: 403, bodyText: "{}" }));
  await expect(runHealthEventList(cloudSession(transport),
    flags(["health", "event", "list"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

// RUX-06b: the five generation-specific connector/EDR/network-brain checks
// share the `health show` leaf on cloud profiles only. Fixtures carry
// subscription-shaped keys on purpose and the runner passes them through
// with the variance note and no cached/fresh claim: these routes declare
// no freshness parameters.
it("reads connector health through the v3.4 route with filter passthrough", async () => {
  let url = "";
  const connectorBody = { results: [{ connector: "synthetic-connector", status: "ok" }],
    updated_at: "2026-10-01T12:00:00Z" };
  const transport = cloudFixture((seen) => {
    url = seen;
    return body(connectorBody);
  });
  const result = await runHealthShow(cloudSession(transport), flags(["health", "show",
    "--check", "external-connectors", "--connector-type", "synthetic-connector",
    "--data-type", "synthetic-data", "--live"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/health/external_connectors/"
    + "?connector_type=synthetic-connector&data_type=synthetic-data&live=true");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    check: "external-connectors",
    health: connectorBody,
    help: ["Health response varies with Network, AWS and M365 subscriptions"],
  } });
  expect(result.output).not.toHaveProperty("cached");
});

it("reads EDR health through the v3.4 route with filter passthrough", async () => {
  let url = "";
  const edrBody = { results: [{ edr: "synthetic-edr", status: "degraded" }] };
  const transport = cloudFixture((seen) => {
    url = seen;
    return body(edrBody);
  });
  const result = await runHealthShow(cloudSession(transport), flags(["health", "show",
    "--check", "edr", "--edr-type", "synthetic-edr"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/health/edr/?edr_type=synthetic-edr");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    check: "edr",
    health: edrBody,
    help: ["Health response varies with Network, AWS and M365 subscriptions"],
  } });
});

it.each([
  ["external-connectors-details", "https://fixture.invalid/api/v3.4/health/external_connectors/details/"],
  ["edr-details", "https://fixture.invalid/api/v3.4/health/edr/details/"],
  ["network-brain-ping", "https://fixture.invalid/api/v3.4/health/network_brain/ping/"],
] as const)("reads %s through its fixed v3.4 route with no query", async (check, expected) => {
  let url = "";
  const transport = cloudFixture((seen) => {
    url = seen;
    return body({ results: [{ status: "ok" }] });
  });
  const result = await runHealthShow(cloudSession(transport),
    flags(["health", "show", "--check", check]));
  expect(url).toBe(expected);
  expect(result).toMatchObject({ failed: false, output: { profile: "cloud", check } });
  expect(result.output).not.toHaveProperty("cached");
});

it.each([
  "external-connectors", "external-connectors-details", "edr", "edr-details", "network-brain-ping",
] as const)("refuses connector check %s on a QUX profile before any HTTP", async (check) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body({});
  };
  await expect(runHealthShow(session(transport),
    flags(["health", "show", "--check", check]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
    message: expect.stringContaining(`Health check '${check}' requires a RUX v3.4 cloud profile`),
  });
  expect(calls).toBe(0);
});

it.each([
  ["connector filter on a base check", ["health", "show", "--check", "cpu", "--connector-type", "x"],
    "--connector-type applies only to the RUX connector/EDR checks"],
  ["connector filter on the EDR check", ["health", "show", "--check", "edr", "--connector-type", "x"],
    "--connector-type applies only to --check external-connectors"],
  ["EDR filter on the connector check", ["health", "show", "--check", "external-connectors", "--edr-type", "x"],
    "--edr-type applies only to --check edr"],
  ["data filter on a details check", ["health", "show", "--check", "edr-details", "--data-type", "x"],
    "--data-type applies only to --check external-connectors or --check edr"],
  ["live flag on the ping check", ["health", "show", "--check", "network-brain-ping", "--live"],
    "--live applies only to --check external-connectors or --check edr"],
  ["fresh flag on a connector check", ["health", "show", "--check", "edr", "--fresh"],
    "uses its fixed upstream query"],
  ["VLAN flag on a connector check", ["health", "show", "--check", "external-connectors", "--no-vlans"],
    "uses its fixed upstream query"],
] as const)("rejects %s before any HTTP", async (_name, argv, message) => {
  let calls = 0;
  const owned = cloudSession(cloudFixture(() => {
    calls += 1;
    return body({});
  }));
  await expect(runHealthShow(owned, flags([...argv]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining(message),
  });
  expect(calls).toBe(0);
});

it.each([
  ["denied", { status: 403, bodyText: "{}" }, "ACCESS_DENIED"],
  ["malformed", { status: 200, bodyText: "[]" }, "RESPONSE_INVALID"],
] as const)("reports a %s connector response as an error rather than an empty healthy result", async (
  _name, response, code,
) => {
  const transport = cloudFixture(() => response);
  const owned = cloudSession(transport);
  await expect(runHealthShow(owned,
    flags(["health", "show", "--check", "edr"]))).rejects.toMatchObject({ code });
});

it.each([
  ["connector-type", "external-connectors"],
  ["edr-type", "edr"],
  ["data-type", "edr"],
] as const)("rejects an empty --%s value before profile selection", (name, check) => {
  expect(() => healthShowFlags(new Map([["check", check], [name, "  "]])))
    .toThrowError(`--${name} requires a non-empty value`);
});

it("points malformed connector responses to the RUX contract", async () => {
  const transport = cloudFixture(() => body([]));
  await expect(runHealthShow(cloudSession(transport),
    flags(["health", "show", "--check", "network-brain-ping"]))).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
    suggestions: ["Check the RUX v3.4 API contract for this operation"],
  });
});

it("refuses a QUX event cursor on the cloud operation", async () => {
  let calls = 0;
  const qux = session(async () => {
    calls += 1;
    return batch([firstEvent, secondEvent], "chk-2", 0);
  });
  const capped = await runHealthEventList(qux, flags(["health", "event", "list", "--limit", "1"]));
  const cursor = capped.output.cursor as string;
  let cloudCalls = 0;
  const cloud = cloudSession(cloudFixture(() => {
    cloudCalls += 1;
    return batch([firstEvent], "chk-2", 0);
  }));
  await expect(runHealthEventList(cloud, new Map([["cursor", cursor]]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
    message: "Invalid health event cursor: the cursor belongs to qux.health.event.list,"
      + " not rux.health.event.list",
  });
  expect(calls).toBe(1);
  expect(cloudCalls).toBe(0);
});
