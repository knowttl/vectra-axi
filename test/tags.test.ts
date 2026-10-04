import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalogue, parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile, type SelectedProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { desiredTags, runTagSet, tagDiff } from "../src/tags.js";
import { createMutationCoordinator, type MutationCoordinator } from "../src/writes.js";
import type { LeafResult, NoteKind } from "../src/notes.js";

// WRITE-01 acceptance: desired-state tag replaces for one detection, host
// or account through the WRITE-00 gate pipeline. Every transport is a
// synthetic fixture; no live instance, real credential or customer data.
const scratch = mkdtempSync(join(import.meta.dirname, ".tags-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const tagsPath = join(scratch, "tags.txt");
const token = "fake-token-SENTINEL";
const NOW = 1_700_000_000_000;

const TAG_OPERATIONS = ["qux.detection.tag.set", "qux.host.tag.set", "qux.account.tag.set"];
const enabledProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN", writes: { allowWrites: true, operations: TAG_OPERATIONS } };

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", token);
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configPath, { force: true });
  rmSync(auditPath, { force: true, recursive: true });
  rmSync(tagsPath, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function selected(profile: Record<string, unknown> = { ...enabledProfile }): SelectedProfile {
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: profile } }));
  const loaded = loadConfig(configPath, new SecretRedactor());
  return selectProfile(loaded.config, "lab");
}

function harness(args: {
  profile?: SelectedProfile; transport: RawTransport; stdin?: () => string;
}): { session: Session; coordinator: MutationCoordinator; run: (argv: string[], kind: NoteKind) => Promise<LeafResult> } {
  const profile = args.profile ?? selected();
  const redactor = new SecretRedactor();
  const session = createSession({ profile, configPath, redactor, transport: args.transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor,
    transport: args.transport, clock: () => NOW, auditPath });
  const run = (argv: string[], kind: NoteKind): Promise<LeafResult> => {
    const flags = new Map(parseInvocation(argv).flags);
    return runTagSet(session, coordinator, flags, kind, args.stdin ?? (() => ""));
  };
  return { session, coordinator, run };
}

// Fixture tagging transport: GETs serve the current tag set, PATCHes record
// the replace body. Status overrides simulate denial and failures.
function taggingTransport(current: () => string[], seen: { method: string; url: string; body?: string }[],
  overrides?: { getStatus?: number; patchStatus?: number; patchThrows?: unknown },
): RawTransport {
  return async (request) => {
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET") {
      return { status: overrides?.getStatus ?? 200, bodyText: JSON.stringify({ tags: current() }) };
    }
    if (overrides?.patchThrows !== undefined) throw overrides.patchThrows;
    return { status: overrides?.patchStatus ?? 200, bodyText: "{}" };
  };
}

const auditLines = (): Record<string, unknown>[] =>
  readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

it.each([
  ["detection", [], "CONFIRM_REQUIRED"],
  ["host", [], "CONFIRM_REQUIRED"],
  ["account", [], "CONFIRM_REQUIRED"],
  ["detection", ["--confirm", "host 42"], "CONFIRM_MISMATCH"],
  ["host", ["--confirm", "host 7"], "CONFIRM_MISMATCH"],
  ["account", ["--confirm", "account 7"], "CONFIRM_MISMATCH"],
] as const)("blocks %s tag writes with %s before audit intent (%s)", async (kind, confirmation, code) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen) });
  await expect(run([kind, "tag", "set", "--id", "42", "--tags", "b", "--execute", ...confirmation], kind))
    .rejects.toMatchObject({ code });
  expect(seen).toEqual([{ method: "GET", url: `https://fixture.invalid/api/v2.5/tagging/${kind}/42` }]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it.each(["detection", "host", "account"] as const)("requires confirmation before clearing %s tags from stdin", async (kind) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen), stdin: () => "" });
  await expect(run([kind, "tag", "set", "--id", "42", "--tags-file", "-", "--execute"], kind))
    .rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it.each(Object.entries(catalogue).flatMap(([command, entry]) =>
  Object.entries(entry.flags).filter(([name, flag]) => flag.kind === "value" && name !== "tags-file")
    .map(([name]) => [command, name]),
))("rejects a separate bare dash for %s --%s", (command, name) => {
  expect(() => parseInvocation([...command!.split(" "), `--${name}`, "-"]))
    .toThrow(`--${name} requires a non-empty value`);
});

it.each([
  ["detection", "42", "https://fixture.invalid/api/v2.5/tagging/detection/42", "qux.detection.tag.set"],
  ["host", "7", "https://fixture.invalid/api/v2.5/tagging/host/7", "qux.host.tag.set"],
  ["account", "7", "https://fixture.invalid/api/v2.5/tagging/account/7", "qux.account.tag.set"],
] as const)("replaces %s %s through its own PATCH tagging route", async (kind, id, url, operation) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen) });
  const result = await run([kind, "tag", "set", "--id", id, "--tags", "a,b", "--execute", "--confirm", `${kind} ${id}`], kind);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ type: kind, id: Number(id), operation });
  const patch = seen.filter((call) => call.method === "PATCH");
  expect(patch).toEqual([{ method: "PATCH", url, body: JSON.stringify({ tags: ["a", "b"] }) }]);
});

it("previews the added and removed diff without sending", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["keep", "stale"], seen) });
  const result = await run(["detection", "tag", "set", "--id", "42", "--tags", "keep,fresh"], "detection");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "detection",
    id: 42,
    operation: "qux.detection.tag.set",
    current: ["keep", "stale"],
    desired: ["keep", "fresh"],
    added: ["fresh"],
    removed: ["stale"],
    help: ["Re-run with --execute --confirm 'detection 42' to replace the tags for detection 42"],
  } });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("reports an already-matching dry run as a no-op preview", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["b", "a"], seen) });
  const result = await run(["host", "tag", "set", "--id", "7", "--tags", "a,b"], "host");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ state: "tags already match for host 7 (no-op)" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("sends nothing when --execute finds the desired state already present", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen) });
  const result = await run(["account", "tag", "set", "--id", "7", "--tags", "a", "--execute"], "account");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "account",
    id: 7,
    operation: "qux.account.tag.set",
    tags: "tags already match for account 7 (no-op)",
  } });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("records the audit id with applied tags on success", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => [], seen) });
  const result = await run(["detection", "tag", "set", "--id", "42", "--tags", "a", "--execute", "--confirm", "detection 42"], "detection");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    tags: ["a"], added: ["a"], removed: "no tags removed", audit: expect.any(String),
  });
  const lines = auditLines();
  expect(lines.map((line) => [line.kind, line.operation, line.method, line.target, line.outcome ?? null])).toEqual([
    ["intent", "qux.detection.tag.set", "PATCH", "detection 42", null],
    ["outcome", "qux.detection.tag.set", "PATCH", "detection 42", "SUCCESS"],
  ]);
  expect(lines[0]!.url).toBe("https://fixture.invalid/api/v2.5/tagging/detection/42");
});

it("refuses the send when tags move between preview and pre-send re-read", async () => {
  let calls = 0;
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => (calls++ === 0 ? ["a"] : ["a", "rival"]), seen) });
  await expect(run(["detection", "tag", "set", "--id", "42", "--tags", "a,b", "--execute", "--confirm", "detection 42"], "detection"))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 0, outcome: "NOT_SENT" })]);
});

it("treats a concurrent change that already matches as a no-op", async () => {
  let calls = 0;
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => (calls++ === 0 ? ["a"] : ["a", "b"]), seen) });
  const result = await run(["detection", "tag", "set", "--id", "42", "--tags", "a,b", "--execute", "--confirm", "detection 42"], "detection");
  expect(result.output).toMatchObject({ tags: "tags already match for detection 42 (no-op)" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it.each(["detection", "host", "account"] as const)("preserves literal config and profile in conflict recovery for %s", async (kind) => {
  const config = "production's $config.json";
  const profile = "lab's $scope";
  let calls = 0;
  const { run } = harness({ profile: { ...selected(), name: profile },
    transport: taggingTransport(() => (calls++ === 0 ? ["a"] : ["rival"]), []) });
  const error = await run([kind, "tag", "set", "--config", config, "--profile", profile,
    "--id", "42", "--tags", "b", "--execute", "--confirm", `${kind} 42`], kind).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "VERSION_CONFLICT" });
  const hints = (error as { suggestions: string[] }).suggestions;
  const command = hints[0]!.split("`")[1]!;
  const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" }).split("\0").slice(0, -1);
  expect(argv).toEqual(["vectra-axi", kind, "tag", "set", "--config", config,
    "--profile", profile, "--id", "42"]);
});

it.each(["detection", "host", "account"] as const)("preserves literal config and profile in rejection recovery for %s", async (kind) => {
  const config = "production's $config.json";
  const profile = "lab's $scope";
  const { run } = harness({ profile: { ...selected(), name: profile },
    transport: taggingTransport(() => ["a"], [], { patchStatus: 403 }) });
  const result = await run([kind, "tag", "set", "--config", config, "--profile", profile,
    "--id", "42", "--tags", "b", "--execute", "--confirm", `${kind} 42`], kind);
  expect(result.failed).toBe(true);
  const hints = result.output.help as string[];
  const command = hints[0]!.split("`")[1]!;
  const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" }).split("\0").slice(0, -1);
  expect(argv).toEqual(["vectra-axi", kind, "tag", "list", "--config", config,
    "--profile", profile, "--id", "42"]);
});

it("reports a definitive failure when the server rejects the replace", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen, { patchStatus: 403 }) });
  const result = await run(["host", "tag", "set", "--id", "7", "--tags", "b", "--execute", "--confirm", "host 7"], "host");
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    error: "tag replace for host 7 was rejected with status 403",
    audit: expect.any(String),
  });
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 403, outcome: "FAILED" })]);
});

it("surfaces a denied tag read as an access error before any send", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen, { getStatus: 403 }) });
  await expect(run(["detection", "tag", "set", "--id", "42", "--tags", "b", "--execute"], "detection"))
    .rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("rejects a malformed tag read before shaping output", async () => {
  const { run } = harness({ transport: async () => ({ status: 200, bodyText: '{"tags":["ok",7]}' }) });
  await expect(run(["detection", "tag", "set", "--id", "42", "--tags", "b", "--execute"], "detection"))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("reports OUTCOME_UNKNOWN without replay when the send times out", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const failure = new Error("socket timed out");
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen, { patchThrows: failure }) });
  const result = await run(["detection", "tag", "set", "--id", "42", "--tags", "b", "--execute", "--confirm", "detection 42"], "detection");
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({ audit: expect.any(String) });
  expect(result.output.error).toContain("read back");
  const auditId = (result.output as { audit: string }).audit;
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ id: auditId, httpStatus: 0, outcome: "OUTCOME_UNKNOWN" })]);
});

it("refuses writes without hand opt-in", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5",
    auth: "token", tokenEnv: "SENTINEL_TOKEN" });
  const { run } = harness({ profile, transport: taggingTransport(() => ["a"], seen) });
  await expect(run(["detection", "tag", "set", "--id", "42", "--tags", "b", "--execute"], "detection"))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("lets forced read-only override a hand-enabled profile", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen) });
  await expect(run(["detection", "tag", "set", "--id", "42", "--tags", "b", "--execute"], "detection"))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("refuses operations outside the configured scope", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ ...enabledProfile, writes: { allowWrites: true, operations: ["qux.host.tag.set"] } });
  const { run } = harness({ profile, transport: taggingTransport(() => ["a"], seen) });
  await expect(run(["detection", "tag", "set", "--id", "42", "--tags", "b", "--execute"], "detection"))
    .rejects.toMatchObject({ code: "OPERATION_NOT_WRITABLE" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("rejects --dry-run combined with --execute before any HTTP call", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen) });
  await expect(run(["detection", "tag", "set", "--id", "42", "--tags", "b", "--execute", "--dry-run"], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  ["missing tags source", ["detection", "tag", "set", "--id", "42", "--execute"], "--tags <a,b> or --tags-file"],
  ["combined tags sources", ["detection", "tag", "set", "--id", "42", "--tags", "a", "--tags-file", "f", "--execute"], "--tags cannot be combined"],
  ["missing id", ["detection", "tag", "set", "--tags", "a"], "requires --id"],
  ["invalid id", ["detection", "tag", "set", "--id", "0", "--tags", "a"], "--id must be a positive integer"],
])("rejects %s before any HTTP call", async (_name, argv, message) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["a"], seen) });
  await expect(run(argv, "detection")).rejects.toMatchObject({ code: "VALIDATION_ERROR",
    message: expect.stringContaining(message) });
  expect(seen).toEqual([]);
});

it("reads the desired set from a file, one tag per line", async () => {
  writeFileSync(tagsPath, "alpha\n\n  beta \nalpha\n");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => [], seen) });
  const result = await run(["host", "tag", "set", "--id", "7", "--tags-file", tagsPath, "--execute", "--confirm", "host 7"], "host");
  expect(result.failed).toBe(false);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    expect.objectContaining({ body: JSON.stringify({ tags: ["alpha", "beta"] }) }),
  ]);
});

it("reads the desired set from stdin with --tags-file -", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["stale"], seen), stdin: () => "fresh\n" });
  const result = await run(["account", "tag", "set", "--id", "7", "--tags-file", "-", "--execute", "--confirm", "account 7"], "account");
  expect(result.failed).toBe(false);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    expect.objectContaining({ body: JSON.stringify({ tags: ["fresh"] }) }),
  ]);
});

it("clears all tags with an empty file and refuses a blank --tags", async () => {
  writeFileSync(tagsPath, "\n");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: taggingTransport(() => ["stale"], seen) });
  const preview = await run(["detection", "tag", "set", "--id", "42", "--tags-file", tagsPath], "detection");
  expect(preview.output).toMatchObject({ desired: "(no tags: clears all tags)", removed: ["stale"] });
  const result = await run(
    ["detection", "tag", "set", "--id", "42", "--tags-file", tagsPath, "--execute", "--confirm", "detection 42"], "detection");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ tags: "all tags cleared for detection 42" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    expect.objectContaining({ body: JSON.stringify({ tags: [] }) }),
  ]);
  await expect(run(["detection", "tag", "set", "--id", "42", "--tags", " , "], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("at least one tag") });
});

it("keeps tag order out of the no-op comparison but preserves it on send", async () => {
  expect(desiredTags(new Map([["tags", "b,a,b"]]), "detection")).toEqual(["b", "a"]);
  expect(tagDiff(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
});

it("never exposes the tag replace through the read session", async () => {
  const { session } = harness({ transport: taggingTransport(() => ["a"], []) });
  await expect(session.request("qux.detection.tag.set", { pathParams: { id: 42 } }))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
});
