import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { LOCKDOWN_STATUS_ONLY, RUX_LOCKDOWN_STATUS_NOTE, lockdownKind, runLockdownList } from "../src/lockdown.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".lockdown-test-"));
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

// Fixture rows carry the inventory's lockdown field subsets: the kind ID
// plus lock metadata, with unlock_date null while a lock is in force.
const hostLockdown = { host_id: 7, lock_date: "2026-09-30T12:00:00Z",
  locked_by: "synthetic-admin", unlock_date: null };
const accountLockdown = { account_id: 7, lock_date: "2026-09-29T08:00:00Z",
  locked_by: "synthetic-admin", unlock_date: "2026-09-30T08:00:00Z" };
const body = (value: unknown): { status: number; bodyText: string } =>
  ({ status: 200, bodyText: JSON.stringify(value) });

it("reads host lockdown status through the host status route", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    expect(request.method).toBe("GET");
    return body([hostLockdown]);
  };
  const result = await runLockdownList(session(transport), flags(["lockdown", "list", "--type", "host"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/lockdown/host");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "host",
    count: "1 host lockdowns",
    lockdowns: [hostLockdown],
    complete: true,
    help: [LOCKDOWN_STATUS_ONLY,
      "Host lockdown status requires the configured Microsoft Defender ATP Lockdown integration"],
  } });
});

it("reads account lockdown status through the account status route", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return body([accountLockdown]);
  };
  const result = await runLockdownList(session(transport), flags(["lockdown", "list", "--type", "account"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/lockdown/account");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "account",
    count: "1 account lockdowns",
    lockdowns: [accountLockdown],
    complete: true,
    help: [LOCKDOWN_STATUS_ONLY,
      "Account lockdown status requires the configured AD Lockdown capability"],
  } });
});

it("keeps the same numeric host and account IDs on separate routes", async () => {
  const urls: string[] = [];
  const transport: RawTransport = async (request) => {
    urls.push(request.url);
    return request.url.endsWith("/lockdown/host") ? body([hostLockdown]) : body([accountLockdown]);
  };
  const owned = session(transport);
  const host = await runLockdownList(owned, flags(["lockdown", "list", "--type", "host"]));
  const account = await runLockdownList(owned, flags(["lockdown", "list", "--type", "account"]));
  expect(urls).toEqual([
    "https://fixture.invalid/api/v2.5/lockdown/host",
    "https://fixture.invalid/api/v2.5/lockdown/account",
  ]);
  expect(host.output.lockdowns).toEqual([hostLockdown]);
  expect(account.output.lockdowns).toEqual([accountLockdown]);
  expect(host.output.lockdowns).not.toEqual(account.output.lockdowns);
});

it("reports an empty status as success with an explicit zero", async () => {
  const transport: RawTransport = async () => body([]);
  const result = await runLockdownList(session(transport), flags(["lockdown", "list", "--type", "host"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "host",
    count: "0 host lockdowns",
    lockdowns: "0 host lockdowns found",
    complete: true,
    help: [LOCKDOWN_STATUS_ONLY,
      "Host lockdown status requires the configured Microsoft Defender ATP Lockdown integration"],
  } });
});

it("requires --type before any HTTP instead of guessing a route", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body([]);
  };
  await expect(runLockdownList(session(transport), flags(["lockdown", "list"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("lockdown list requires --type"),
  });
  expect(calls).toBe(0);
});

it("rejects an unknown --type before any HTTP", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body([]);
  };
  await expect(runLockdownList(session(transport),
    flags(["lockdown", "list", "--type", "sensor"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: "--type must be one of: host, account, traffic",
  });
  expect(calls).toBe(0);
});

it("reports denial as a thrown error rather than an empty healthy result", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  const owned = session(transport);
  await expect(runLockdownList(owned, flags(["lockdown", "list", "--type", "host"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(runLockdownList(owned, flags(["lockdown", "list", "--type", "account"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("rejects a non-list body instead of claiming completion", async () => {
  const transport: RawTransport = async () => body({ results: [hostLockdown] });
  await expect(runLockdownList(session(transport), flags(["lockdown", "list", "--type", "host"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("rejects mistyped lockdown rows instead of projecting them", async () => {
  const hostTransport: RawTransport = async () => body([{ ...hostLockdown, host_id: "seven" }]);
  await expect(runLockdownList(session(hostTransport), flags(["lockdown", "list", "--type", "host"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  const accountTransport: RawTransport = async () => body([{ lock_date: "2026-09-29T08:00:00Z" }]);
  await expect(runLockdownList(session(accountTransport), flags(["lockdown", "list", "--type", "account"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("strips unrecorded wire keys instead of projecting them", async () => {
  const transport: RawTransport = async () => body([{ ...hostLockdown, verdict: "locked" }]);
  const result = await runLockdownList(session(transport), flags(["lockdown", "list", "--type", "host"]));
  expect(result.output.lockdowns).toEqual([hostLockdown]);
  expect(result.output).not.toHaveProperty("verdict");
});

it("keeps nullable lockdown fields as null instead of zero", async () => {
  const row = { host_id: 7, lock_date: null, locked_by: null, unlock_date: null };
  const transport: RawTransport = async () => body([row]);
  const result = await runLockdownList(session(transport), flags(["lockdown", "list", "--type", "host"]));
  expect(result.output.lockdowns).toEqual([row]);
});

it.each([
  ["lockdown execute", ["lockdown", "execute", "--type", "host"]],
  ["lockdown create", ["lockdown", "create", "--type", "host"]],
  ["lockdown update", ["lockdown", "update", "--type", "host"]],
  ["lockdown delete", ["lockdown", "delete", "--type", "host"]],
  ["bare lockdown group", ["lockdown"]],
])("refuses the %s mutation leaf as an unknown command", (_name, argv) => {
  expect(() => parseInvocation(argv)).toThrowError(/^Unknown command: /);
});

// Flag validation runs before profile selection in cli.ts, so these unit
// cases assert the validator throws without any session or transport.
it.each([
  ["missing type", () => lockdownKind(flags(["lockdown", "list"])),
    "lockdown list requires --type <host|account>"],
  ["unknown type", () => lockdownKind(flags(["lockdown", "list", "--type", "sensor"])),
    "--type must be one of: host, account, traffic"],
  ["empty type", () => flags(["lockdown", "list", "--type", "  "]),
    "--type requires a non-empty value"],
])("rejects %s before profile selection", (_name, run, message) => {
  expect(run).toThrowError(message);
});

// RUX-06: the same leaf runs against the single documented v3.4 endpoint
// with its type selector on a cloud profile. The fake answers the named
// unversioned exchange, then delegates resource GETs to the per-test
// responder. Subscription bodies vary with Network, AWS and M365 products,
// so cloud fixtures carry the serializer subset on purpose: the entity join
// keys are required while lock metadata stays optional.
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

const cloudHelp = [LOCKDOWN_STATUS_ONLY, RUX_LOCKDOWN_STATUS_NOTE];
const cloudHostLockdown = { entity_id: 7, type: "host", id: 1, entity_name: "synthetic-host-7",
  locked_by: "synthetic-admin", lock_event_timestamp: "2026-09-30T12:00:00Z", unlock_event_timestamp: null };
const cloudTrafficLockdown = { entity_id: 9, type: "traffic" };

it("reads host lockdown status through the v3.4 type selector", async () => {
  let url = "";
  const transport = cloudFixture((seen) => {
    url = seen;
    expect(seen).toContain("type=host");
    return body([cloudHostLockdown]);
  });
  const result = await runLockdownList(cloudSession(transport), flags(["lockdown", "list", "--type", "host"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/lockdown/?type=host");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    type: "host",
    count: "1 host lockdowns",
    lockdowns: [cloudHostLockdown],
    complete: true,
    help: cloudHelp,
  } });
});

it("reads account lockdown status through the v3.4 type selector", async () => {
  let url = "";
  const transport = cloudFixture((seen) => {
    url = seen;
    return body([{ entity_id: 7, type: "account", locked_by: "synthetic-admin",
      lock_event_timestamp: "2026-09-29T08:00:00Z", unlock_event_timestamp: "2026-09-30T08:00:00Z" }]);
  });
  const result = await runLockdownList(cloudSession(transport),
    flags(["lockdown", "list", "--type", "account"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/lockdown/?type=account");
  expect(result.output).toMatchObject({ profile: "cloud", type: "account", count: "1 account lockdowns" });
});

it("reads traffic lockdown status on a cloud profile", async () => {
  let url = "";
  const transport = cloudFixture((seen) => {
    url = seen;
    return body([cloudTrafficLockdown]);
  });
  const result = await runLockdownList(cloudSession(transport),
    flags(["lockdown", "list", "--type", "traffic"]));
  expect(url).toBe("https://fixture.invalid/api/v3.4/lockdown/?type=traffic");
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    type: "traffic",
    count: "1 traffic lockdowns",
    lockdowns: [cloudTrafficLockdown],
    complete: true,
    help: cloudHelp,
  } });
});

it("refuses traffic lockdown status on QUX before any HTTP", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body([]);
  };
  await expect(runLockdownList(session(transport),
    flags(["lockdown", "list", "--type", "traffic"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: "traffic lockdown status requires a RUX v3.4 cloud profile",
  });
  expect(calls).toBe(0);
});

it("reports an empty cloud status as success with an explicit zero", async () => {
  const transport = cloudFixture(() => body([]));
  const result = await runLockdownList(cloudSession(transport),
    flags(["lockdown", "list", "--type", "host"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "cloud",
    type: "host",
    count: "0 host lockdowns",
    lockdowns: "0 host lockdowns found",
    complete: true,
    help: cloudHelp,
  } });
});

it("reports cloud denial as a thrown error rather than an empty healthy result", async () => {
  const transport = cloudFixture(() => ({ status: 403, bodyText: "{}" }));
  const owned = cloudSession(transport);
  await expect(runLockdownList(owned, flags(["lockdown", "list", "--type", "host"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(runLockdownList(owned, flags(["lockdown", "list", "--type", "traffic"]))).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("rejects a non-list cloud body instead of claiming completion", async () => {
  const transport = cloudFixture(() => body({ results: [cloudHostLockdown] }));
  await expect(runLockdownList(cloudSession(transport),
    flags(["lockdown", "list", "--type", "host"]))).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("rejects cloud rows without the entity join keys instead of projecting them", async () => {
  const missingId = cloudFixture(() => body([{ type: "host" }]));
  await expect(runLockdownList(cloudSession(missingId),
    flags(["lockdown", "list", "--type", "host"]))).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  const missingType = cloudFixture(() => body([{ entity_id: 7 }]));
  await expect(runLockdownList(cloudSession(missingType),
    flags(["lockdown", "list", "--type", "host"]))).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("strips unrecorded cloud wire keys instead of projecting them", async () => {
  const transport = cloudFixture(() => body([{ ...cloudHostLockdown, verdict: "locked" }]));
  const result = await runLockdownList(cloudSession(transport),
    flags(["lockdown", "list", "--type", "host"]));
  expect(result.output.lockdowns).toEqual([cloudHostLockdown]);
});

it("keeps nullable cloud lockdown fields as null instead of zero", async () => {
  const row = { entity_id: 7, type: "host", locked_by: null, unlock_event_timestamp: null };
  const transport = cloudFixture(() => body([row]));
  const result = await runLockdownList(cloudSession(transport),
    flags(["lockdown", "list", "--type", "host"]));
  expect(result.output.lockdowns).toEqual([row]);
});
