import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile, type SelectedProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { bulkTags, bulkTagTargets, bulkTargetLabel, MAX_BULK_TAG_TARGETS, runTagBulk,
  type BulkTagAction } from "../src/tags-bulk.js";
import { createMutationCoordinator, type MutationCoordinator } from "../src/writes.js";
import type { LeafResult, NoteKind } from "../src/notes.js";

// WRITE-05 acceptance: bulk tag set/delete across explicit detection, host
// or account targets through the WRITE-00 gate pipeline. Every transport is
// a synthetic fixture; no live instance, real credential or customer data.
const scratch = mkdtempSync(join(import.meta.dirname, ".tags-bulk-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const idsPath = join(scratch, "ids.txt");
const tagsPath = join(scratch, "tags.txt");
const token = "fake-token-SENTINEL";
const NOW = 1_700_000_000_000;

const BULK_OPERATIONS = [
  "qux.detection.tag.bulk-set", "qux.detection.tag.bulk-delete",
  "qux.host.tag.bulk-set", "qux.host.tag.bulk-delete",
  "qux.account.tag.bulk-set", "qux.account.tag.bulk-delete",
];
const enabledProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN", writes: { allowWrites: true, operations: BULK_OPERATIONS } };

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", token);
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configPath, { force: true });
  rmSync(auditPath, { force: true, recursive: true });
  rmSync(idsPath, { force: true });
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
}): { session: Session; coordinator: MutationCoordinator;
  run: (argv: string[], kind: NoteKind, action: BulkTagAction) => Promise<LeafResult> } {
  const profile = args.profile ?? selected();
  const redactor = new SecretRedactor();
  const session = createSession({ profile, configPath, redactor, transport: args.transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor,
    transport: args.transport, clock: () => NOW, auditPath });
  const run = (argv: string[], kind: NoteKind, action: BulkTagAction): Promise<LeafResult> => {
    const flags = new Map(parseInvocation(argv).flags);
    return runTagBulk(session, coordinator, flags, kind, action, args.stdin ?? (() => ""));
  };
  return { session, coordinator, run };
}

type Seen = { method: string; url: string; body?: string };

// Fixture tagging transport: GETs serve the per-ID tag set (PATCHes apply
// their replace body to it, like the evidenced full-replace route), PATCHes
// record the body. Per-ID overrides simulate denial, malformed reads,
// moved state between preview and pre-send re-read, rejection and timeouts.
function bulkTransport(state: Map<number, string[]>, seen: Seen[], overrides?: {
  getStatus?: Map<number, number>;
  malformed?: Set<number>;
  moveOnReread?: Map<number, string[]>;
  patchStatus?: Map<number, number>;
  patchThrows?: Map<number, unknown>;
}): RawTransport {
  const reads = new Map<string, number>();
  return async (request) => {
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    const id = Number(request.url.split("/").pop());
    if (request.method === "GET") {
      const count = (reads.get(request.url) ?? 0) + 1;
      reads.set(request.url, count);
      const moved = overrides?.moveOnReread?.get(id);
      const tags = count > 1 && moved !== undefined ? moved : (state.get(id) ?? []);
      const malformed = overrides?.malformed?.has(id) === true;
      return { status: overrides?.getStatus?.get(id) ?? 200,
        bodyText: malformed ? `{"tags":[${JSON.stringify(tags[0] ?? "ok")},7]}` : JSON.stringify({ tags }) };
    }
    const thrown = overrides?.patchThrows?.get(id);
    if (thrown !== undefined) throw thrown;
    state.set(id, (JSON.parse(request.body ?? "{}") as { tags: string[] }).tags);
    return { status: overrides?.patchStatus?.get(id) ?? 200, bodyText: "{}" };
  };
}

const auditLines = (): Record<string, unknown>[] =>
  readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

it("blocks bulk execution without confirmation before any send", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]], [8, ["a"]]]), seen) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7,8", "--tags", "b", "--execute"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "CONFIRM_REQUIRED",
      message: expect.stringContaining("2 targets: host 7, host 8") });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("blocks a mismatched confirmation naming the exact set", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]], [8, ["a"]]]), seen) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7,8", "--tags", "b",
    "--execute", "--confirm", "2 targets"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "CONFIRM_MISMATCH",
      message: expect.stringContaining("2 targets: host 7, host 8") });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("previews per-target diffs without sending", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]], [8, ["a", "b"]]]), seen) });
  const result = await run(["host", "tag", "bulk-set", "--ids", "7,8", "--tags", "b,c"], "host", "bulk-set");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "host",
    operation: "qux.host.tag.bulk-set",
    action: "bulk-set",
    tags: ["b", "c"],
    targets: "2 targets: host 7, host 8",
    count: 2,
    changes: [
      { id: 7, current: ["a"], desired: ["a", "b", "c"], added: ["b", "c"], removed: "no tags to remove" },
      { id: 8, current: ["a", "b"], desired: ["a", "b", "c"], added: ["c"], removed: "no tags to remove" },
    ],
    help: ["Re-run with --execute --confirm '2 targets: host 7, host 8'"
      + " to bulk-set tags 'b', 'c' for 2 targets: host 7, host 8"],
  } });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("reports an all-steady dry run without a confirm hint", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a", "b"]], [8, ["b", "a"]]]), seen) });
  const result = await run(["host", "tag", "bulk-set", "--ids", "7,8", "--tags", "a,b"], "host", "bulk-set");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ state: "tags already present on 2 targets: host 7, host 8 (no-op)" });
  expect(result.output).not.toHaveProperty("help");
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("sends nothing when execution finds every target steady", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]]]), seen) });
  const result = await run(["host", "tag", "bulk-delete", "--ids", "7", "--tags", "b",
    "--execute", "--confirm", "1 target: host 7"], "host", "bulk-delete");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    targets: "1 target: host 7",
    results: [{ id: 7, outcome: "noop" }],
    summary: "0 applied, 1 unchanged, 0 failed, 0 unknown, 0 refused of 1 targets",
  });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("unions tags across targets with per-target audits on success", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[41, []], [42, ["keep"]]]), seen) });
  const result = await run(["detection", "tag", "bulk-set", "--ids", "42,41", "--tags", "fresh",
    "--execute", "--confirm", "2 targets: detection 41, detection 42"], "detection", "bulk-set");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    operation: "qux.detection.tag.bulk-set",
    targets: "2 targets: detection 41, detection 42",
    summary: "2 applied, 0 unchanged, 0 failed, 0 unknown, 0 refused of 2 targets",
  });
  const rows = (result.output as { results: Record<string, unknown>[] }).results;
  expect(rows.map((row) => [row.id, row.outcome])).toEqual([[41, "applied"], [42, "applied"]]);
  expect(rows[0]).toMatchObject({ added: ["fresh"], audit: expect.any(String) });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/tagging/detection/41",
      body: JSON.stringify({ tags: ["fresh"] }) },
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/tagging/detection/42",
      body: JSON.stringify({ tags: ["keep", "fresh"] }) },
  ]);
  expect(auditLines().map((line) =>
    [line.kind, line.operation, line.method, line.target, line.outcome ?? null])).toEqual([
    ["intent", "qux.detection.tag.bulk-set", "PATCH", "detection 41", null],
    ["outcome", "qux.detection.tag.bulk-set", "PATCH", "detection 41", "SUCCESS"],
    ["intent", "qux.detection.tag.bulk-set", "PATCH", "detection 42", null],
    ["outcome", "qux.detection.tag.bulk-set", "PATCH", "detection 42", "SUCCESS"],
  ]);
  // The journal carries metadata only, never the tag values.
  expect(readFileSync(auditPath, "utf8")).not.toContain("fresh");
});

it("subtracts named tags per target on bulk-delete", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a", "b"]], [8, ["c"]]]), seen) });
  const result = await run(["account", "tag", "bulk-delete", "--ids", "7,8", "--tags", "b",
    "--execute", "--confirm", "2 targets: account 7, account 8"], "account", "bulk-delete");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({
    operation: "qux.account.tag.bulk-delete",
    results: [{ id: 7, outcome: "applied" }, { id: 8, outcome: "noop" }],
    summary: "1 applied, 1 unchanged, 0 failed, 0 unknown, 0 refused of 2 targets",
  });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/tagging/account/7",
      body: JSON.stringify({ tags: ["a"] }) },
  ]);
});

it("refuses a moved target while applying the confirmed rest", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]], [8, ["a"]]]), seen,
    { moveOnReread: new Map([[8, ["a", "rival"]]]) }) });
  const result = await run(["host", "tag", "bulk-set", "--ids", "7,8", "--tags", "b",
    "--execute", "--confirm", "2 targets: host 7, host 8"], "host", "bulk-set");
  expect(result.failed).toBe(true);
  const rows = (result.output as { results: Record<string, unknown>[] }).results;
  expect(rows.map((row) => [row.id, row.outcome])).toEqual([[7, "applied"], [8, "refused"]]);
  expect(rows[1]).toMatchObject({ error: expect.stringContaining("changed since the preview") });
  expect(result.output).toMatchObject({
    summary: "1 applied, 0 unchanged, 0 failed, 0 unknown, 1 refused of 2 targets",
  });
  expect(seen.filter((call) => call.method === "PATCH")).toHaveLength(1);
  expect(auditLines().filter((line) => line.kind === "outcome")).toEqual([
    expect.objectContaining({ target: "host 7", outcome: "SUCCESS" }),
    expect.objectContaining({ target: "host 8", httpStatus: 0, outcome: "NOT_SENT" }),
  ]);
});

it("treats a concurrent change that already matches as a no-op", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]]]), seen,
    { moveOnReread: new Map([[7, ["a", "b"]]]) }) });
  const result = await run(["host", "tag", "bulk-set", "--ids", "7", "--tags", "b",
    "--execute", "--confirm", "1 target: host 7"], "host", "bulk-set");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ results: [{ id: 7, outcome: "noop" }] });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("reports a server rejection per target without claiming the rest", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]], [8, ["a"]]]), seen,
    { patchStatus: new Map([[8, 403]]) }) });
  const result = await run(["host", "tag", "bulk-set", "--ids", "7,8", "--tags", "b",
    "--execute", "--confirm", "2 targets: host 7, host 8"], "host", "bulk-set");
  expect(result.failed).toBe(true);
  const rows = (result.output as { results: Record<string, unknown>[] }).results;
  expect(rows.map((row) => [row.id, row.outcome])).toEqual([[7, "applied"], [8, "failed"]]);
  expect(rows[1]).toMatchObject({ error: "tag bulk-set for host 8 was rejected with status 403",
    audit: expect.any(String) });
  expect(auditLines().filter((line) => line.kind === "outcome")).toEqual([
    expect.objectContaining({ target: "host 7", outcome: "SUCCESS" }),
    expect.objectContaining({ target: "host 8", httpStatus: 403, outcome: "FAILED" }),
  ]);
});

it("surfaces a denied preview read before any send", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]], [8, ["a"]]]), seen,
    { getStatus: new Map([[8, 403]]) }) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7,8", "--tags", "b",
    "--execute", "--confirm", "2 targets: host 7, host 8"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("rejects a malformed preview read before any send", async () => {
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]]]), [],
    { malformed: new Set([7]) }) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7", "--tags", "b",
    "--execute", "--confirm", "1 target: host 7"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("reports OUTCOME_UNKNOWN without replay when one send times out", async () => {
  const seen: Seen[] = [];
  const failure = new Error("socket timed out");
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]], [8, ["a"]]]), seen,
    { patchThrows: new Map([[8, failure]]) }) });
  const result = await run(["host", "tag", "bulk-set", "--ids", "7,8", "--tags", "b",
    "--execute", "--confirm", "2 targets: host 7, host 8"], "host", "bulk-set");
  expect(result.failed).toBe(true);
  const rows = (result.output as { results: Record<string, unknown>[] }).results;
  expect(rows.map((row) => [row.id, row.outcome])).toEqual([[7, "applied"], [8, "unknown"]]);
  expect(rows[1]).toMatchObject({ audit: expect.any(String) });
  expect(rows[1]!.error as string).toContain("read back");
  expect(rows[1]!.error as string).toContain("never replay");
  expect(seen.filter((call) => call.method === "PATCH" && call.url.endsWith("/host/8"))).toHaveLength(1);
  const auditId = rows[1]!.audit;
  expect(auditLines().filter((line) => line.kind === "outcome")).toEqual([
    expect.objectContaining({ target: "host 7", outcome: "SUCCESS" }),
    expect.objectContaining({ id: auditId, target: "host 8", httpStatus: 0, outcome: "OUTCOME_UNKNOWN" }),
  ]);
});

it("refuses writes without hand opt-in", async () => {
  const seen: Seen[] = [];
  const profile = selected({ kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5",
    auth: "token", tokenEnv: "SENTINEL_TOKEN" });
  const { run } = harness({ profile, transport: bulkTransport(new Map([[7, ["a"]]]), seen) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7", "--tags", "b",
    "--execute", "--confirm", "1 target: host 7"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("lets forced read-only override a hand-enabled profile", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]]]), seen) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7", "--tags", "b",
    "--execute", "--confirm", "1 target: host 7"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("refuses bulk operations outside the configured scope", async () => {
  const seen: Seen[] = [];
  // A single-target tag scope does not cover the bulk family: bulk needs
  // its own hand-enabled operation names.
  const profile = selected({ ...enabledProfile, writes: { allowWrites: true, operations: ["qux.host.tag.set"] } });
  const { run } = harness({ profile, transport: bulkTransport(new Map([[7, ["a"]]]), seen) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7", "--tags", "b",
    "--execute", "--confirm", "1 target: host 7"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "OPERATION_NOT_WRITABLE" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("refuses bulk tags on a RUX profile before any HTTP call", async () => {
  const seen: Seen[] = [];
  const profile = selected({ kind: "rux", origin: "https://fixture.invalid", apiVersion: "3.4",
    auth: "oauth", clientId: "synthetic-client", secretEnv: "SENTINEL_TOKEN",
    writes: { allowWrites: true, operations: ["qux.host.tag.bulk-set"] } });
  const { run } = harness({ profile, transport: bulkTransport(new Map([[7, ["a"]]]), seen) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7", "--tags", "b",
    "--execute", "--confirm", "1 target: host 7"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED",
      message: expect.stringContaining("no evidenced tag write route") });
  expect(seen).toEqual([]);
});

it.each([
  ["missing ids source", ["host", "tag", "bulk-set", "--tags", "a"], "--ids <id,...> or --ids-file"],
  ["combined ids sources", ["host", "tag", "bulk-set", "--ids", "7", "--ids-file", "f", "--tags", "a"],
    "--ids cannot be combined"],
  ["non-numeric id", ["host", "tag", "bulk-set", "--ids", "7,x", "--tags", "a"], "positive integer IDs"],
  ["zero id", ["host", "tag", "bulk-set", "--ids", "0", "--tags", "a"], "positive integer IDs"],
  ["empty ids", ["host", "tag", "bulk-set", "--ids", " , ", "--tags", "a"], "at least one target ID"],
  ["missing tags source", ["host", "tag", "bulk-set", "--ids", "7"], "--tags <a,b> or --tags-file"],
  ["combined tags sources", ["host", "tag", "bulk-set", "--ids", "7", "--tags", "a", "--tags-file", "f"],
    "--tags cannot be combined"],
  ["blank tags", ["host", "tag", "bulk-set", "--ids", "7", "--tags", " , "], "at least one tag"],
  ["dry-run with execute", ["host", "tag", "bulk-set", "--ids", "7", "--tags", "a", "--execute", "--dry-run"],
    "--dry-run cannot be combined"],
])("rejects %s before any HTTP call", async (_name, argv, message) => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]]]), seen) });
  await expect(run(argv, "host", "bulk-set")).rejects.toMatchObject({ code: "VALIDATION_ERROR",
    message: expect.stringContaining(message) });
  expect(seen).toEqual([]);
});

it("rejects an empty tags file instead of clearing", async () => {
  writeFileSync(tagsPath, "\n");
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["stale"]]]), seen) });
  await expect(run(["host", "tag", "bulk-set", "--ids", "7", "--tags-file", tagsPath], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("at least one tag") });
  expect(seen).toEqual([]);
});

it(`rejects more than ${MAX_BULK_TAG_TARGETS} targets in one run`, async () => {
  const ids = Array.from({ length: MAX_BULK_TAG_TARGETS + 1 }, (_value, index) => index + 1).join(",");
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map(), seen) });
  await expect(run(["host", "tag", "bulk-set", "--ids", ids, "--tags", "a"], "host", "bulk-set"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR",
      message: expect.stringContaining(`at most ${MAX_BULK_TAG_TARGETS} targets`) });
  expect(seen).toEqual([]);
});

it("reads targets and tags from files, deduplicating and sorting IDs", async () => {
  writeFileSync(idsPath, "8\n\n7\n8\n");
  writeFileSync(tagsPath, "beta\n\nalpha\nbeta\n");
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, []], [8, []]]), seen) });
  const result = await run(["host", "tag", "bulk-set", "--ids-file", idsPath, "--tags-file", tagsPath,
    "--execute", "--confirm", "2 targets: host 7, host 8"], "host", "bulk-set");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ targets: "2 targets: host 7, host 8" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/tagging/host/7",
      body: JSON.stringify({ tags: ["beta", "alpha"] }) },
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/tagging/host/8",
      body: JSON.stringify({ tags: ["beta", "alpha"] }) },
  ]);
});

it("reads target IDs from stdin with --ids-file -", async () => {
  const seen: Seen[] = [];
  const { run } = harness({ transport: bulkTransport(new Map([[7, ["a"]]]), seen), stdin: () => "7\n" });
  const result = await run(["host", "tag", "bulk-delete", "--ids-file", "-", "--tags", "a",
    "--execute", "--confirm", "1 target: host 7"], "host", "bulk-delete");
  expect(result.failed).toBe(false);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/tagging/host/7",
      body: JSON.stringify({ tags: [] }) },
  ]);
});

it("names the exact target count and set in the confirmation label", () => {
  expect(bulkTargetLabel("host", [7, 8])).toBe("2 targets: host 7, host 8");
  expect(bulkTargetLabel("detection", [42])).toBe("1 target: detection 42");
});

it("parses explicit targets and named tags without network calls", () => {
  expect(bulkTagTargets(new Map([["ids", "8,7,8"]]), "host", "bulk-set")).toEqual([7, 8]);
  expect(bulkTags(new Map([["tags", "b,a,b"]]), "host", "bulk-set")).toEqual(["b", "a"]);
  expect(() => bulkTagTargets(new Map(), "host", "bulk-set"))
    .toThrow("--ids <id,...> or --ids-file");
});

it("never exposes bulk replaces through the read session", async () => {
  const { session } = harness({ transport: bulkTransport(new Map([[7, ["a"]]]), []) });
  await expect(session.request("qux.host.tag.bulk-set", { pathParams: { id: 7 } }))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
});
