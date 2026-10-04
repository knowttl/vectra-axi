import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { auditWindow, runAuditList } from "../src/audits.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".audits-test-"));
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

const windowFlags = (extra: string[] = []): Map<string, string | boolean> =>
  flags(["audit", "list", "--start-date", "2026-10-01", "--end-date", "2026-10-02", ...extra]);

// Fixture rows carry the inventory's qux.audit.list field subset.
const firstAudit = { user: "synthetic-admin", role: "Super Admin",
  vectra_timestamp: "2026-10-01T12:00:00Z", result: "success", message: "synthetic audit one" };
const secondAudit = { user: "synthetic-api-client", role: "Read Only",
  vectra_timestamp: "2026-10-02T08:30:00Z", result: "failure", message: "synthetic audit two" };
const body = (value: unknown): { status: number; bodyText: string } =>
  ({ status: 200, bodyText: JSON.stringify(value) });

it("sends the bounded window as inclusive ISO start/end wire params", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return body([firstAudit, secondAudit]);
  };
  const result = await runAuditList(session(transport), windowFlags());
  expect(url).toBe("https://fixture.invalid/api/v2.5/audits?start=2026-10-01&end=2026-10-02");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    window: "2026-10-01 to 2026-10-02 (inclusive UTC days)",
    count: "2 audits",
    audits: [firstAudit, secondAudit],
    complete: true,
  } });
});

it("accepts a single-day window as an inclusive one-day range", async () => {
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    return body([firstAudit]);
  };
  const result = await runAuditList(session(transport),
    flags(["audit", "list", "--start-date", "2026-10-01", "--end-date", "2026-10-01"]));
  expect(url).toBe("https://fixture.invalid/api/v2.5/audits?start=2026-10-01&end=2026-10-01");
  expect(result.output).toMatchObject({ count: "1 audits", complete: true });
});

it("reports an empty window as success with an explicit zero", async () => {
  const transport: RawTransport = async () => body([]);
  const result = await runAuditList(session(transport), windowFlags());
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    window: "2026-10-01 to 2026-10-02 (inclusive UTC days)",
    count: "0 audits",
    audits: "0 audits found from 2026-10-01 to 2026-10-02",
    complete: true,
  } });
});

it("requires both dates before any HTTP instead of using unbounded defaults", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body([]);
  };
  const owned = session(transport);
  await expect(runAuditList(owned, flags(["audit", "list", "--end-date", "2026-10-02"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("--start-date"),
  });
  await expect(runAuditList(owned, flags(["audit", "list", "--start-date", "2026-10-01"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("--end-date"),
  });
  expect(calls).toBe(0);
});

it.each([
  ["wrong shape", "2026-10-1"],
  ["month out of range", "2026-13-01"],
  ["impossible day", "2026-02-30"],
  ["timestamp instead of day", "2026-10-01T00:00:00Z"],
])("rejects %s before any HTTP", async (_name, date) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body([]);
  };
  const owned = session(transport);
  await expect(runAuditList(owned,
    flags(["audit", "list", "--start-date", date, "--end-date", "2026-10-02"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  });
  await expect(runAuditList(owned,
    flags(["audit", "list", "--start-date", "2026-10-01", "--end-date", date]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  });
  expect(calls).toBe(0);
});

it("rejects a start after the end before any HTTP", async () => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body([]);
  };
  await expect(runAuditList(session(transport),
    flags(["audit", "list", "--start-date", "2026-10-03", "--end-date", "2026-10-02"]))).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("is after"),
  });
  expect(calls).toBe(0);
});

it("reports denial as a thrown error rather than an empty result", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  await expect(runAuditList(session(transport), windowFlags())).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

it("rejects a non-list body instead of claiming completion", async () => {
  const transport: RawTransport = async () => body({ results: [firstAudit] });
  await expect(runAuditList(session(transport), windowFlags())).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
  });
});

it("rejects mistyped audit rows instead of projecting them", async () => {
  const transport: RawTransport = async () => body([{ ...firstAudit, result: 200 }]);
  await expect(runAuditList(session(transport), windowFlags())).rejects.toMatchObject({
    code: "RESPONSE_INVALID",
  });
});

it("refuses an oversized window with a smaller-range suggestion and no completion claim", async () => {
  const transport: RawTransport = async () => body([firstAudit, secondAudit]);
  await expect(runAuditList(session(transport), windowFlags(), { maxBytes: 10 })).rejects.toMatchObject({
    code: "BYTE_BUDGET_EXCEEDED",
    message: expect.stringContaining("above the 10-byte ceiling"),
    suggestions: expect.arrayContaining([expect.stringContaining("--start-date 2026-10-02 --end-date 2026-10-02")]),
  });
});

it("keeps nullable audit fields as null instead of zero", async () => {
  const row = { user: null, role: null, vectra_timestamp: null, result: null, message: null };
  const transport: RawTransport = async () => body([row]);
  const result = await runAuditList(session(transport), windowFlags());
  expect(result.output.audits).toEqual([row]);
});

// Flag validation runs before profile selection in cli.ts, so these unit
// cases assert the validator throws without any session or transport.
it.each([
  ["missing start", () => auditWindow(flags(["audit", "list", "--end-date", "2026-10-02"])),
    "audit list requires --start-date"],
  ["missing end", () => auditWindow(flags(["audit", "list", "--start-date", "2026-10-01"])),
    "audit list requires --end-date"],
  ["wrong shape", () => auditWindow(flags(["audit", "list", "--start-date", "10-01-2026", "--end-date", "2026-10-02"])),
    "--start-date must be a YYYY-MM-DD UTC calendar day"],
  ["impossible day", () => auditWindow(flags(["audit", "list", "--start-date", "2026-02-30", "--end-date", "2026-03-01"])),
    "is not a real calendar day"],
  ["start after end", () => auditWindow(flags(["audit", "list", "--start-date", "2026-10-03", "--end-date", "2026-10-02"])),
    "--start-date 2026-10-03 is after --end-date 2026-10-02"],
])("rejects %s before profile selection", (_name, run, message) => {
  expect(run).toThrowError(message);
});
