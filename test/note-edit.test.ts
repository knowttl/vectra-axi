import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile, type SelectedProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { desiredEditText, noteEntryId, runNoteDelete, runNoteEdit } from "../src/note-edit.js";
import { createMutationCoordinator, type MutationCoordinator } from "../src/writes.js";
import { runNoteList, type LeafResult, type NoteKind } from "../src/notes.js";

// WRITE-N (2a) acceptance: desired-state note edits and note deletes for
// one detection, host or account through the WRITE-00 gate pipeline on QUX
// v2.5 and RUX v3.4 profiles. Every transport is a synthetic fixture; no
// live instance, real credential or customer data.
const scratch = mkdtempSync(join(import.meta.dirname, ".note-edit-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const notePath = join(scratch, "note.txt");
const token = "fake-token-SENTINEL";
const NOW = 1_700_000_000_000;

const QUX_OPERATIONS = [
  "qux.detection.note.edit", "qux.detection.note.delete",
  "qux.host.note.edit", "qux.host.note.delete",
  "qux.account.note.edit", "qux.account.note.delete",
];
const RUX_OPERATIONS = [
  "rux.detection.note.edit", "rux.detection.note.delete",
  "rux.host.note.edit", "rux.host.note.delete",
  "rux.account.note.edit", "rux.account.note.delete",
];
const quxProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN", writes: { allowWrites: true, operations: QUX_OPERATIONS } };
const ruxProfile = { kind: "rux", origin: "https://fixture.invalid", apiVersion: "3.4", auth: "oauth",
  clientId: "synthetic-client", secretEnv: "CLOUD_SECRET",
  writes: { allowWrites: true, operations: RUX_OPERATIONS } };

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", token);
  vi.stubEnv("CLOUD_SECRET", "fake-cloud-secret-SENTINEL");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configPath, { force: true });
  rmSync(auditPath, { force: true, recursive: true });
  rmSync(notePath, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function selected(profile: Record<string, unknown> = { ...quxProfile }): SelectedProfile {
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
    return argv[2] === "delete"
      ? runNoteDelete(session, coordinator, flags, kind)
      : runNoteEdit(session, coordinator, flags, kind, args.stdin ?? (() => ""));
  };
  return { session, coordinator, run };
}

// Fixture notes transport: GETs serve the queued note lists in order
// (repeating the last), PATCH/DELETE record the mutation. Status overrides
// simulate denial and failures.
function notesTransport(
  seen: { method: string; url: string; body?: string }[],
  lists: unknown[][],
  overrides?: { getStatus?: number; getBody?: string; mutateStatus?: number; mutateThrows?: unknown },
): RawTransport {
  let calls = 0;
  return async (request) => {
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET") {
      return { status: overrides?.getStatus ?? 200,
        bodyText: overrides?.getBody ?? JSON.stringify(lists[Math.min(calls++, lists.length - 1)]) };
    }
    if (overrides?.mutateThrows !== undefined) throw overrides.mutateThrows;
    return { status: overrides?.mutateStatus ?? 200, bodyText: "{}" };
  };
}

// RUX profiles exchange OAuth credentials before resource use; the fake
// answers the named unversioned exchange, then delegates to the notes
// fixture for lists and mutations.
function ruxTransport(
  seen: { method: string; url: string; body?: string }[],
  lists: unknown[][],
  overrides?: { getStatus?: number; mutateStatus?: number },
): RawTransport {
  const inner = notesTransport(seen, lists, overrides);
  return async (request) => {
    if (request.method === "POST" && request.url === "https://fixture.invalid/oauth2/token") {
      return { status: 200, bodyText: JSON.stringify(
        { access_token: "fake-cloud-access-token", token_type: "Bearer", expires_in: 3600 }) };
    }
    return inner(request);
  };
}

const auditLines = (): Record<string, unknown>[] =>
  readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

const ids: Record<NoteKind, string> = { detection: "42", host: "7", account: "7" };
const lists: Record<NoteKind, string> = {
  detection: "https://fixture.invalid/api/v2.5/detections/42/notes",
  host: "https://fixture.invalid/api/v2.5/hosts/7/notes",
  account: "https://fixture.invalid/api/v2.5/accounts/7/notes",
};

it.each([
  ["detection", "edit", [], "CONFIRM_REQUIRED"],
  ["host", "edit", [], "CONFIRM_REQUIRED"],
  ["account", "delete", [], "CONFIRM_REQUIRED"],
  ["detection", "edit", ["--confirm", "detection 42"], "CONFIRM_MISMATCH"],
  ["host", "delete", ["--confirm", "host 7"], "CONFIRM_MISMATCH"],
  ["account", "edit", ["--confirm", "account 7 note 2"], "CONFIRM_MISMATCH"],
] as const)("blocks %s note %s with %s before audit intent (%s)", async (kind, action, confirmation, code) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const notes = [{ id: 1, note: "synthetic current note" }];
  const { run } = harness({ transport: notesTransport(seen, [notes]) });
  const id = ids[kind];
  const text = action === "edit" ? ["--note", "synthetic replacement"] : [];
  await expect(run([kind, "note", action, "--id", id, "--note-id", "1", ...text, "--execute", ...confirmation], kind))
    .rejects.toMatchObject({ code });
  expect(seen).toEqual([{ method: "GET", url: lists[kind] }]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it.each([
  ["detection", "42", "https://fixture.invalid/api/v2.5/detections/42/notes/1", "qux.detection.note.edit"],
  ["host", "7", "https://fixture.invalid/api/v2.5/hosts/7/notes/1", "qux.host.note.edit"],
  ["account", "7", "https://fixture.invalid/api/v2.5/accounts/7/notes/1", "qux.account.note.edit"],
] as const)("edits %s %s through its own PATCH note route", async (kind, id, url, operation) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "synthetic current note" }]]) });
  const result = await run([kind, "note", "edit", "--id", id, "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--confirm", `${kind} ${id} note 1`], kind);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ type: kind, id: Number(id), noteId: 1, operation,
    after: "synthetic replacement" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url, body: JSON.stringify({ note: "synthetic replacement" }) },
  ]);
});

it.each([
  ["detection", "42", "https://fixture.invalid/api/v2.5/detections/42/notes/1", "qux.detection.note.delete"],
  ["host", "7", "https://fixture.invalid/api/v2.5/hosts/7/notes/1", "qux.host.note.delete"],
  ["account", "7", "https://fixture.invalid/api/v2.5/accounts/7/notes/1", "qux.account.note.delete"],
] as const)("deletes %s %s through its own DELETE note route", async (kind, id, url, operation) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "synthetic current note" }]]) });
  const result = await run([kind, "note", "delete", "--id", id, "--note-id", "1",
    "--execute", "--confirm", `${kind} ${id} note 1`], kind);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ type: kind, id: Number(id), noteId: 1, operation,
    note: "synthetic current note" });
  expect(seen.filter((call) => call.method !== "GET")).toEqual([{ method: "DELETE", url }]);
});

it("previews the exact before/after without sending", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen,
    [[{ id: 1, note: "synthetic current note" }, { id: 2, note: "other note" }]]) });
  const result = await run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", "synthetic replacement"], "detection");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "detection",
    id: 42,
    noteId: 1,
    operation: "qux.detection.note.edit",
    before: "synthetic current note",
    after: "synthetic replacement",
    help: ["Re-run with --execute --confirm 'detection 42 note 1' to replace the text of note 1 for detection 42"],
  } });
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("previews the note being removed without sending", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "synthetic current note" }]]) });
  const result = await run(["host", "note", "delete", "--id", "7", "--note-id", "1"], "host");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "host",
    id: 7,
    noteId: 1,
    operation: "qux.host.note.delete",
    note: "synthetic current note",
    help: ["Re-run with --execute --confirm 'host 7 note 1' to delete note 1 for host 7"],
  } });
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it.each(["edit", "delete"] as const)("reports an already-matching %s dry run as a no-op preview", async (action) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const notes = action === "edit" ? [{ id: 1, note: "synthetic replacement" }] : [];
  const { run } = harness({ transport: notesTransport(seen, [notes]) });
  const text = action === "edit" ? ["--note", "synthetic replacement"] : [];
  const result = await run(["detection", "note", action, "--id", "42", "--note-id", "1", ...text], "detection");
  expect(result.failed).toBe(false);
  expect(result.output.state).toContain("(no-op)");
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it.each(["edit", "delete"] as const)("sends nothing when --execute finds the desired %s state already present", async (action) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const notes = action === "edit" ? [{ id: 1, note: "synthetic replacement" }] : [];
  const { run } = harness({ transport: notesTransport(seen, [notes]) });
  const text = action === "edit" ? ["--note", "synthetic replacement"] : [];
  const result = await run(["detection", "note", action, "--id", "42", "--note-id", "1", ...text,
    "--execute", "--confirm", "detection 42 note 1"], "detection");
  expect(result.failed).toBe(false);
  expect(result.output.note).toContain("(no-op)");
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
});

it("refuses an edit of a missing note before any preview", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 2, note: "other note" }]]) });
  await expect(run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--confirm", "detection 42 note 1"], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("was not found") });
  expect(seen).toEqual([{ method: "GET", url: lists.detection }]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("refuses an edit when the note is deleted between preview and send", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen,
    [[{ id: 1, note: "synthetic current note" }], []]) });
  await expect(run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--confirm", "detection 42 note 1"], "detection"))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 0, outcome: "NOT_SENT" })]);
});

it.each(["edit", "delete"] as const)("refuses the %s when the note text moves between preview and pre-send re-read", async (action) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen,
    [[{ id: 1, note: "synthetic current note" }], [{ id: 1, note: "concurrent rewrite" }]]) });
  const text = action === "edit" ? ["--note", "synthetic replacement"] : [];
  const error = await run(["host", "note", action, "--id", "7", "--note-id", "1", ...text,
    "--execute", "--confirm", "host 7 note 1"], "host").catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.some((call) => call.method === "PATCH" || call.method === "DELETE")).toBe(false);
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 0, outcome: "NOT_SENT" })]);
});

it.each(["edit", "delete"] as const)("treats a concurrent change that already matches as a %s no-op", async (action) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const listsNow = action === "edit"
    ? [[{ id: 1, note: "synthetic current note" }], [{ id: 1, note: "synthetic replacement" }]]
    : [[{ id: 1, note: "synthetic current note" }], []];
  const { run } = harness({ transport: notesTransport(seen, listsNow) });
  const text = action === "edit" ? ["--note", "synthetic replacement"] : [];
  const result = await run(["host", "note", action, "--id", "7", "--note-id", "1", ...text,
    "--execute", "--confirm", "host 7 note 1"], "host");
  expect(result.failed).toBe(false);
  expect(result.output.note).toContain("(no-op)");
  expect(seen.some((call) => call.method === "PATCH" || call.method === "DELETE")).toBe(false);
});

it("records the audit id with metadata only on edit success", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const before = "synthetic current note with distinctive body text";
  const after = "synthetic replacement with distinctive body text";
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: before }]]) });
  const result = await run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", after, "--execute", "--confirm", "detection 42 note 1"], "detection");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ after, audit: expect.any(String) });
  const lines = auditLines();
  expect(lines.map((line) => [line.kind, line.operation, line.method, line.target, line.outcome ?? null])).toEqual([
    ["intent", "qux.detection.note.edit", "PATCH", "detection 42 note 1", null],
    ["outcome", "qux.detection.note.edit", "PATCH", "detection 42 note 1", "SUCCESS"],
  ]);
  expect(lines[0]!.url).toBe("https://fixture.invalid/api/v2.5/detections/42/notes/1");
  expect(readFileSync(auditPath, "utf8")).not.toContain(before);
  expect(readFileSync(auditPath, "utf8")).not.toContain(after);
});

it("records the audit id with metadata only on delete success", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const removed = "synthetic removed note with distinctive body text";
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: removed }]]) });
  const result = await run(["account", "note", "delete", "--id", "7", "--note-id", "1",
    "--execute", "--confirm", "account 7 note 1"], "account");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ note: removed, audit: expect.any(String) });
  const lines = auditLines();
  expect(lines.map((line) => [line.kind, line.operation, line.method, line.target, line.outcome ?? null])).toEqual([
    ["intent", "qux.account.note.delete", "DELETE", "account 7 note 1", null],
    ["outcome", "qux.account.note.delete", "DELETE", "account 7 note 1", "SUCCESS"],
  ]);
  expect(readFileSync(auditPath, "utf8")).not.toContain(removed);
});

it.each(["edit", "delete"] as const)("surfaces a denied notes read as an access error before any %s send", async (action) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[]], { getStatus: 403 }) });
  const text = action === "edit" ? ["--note", "synthetic replacement"] : [];
  await expect(run(["detection", "note", action, "--id", "42", "--note-id", "1", ...text,
    "--execute", "--confirm", "detection 42 note 1"], "detection"))
    .rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
});

it.each(["edit", "delete"] as const)("rejects a malformed notes read before shaping %s output", async (action) => {
  const { run } = harness({ transport: notesTransport([], [[]], { getBody: "{\"notes\":[]}" }) });
  const text = action === "edit" ? ["--note", "synthetic replacement"] : [];
  await expect(run(["detection", "note", action, "--id", "42", "--note-id", "1", ...text,
    "--execute", "--confirm", "detection 42 note 1"], "detection"))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("reports a definitive failure when the server rejects the edit", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen,
    [[{ id: 1, note: "synthetic current note" }]], { mutateStatus: 500 }) });
  const result = await run(["host", "note", "edit", "--id", "7", "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--confirm", "host 7 note 1"], "host");
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    error: "note edit for host 7 note 1 was rejected with status 500",
    audit: expect.any(String),
  });
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 500, outcome: "FAILED" })]);
});

it("reports a definitive failure when the server rejects the delete", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen,
    [[{ id: 1, note: "synthetic current note" }]], { mutateStatus: 404 }) });
  const result = await run(["host", "note", "delete", "--id", "7", "--note-id", "1",
    "--execute", "--confirm", "host 7 note 1"], "host");
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    error: "note delete for host 7 note 1 was rejected with status 404",
    audit: expect.any(String),
  });
});

it.each(["edit", "delete"] as const)("reports OUTCOME_UNKNOWN without replay when the %s send times out", async (action) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const failure = new Error("socket timed out");
  const { run } = harness({ transport: notesTransport(seen,
    [[{ id: 1, note: "synthetic current note" }]], { mutateThrows: failure }) });
  const text = action === "edit" ? ["--note", "synthetic replacement"] : [];
  const result = await run(["detection", "note", action, "--id", "42", "--note-id", "1", ...text,
    "--execute", "--confirm", "detection 42 note 1"], "detection");
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({ audit: expect.any(String) });
  expect(result.output.error).toContain("never replay this intent");
  expect(seen.filter((call) => call.method !== "GET")).toHaveLength(1);
  const auditId = (result.output as { audit: string }).audit;
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ id: auditId, httpStatus: 0, outcome: "OUTCOME_UNKNOWN" })]);
});

it("refuses edits without hand opt-in", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5",
    auth: "token", tokenEnv: "SENTINEL_TOKEN" });
  const { run } = harness({ profile, transport: notesTransport(seen, [[{ id: 1, note: "x" }]]) });
  await expect(run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--confirm", "detection 42 note 1"], "detection"))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("lets forced read-only override a hand-enabled profile", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "x" }]]) });
  await expect(run(["detection", "note", "delete", "--id", "42", "--note-id", "1",
    "--execute", "--confirm", "detection 42 note 1"], "detection"))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
});

it("refuses operations outside the configured scope", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ ...quxProfile, writes: { allowWrites: true, operations: ["qux.host.note.edit"] } });
  const { run } = harness({ profile, transport: notesTransport(seen, [[{ id: 1, note: "x" }]]) });
  await expect(run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--confirm", "detection 42 note 1"], "detection"))
    .rejects.toMatchObject({ code: "OPERATION_NOT_WRITABLE" });
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
});

it("rejects --dry-run combined with --execute before any HTTP call", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "x" }]]) });
  await expect(run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--dry-run"], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  ["missing note id", ["detection", "note", "edit", "--id", "42", "--note", "a"], "--note-id <id>"],
  ["invalid note id", ["detection", "note", "delete", "--id", "42", "--note-id", "0"], "--note-id must be a positive integer"],
  ["missing replacement source", ["detection", "note", "edit", "--id", "42", "--note-id", "1"], "--note <text> or --note-file"],
  ["combined replacement sources", ["detection", "note", "edit", "--id", "42", "--note-id", "1", "--note", "a", "--note-file", "f"], "--note cannot be combined"],
  ["missing id", ["detection", "note", "delete", "--note-id", "1"], "requires --id"],
  ["invalid id", ["host", "note", "edit", "--id", "0", "--note-id", "1", "--note", "a"], "--id must be a positive integer"],
])("rejects %s before any HTTP call", async (_name, argv, message) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "x" }]]) });
  await expect(run(argv, "detection")).rejects.toMatchObject({ code: "VALIDATION_ERROR",
    message: expect.stringContaining(message) });
  expect(seen).toEqual([]);
});

it("rejects an empty replacement file and empty stdin without sending", async () => {
  writeFileSync(notePath, "  \n");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "x" }]]), stdin: () => "" });
  await expect(run(["detection", "note", "edit", "--id", "42", "--note-id", "1", "--note-file", notePath], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("non-empty replacement text") });
  await expect(run(["detection", "note", "edit", "--id", "42", "--note-id", "1", "--note-file", "-"], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("non-empty replacement text") });
  expect(seen).toEqual([]);
});

it("reads the replacement text from a file exactly as stored", async () => {
  writeFileSync(notePath, "synthetic file replacement\nwith a second line\n");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "synthetic current note" }]]) });
  const result = await run(["host", "note", "edit", "--id", "7", "--note-id", "1",
    "--note-file", notePath, "--execute", "--confirm", "host 7 note 1"], "host");
  expect(result.failed).toBe(false);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    expect.objectContaining({ body: JSON.stringify({ note: "synthetic file replacement\nwith a second line\n" }) }),
  ]);
});

it("reads the replacement text from stdin with --note-file -", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: "synthetic current note" }]]),
    stdin: () => "synthetic stdin replacement" });
  const result = await run(["account", "note", "edit", "--id", "7", "--note-id", "1",
    "--note-file", "-", "--execute", "--confirm", "account 7 note 1"], "account");
  expect(result.failed).toBe(false);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    expect.objectContaining({ body: JSON.stringify({ note: "synthetic stdin replacement" }) }),
  ]);
});

it("previews long before/after text truncated with totals", async () => {
  const before = "synthetic current ".repeat(100);
  const after = "synthetic replacement ".repeat(100);
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(seen, [[{ id: 1, note: before }]]) });
  const result = await run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", after], "detection");
  expect(result.failed).toBe(false);
  expect(result.output.before).toBe(`${before.slice(0, 1200)}\n... (truncated, ${before.length} chars total)`);
  expect(result.output.after).toBe(`${after.slice(0, 1200)}\n... (truncated, ${after.length} chars total)`);
  expect(seen.some((call) => call.method !== "GET")).toBe(false);
});

it("preserves literal config and profile in rejection recovery for edits", async () => {
  const config = "production's $config.json";
  const profile = "lab's $scope";
  const { run } = harness({ profile: { ...selected(), name: profile },
    transport: notesTransport([], [[{ id: 1, note: "x" }]], { mutateStatus: 403 }) });
  const result = await run(["detection", "note", "edit", "--config", config, "--profile", profile,
    "--id", "42", "--note-id", "1", "--note", "synthetic replacement",
    "--execute", "--confirm", "detection 42 note 1"], "detection");
  expect(result.failed).toBe(true);
  const hints = result.output.help as string[];
  const command = hints[0]!.split("`")[1]!;
  const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" }).split("\0").slice(0, -1);
  expect(argv).toEqual(["vectra-axi", "detection", "note", "list", "--config", config,
    "--profile", profile, "--id", "42"]);
});

it.each([
  ["detection", "edit", [{ id: 1, note: "concurrent rewrite" }], ["--note", "synthetic replacement"]],
  ["host", "edit", [], ["--note", "synthetic replacement"]],
  ["account", "delete", [{ id: 1, note: "concurrent rewrite" }], []],
] as const)("provides runnable scoped read-back after a %s %s conflict", async (kind, action, fresh, text) => {
  const config = "production's $config.json";
  const profile = "lab's $scope";
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run, session } = harness({ profile: { ...selected(), name: profile },
    transport: notesTransport(seen, [[{ id: 1, note: "synthetic current note" }], [...fresh]]) });
  const id = ids[kind];
  const error = await run([kind, "note", action, "--config", config, "--profile", profile,
    "--id", id, "--note-id", "1", ...text, "--execute", "--confirm", `${kind} ${id} note 1`], kind)
    .catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "VERSION_CONFLICT" });
  const command = (error as { suggestions: string[] }).suggestions[0]!.split("`")[1]!;
  const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" }).split("\0").slice(0, -1);
  expect(argv).toEqual(["vectra-axi", kind, "note", "list", "--config", config,
    "--profile", profile, "--id", id]);
  const invocation = parseInvocation(argv.slice(1));
  expect(invocation.leaf).toBe(`${kind} note list`);
  const result = await runNoteList(session, invocation.flags, kind);
  expect(result.failed).toBe(false);
  expect(seen).toEqual([
    { method: "GET", url: lists[kind] },
    { method: "GET", url: lists[kind] },
    { method: "GET", url: lists[kind] },
  ]);
});

it.each([
  ["detection", "42", "https://fixture.invalid/api/v3.4/detections/42/notes/1/", "rux.detection.note.edit"],
  ["host", "7", "https://fixture.invalid/api/v3.4/hosts/7/notes/1/", "rux.host.note.edit"],
  ["account", "7", "https://fixture.invalid/api/v3.4/accounts/7/notes/1/", "rux.account.note.edit"],
] as const)("edits %s %s through its trailing-slash v3.4 PATCH note route", async (kind, id, url, operation) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ ...ruxProfile });
  const { run } = harness({ profile, transport: ruxTransport(seen, [[{ id: 1, note: "synthetic cloud note" }]]) });
  const result = await run([kind, "note", "edit", "--id", id, "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--confirm", `${kind} ${id} note 1`], kind);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ type: kind, id: Number(id), noteId: 1, operation,
    after: "synthetic replacement" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url, body: JSON.stringify({ note: "synthetic replacement" }) },
  ]);
});

it.each([
  ["detection", "42", "https://fixture.invalid/api/v3.4/detections/42/notes/1/", "rux.detection.note.delete"],
  ["host", "7", "https://fixture.invalid/api/v3.4/hosts/7/notes/1/", "rux.host.note.delete"],
  ["account", "7", "https://fixture.invalid/api/v3.4/accounts/7/notes/1/", "rux.account.note.delete"],
] as const)("deletes %s %s through its trailing-slash v3.4 DELETE note route", async (kind, id, url, operation) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ ...ruxProfile });
  const { run } = harness({ profile, transport: ruxTransport(seen, [[{ id: 1, note: "synthetic cloud note" }]]) });
  const result = await run([kind, "note", "delete", "--id", id, "--note-id", "1",
    "--execute", "--confirm", `${kind} ${id} note 1`], kind);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ type: kind, id: Number(id), noteId: 1, operation,
    note: "synthetic cloud note" });
  expect(seen.filter((call) => call.method === "DELETE")).toEqual([{ method: "DELETE", url }]);
});

it("refuses a RUX edit when the note text moves between preview and send", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ ...ruxProfile });
  const { run } = harness({ profile, transport: ruxTransport(seen,
    [[{ id: 1, note: "synthetic cloud note" }], [{ id: 1, note: "concurrent rewrite" }]]) });
  await expect(run(["detection", "note", "edit", "--id", "42", "--note-id", "1",
    "--note", "synthetic replacement", "--execute", "--confirm", "detection 42 note 1"], "detection"))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.some((call) => call.method === "PATCH")).toBe(false);
});

it("reads exactly one replacement source through desiredEditText", () => {
  expect(desiredEditText(new Map([["note", "synthetic replacement"]]), "detection"))
    .toBe("synthetic replacement");
  expect(desiredEditText(new Map([["note-file", "-"]]), "host", () => "synthetic stdin replacement"))
    .toBe("synthetic stdin replacement");
  expect(() => desiredEditText(new Map([["note", "a"], ["note-file", "f"]]), "account"))
    .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  expect(() => desiredEditText(new Map(), "detection"))
    .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
});

it("parses the addressed note id through noteEntryId", () => {
  expect(noteEntryId(new Map([["note-id", "7"]]), "detection note edit")).toBe(7);
  expect(() => noteEntryId(new Map(), "detection note edit"))
    .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  expect(() => noteEntryId(new Map([["note-id", "0"]]), "host note delete"))
    .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
});
