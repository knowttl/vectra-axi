import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { LOCKDOWN_STATUS_ONLY, lockdownKind, runLockdownList } from "../src/lockdown.js";
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
    code: "VALIDATION_ERROR", message: "--type must be one of: host, account",
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
    "--type must be one of: host, account"],
  ["empty type", () => flags(["lockdown", "list", "--type", "  "]),
    "--type requires a non-empty value"],
])("rejects %s before profile selection", (_name, run, message) => {
  expect(run).toThrowError(message);
});
