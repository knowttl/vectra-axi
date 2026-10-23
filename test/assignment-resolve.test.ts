import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { parseInvocation } from "../src/catalogue.js";
import { main } from "../src/cli.js";
import { runAssignmentResolve } from "../src/assignment-resolve.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".assignment-resolve-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const notePath = join(scratch, "note.txt");
const enabled = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN", writes: { allowWrites: true,
    operations: ["qux.host.assignment.resolve", "qux.account.assignment.resolve"] } };
type Call = { method: string; url: string; body?: string };
const execute = ["--execute", "--confirm", "host 7"];

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", "synthetic-token");
  vi.stubEnv("CLOUD_SECRET", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
  vi.stubEnv("VECTRA_AXI_WRITE_LOG", auditPath);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
  rmSync(auditPath, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function harness(options: {
  profile?: Record<string, unknown>; status?: number; timeout?: boolean;
  noOpen?: boolean; duplicate?: boolean; changed?: boolean; outcomeStatus?: number; outcome?: unknown;
} = {}) {
  const calls: Call[] = [];
  let reads = 0;
  const transport: RawTransport = async (request) => {
    if (request.url.endsWith("/oauth2/token")) return { status: 200,
      bodyText: JSON.stringify({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600 }) };
    calls.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "PUT") {
      if (options.timeout) throw new Error("socket timed out");
      return { status: options.status ?? 200, bodyText: "{}" };
    }
    if (request.url.includes("/assignment_outcomes/")) return { status: options.outcomeStatus ?? 200,
      bodyText: JSON.stringify(options.outcome ?? { id: 1, title: "Investigation complete", category: "benign_true_positive" }) };
    reads++;
    const url = new URL(request.url);
    const row = { id: options.changed && reads > 1 ? 12 : 11,
      host_id: url.searchParams.has("hosts") ? 7 : null,
      account_id: url.searchParams.has("accounts") ? 7 : null,
      date_resolved: null, assigned_to: { id: 5 } };
    const results = options.noOpen ? [] : options.duplicate ? [row, { ...row, id: 14 }] : [row];
    return { status: 200, bodyText: JSON.stringify({ results, count: results.length }) };
  };
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: options.profile ?? enabled } }));
  const redactor = new SecretRedactor();
  const profile = selectProfile(loadConfig(configPath, redactor).config, "lab");
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  const run = async (extra: string[] = [], kind = "host") => runAssignmentResolve(session, coordinator,
    parseInvocation(["assignment", "resolve", `--${kind}`, "7", "--outcome", "1", ...extra]).flags);
  return { run, calls, transport };
}
const sends = (calls: Call[]) => calls.filter(({ method }) => method === "PUT");
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

it("previews the permanent effect without sending or journaling", async () => {
  const { run, calls } = harness();
  expect(await run()).toMatchObject({ failed: false, output: { assignment: 11, outcome: 1,
    effect: "disruptive", warning: expect.stringContaining("no unresolve") } });
  expect(sends(calls)).toEqual([]);
  expect(() => journal()).toThrow();
});

it.each([
  ["qux", "host", "2.5", ""], ["qux", "account", "2.5", ""],
  ["rux", "host", "3.4", "/"], ["rux", "account", "3.4", "/"],
])("resolves %s %s through the documented route after re-reading", async (generation, kind, version, suffix) => {
  const { run, calls } = harness({ profile: { ...enabled, kind: generation, apiVersion: version,
    ...(generation === "rux" ? { auth: "oauth", tokenEnv: undefined, clientId: "synthetic-client", secretEnv: "CLOUD_SECRET" } : {}),
    writes: { allowWrites: true, operations: [`${generation}.${kind}.assignment.resolve`] } } });
  expect(await run(["--note", "Investigation complete", "--execute", "--confirm", `${kind} 7`], kind))
    .toMatchObject({ failed: false });
  expect(sends(calls)).toEqual([{ method: "PUT", url: `https://fixture.invalid/api/v${version}/assignments/11/resolve${suffix}`,
    body: '{"outcome":1,"note":"Investigation complete"}' }]);
  expect(calls.filter(({ method }) => method === "GET")).toHaveLength(4);
  expect(journal()).toEqual([
    expect.objectContaining({ kind: "intent", operation: `${generation}.${kind}.assignment.resolve`, target: `${kind} 7` }),
    expect.objectContaining({ kind: "outcome", outcome: "SUCCESS" }),
  ]);
  expect(readFileSync(auditPath, "utf8")).not.toContain("Investigation complete");
  expect(readFileSync(auditPath, "utf8")).not.toContain("synthetic-token");
  expect(journal()[0]).not.toHaveProperty("payload");
  expect(journal()[0]).not.toHaveProperty("body");
});

it.each([
  [["--mark-fixed"], { mark_as_fixed: true }],
  [["--triage-as", "Reviewed activity"], { triage_as: "Reviewed activity" }],
] as const)("sends selected detection side effects %s", async (flags, effect) => {
  const { run, calls } = harness();
  await run(["--detections", "42,41,42", ...flags, ...execute]);
  expect(JSON.parse(sends(calls)[0]!.body!)).toEqual({ outcome: 1, detection_ids: [41, 42], ...effect });
});

it("preserves exact note-file contents", async () => {
  writeFileSync(notePath, "Investigation complete\n");
  const { run, calls } = harness();
  await run(["--note-file", notePath, ...execute]);
  expect(JSON.parse(sends(calls)[0]!.body!)).toEqual({ outcome: 1, note: "Investigation complete\n" });
});

it.each([
  ["no open assignment", { noOpen: true }, "VALIDATION_ERROR"],
  ["duplicate open assignments", { duplicate: true }, "VALIDATION_ERROR"],
  ["unknown outcome", { outcomeStatus: 404 }, "REQUEST_FAILED"],
  ["wrong outcome identity", { outcome: { id: 2 } }, "RESPONSE_INVALID"],
  ["changed assignment", { changed: true }, "VERSION_CONFLICT"],
] as const)("refuses %s before sending", async (_name, options, code) => {
  const { run, calls } = harness(options);
  await expect(run(execute)).rejects.toMatchObject({ code });
  expect(sends(calls)).toEqual([]);
});

it.each([
  ["without opt-in", { ...enabled, writes: undefined }, undefined, [], "WRITES_DISABLED"],
  ["forced read-only", enabled, "1", [], "WRITES_DISABLED"],
  ["outside allowlist", { ...enabled, writes: { allowWrites: true, operations: ["qux.account.assignment.resolve"] } }, undefined, [], "OPERATION_NOT_WRITABLE"],
  ["without confirmation", enabled, undefined, ["--execute"], "CONFIRM_REQUIRED"],
  ["wrong confirmation", enabled, undefined, ["--execute", "--confirm", "host 8"], "CONFIRM_MISMATCH"],
] as const)("refuses %s without sending or journaling", async (_name, profile, readOnly, extra, code) => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", readOnly);
  const { run, calls } = harness({ profile });
  await expect(run([...extra])).rejects.toMatchObject({ code });
  expect(sends(calls)).toEqual([]);
  expect(() => journal()).toThrow();
});

it.each([
  ["server rejection", { status: 403 }, "FAILED"],
  ["already resolved conflict", { status: 409 }, "FAILED"],
  ["timeout", { timeout: true }, "OUTCOME_UNKNOWN"],
] as const)("journals %s without replay", async (_name, options, outcome) => {
  const { run, calls } = harness(options);
  expect(await run(execute)).toMatchObject({ failed: true });
  expect(sends(calls)).toHaveLength(1);
  expect(journal()[1]).toMatchObject({ kind: "outcome", outcome });
});

it.each([
  ["combined entities", ["--account", "7"]],
  ["combined actions", ["--detections", "41", "--mark-fixed", "--triage-as", "Reviewed"]],
  ["detections without action", ["--detections", "41"]],
  ["fixed without detections", ["--mark-fixed"]],
  ["triage without detections", ["--triage-as", "Reviewed"]],
  ["invalid detection", ["--detections", "0", "--mark-fixed"]],
  ["empty triage", ["--detections", "41", "--triage-as", " "]],
  ["combined notes", ["--note", "Reviewed", "--note-file", "missing"]],
  ["empty note", ["--note", " "]],
  ["combined execute and dry-run", ["--execute", "--dry-run"]],
])("rejects %s before any HTTP call", async (_name, extra) => {
  const { run, calls } = harness();
  await expect(run(extra)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toEqual([]);
});

it("dispatches resolution through the CLI", async () => {
  const { transport, calls } = harness();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await main(["assignment", "resolve", "--config", configPath, "--profile", "lab", "--host", "7", "--outcome", "1"], transport);
  expect(decode(stdout.mock.calls.map(([chunk]) => chunk).join(""))).toMatchObject({ operation: "qux.host.assignment.resolve" });
  expect(sends(calls)).toEqual([]);
});
