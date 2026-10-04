import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile, type SelectedProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { desiredNote, runNoteAdd } from "../src/note-add.js";
import { createMutationCoordinator, type MutationCoordinator } from "../src/writes.js";
import type { LeafResult, NoteKind } from "../src/notes.js";

// WRITE-02 acceptance: action-shaped note appends for one detection, host
// or account through the WRITE-00 gate pipeline. Every transport is a
// synthetic fixture; no live instance, real credential or customer data.
const scratch = mkdtempSync(join(import.meta.dirname, ".note-add-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const notePath = join(scratch, "note.txt");
const token = "fake-token-SENTINEL";
const NOW = 1_700_000_000_000;

const NOTE_OPERATIONS = ["qux.detection.note.add", "qux.host.note.add", "qux.account.note.add"];
const enabledProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN", writes: { allowWrites: true, operations: NOTE_OPERATIONS } };

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", token);
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configPath, { force: true });
  rmSync(auditPath, { force: true, recursive: true });
  rmSync(notePath, { force: true });
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
    return runNoteAdd(session, coordinator, flags, kind, args.stdin ?? (() => ""));
  };
  return { session, coordinator, run };
}

// Fixture notes transport: GETs serve the current notes resource, POSTs
// record the appended body. Status overrides simulate denial and failures.
function notesTransport(current: () => unknown[], seen: { method: string; url: string; body?: string }[],
  overrides?: { getStatus?: number; getBody?: string; postStatus?: number; postThrows?: unknown },
): RawTransport {
  return async (request) => {
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET") {
      return { status: overrides?.getStatus ?? 200,
        bodyText: overrides?.getBody ?? JSON.stringify(current()) };
    }
    if (overrides?.postThrows !== undefined) throw overrides.postThrows;
    return { status: overrides?.postStatus ?? 200, bodyText: "{}" };
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
] as const)("blocks %s note appends with %s before audit intent (%s)", async (kind, confirmation, code) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen) });
  await expect(run([kind, "note", "add", "--id", "42", "--note", "synthetic note", "--execute", ...confirmation], kind))
    .rejects.toMatchObject({ code });
  expect(seen).toEqual([{ method: "GET", url: `https://fixture.invalid/api/v2.5/${kind}s/42/notes` }]);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it.each([
  ["detection", "42", "https://fixture.invalid/api/v2.5/detections/42/notes", "qux.detection.note.add"],
  ["host", "7", "https://fixture.invalid/api/v2.5/hosts/7/notes", "qux.host.note.add"],
  ["account", "7", "https://fixture.invalid/api/v2.5/accounts/7/notes", "qux.account.note.add"],
] as const)("appends %s %s through its own POST notes route", async (kind, id, url, operation) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen) });
  const result = await run([kind, "note", "add", "--id", id, "--note", "synthetic note",
    "--execute", "--confirm", `${kind} ${id}`], kind);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ type: kind, id: Number(id), operation, note: "synthetic note" });
  const posts = seen.filter((call) => call.method === "POST");
  expect(posts).toEqual([{ method: "POST", url, body: JSON.stringify({ note: "synthetic note" }) }]);
});

it("previews the exact note to be appended without sending", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [{ id: 1, note: "existing note" }], seen) });
  const result = await run(["detection", "note", "add", "--id", "42", "--note", "synthetic note"], "detection");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "detection",
    id: 42,
    operation: "qux.detection.note.add",
    note: "synthetic note",
    help: ["Re-run with --execute --confirm 'detection 42' to append the note to detection 42"],
  } });
  expect(seen.some((call) => call.method === "POST")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("appends every execution: repeated identical notes are never a no-op", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen) });
  for (let count = 0; count < 2; count++) {
    const result = await run(["host", "note", "add", "--id", "7", "--note", "synthetic note",
      "--execute", "--confirm", "host 7"], "host");
    expect(result.failed).toBe(false);
    expect(result.output).toMatchObject({ note: "synthetic note", audit: expect.any(String) });
  }
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(2);
});

it("records the audit id with metadata only on success", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const note = "synthetic appended note with distinctive body text";
  const { run } = harness({ transport: notesTransport(() => [], seen) });
  const result = await run(["detection", "note", "add", "--id", "42", "--note", note,
    "--execute", "--confirm", "detection 42"], "detection");
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ note, audit: expect.any(String) });
  const lines = auditLines();
  expect(lines.map((line) => [line.kind, line.operation, line.method, line.target, line.outcome ?? null])).toEqual([
    ["intent", "qux.detection.note.add", "POST", "detection 42", null],
    ["outcome", "qux.detection.note.add", "POST", "detection 42", "SUCCESS"],
  ]);
  expect(lines[0]!.url).toBe("https://fixture.invalid/api/v2.5/detections/42/notes");
  expect(readFileSync(auditPath, "utf8")).not.toContain(note);
});

it("surfaces a denied notes read as an access error before any send", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen, { getStatus: 403 }) });
  await expect(run(["detection", "note", "add", "--id", "42", "--note", "synthetic note",
    "--execute", "--confirm", "detection 42"], "detection"))
    .rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(seen.some((call) => call.method === "POST")).toBe(false);
});

it("rejects a malformed notes read before shaping output", async () => {
  const { run } = harness({ transport: notesTransport(() => [], [], { getBody: "{\"notes\":[]}" }) });
  await expect(run(["detection", "note", "add", "--id", "42", "--note", "synthetic note",
    "--execute", "--confirm", "detection 42"], "detection"))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("reports a definitive failure when the server rejects the append", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen, { postStatus: 500 }) });
  const result = await run(["host", "note", "add", "--id", "7", "--note", "synthetic note",
    "--execute", "--confirm", "host 7"], "host");
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    error: "note append for host 7 was rejected with status 500",
    audit: expect.any(String),
  });
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 500, outcome: "FAILED" })]);
});

it("reports OUTCOME_UNKNOWN without replay when the send times out", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const failure = new Error("socket timed out");
  const { run } = harness({ transport: notesTransport(() => [], seen, { postThrows: failure }) });
  const result = await run(["detection", "note", "add", "--id", "42", "--note", "synthetic note",
    "--execute", "--confirm", "detection 42"], "detection");
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({ audit: expect.any(String) });
  expect(result.output.error).toContain("never replay this intent");
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  const auditId = (result.output as { audit: string }).audit;
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ id: auditId, httpStatus: 0, outcome: "OUTCOME_UNKNOWN" })]);
});

it("refuses writes without hand opt-in", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5",
    auth: "token", tokenEnv: "SENTINEL_TOKEN" });
  const { run } = harness({ profile, transport: notesTransport(() => [], seen) });
  await expect(run(["detection", "note", "add", "--id", "42", "--note", "synthetic note",
    "--execute", "--confirm", "detection 42"], "detection"))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen.some((call) => call.method === "POST")).toBe(false);
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("lets forced read-only override a hand-enabled profile", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen) });
  await expect(run(["detection", "note", "add", "--id", "42", "--note", "synthetic note",
    "--execute", "--confirm", "detection 42"], "detection"))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen.some((call) => call.method === "POST")).toBe(false);
});

it("refuses operations outside the configured scope", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const profile = selected({ ...enabledProfile, writes: { allowWrites: true, operations: ["qux.host.note.add"] } });
  const { run } = harness({ profile, transport: notesTransport(() => [], seen) });
  await expect(run(["detection", "note", "add", "--id", "42", "--note", "synthetic note",
    "--execute", "--confirm", "detection 42"], "detection"))
    .rejects.toMatchObject({ code: "OPERATION_NOT_WRITABLE" });
  expect(seen.some((call) => call.method === "POST")).toBe(false);
});

it("rejects --dry-run combined with --execute before any HTTP call", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen) });
  await expect(run(["detection", "note", "add", "--id", "42", "--note", "synthetic note",
    "--execute", "--dry-run"], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  ["missing note source", ["detection", "note", "add", "--id", "42", "--execute"], "--note <text> or --note-file"],
  ["combined note sources", ["detection", "note", "add", "--id", "42", "--note", "a", "--note-file", "f", "--execute"], "--note cannot be combined"],
  ["missing id", ["detection", "note", "add", "--note", "a"], "requires --id"],
  ["invalid id", ["detection", "note", "add", "--id", "0", "--note", "a"], "--id must be a positive integer"],
])("rejects %s before any HTTP call", async (_name, argv, message) => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen) });
  await expect(run(argv, "detection")).rejects.toMatchObject({ code: "VALIDATION_ERROR",
    message: expect.stringContaining(message) });
  expect(seen).toEqual([]);
});

it("rejects an empty note file and empty stdin without sending", async () => {
  writeFileSync(notePath, "  \n");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen), stdin: () => "" });
  await expect(run(["detection", "note", "add", "--id", "42", "--note-file", notePath], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("non-empty note") });
  await expect(run(["detection", "note", "add", "--id", "42", "--note-file", "-"], "detection"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("non-empty note") });
  expect(seen).toEqual([]);
});

it("reads the note from a file exactly as stored", async () => {
  writeFileSync(notePath, "synthetic file note\nwith a second line\n");
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen) });
  const result = await run(["host", "note", "add", "--id", "7", "--note-file", notePath,
    "--execute", "--confirm", "host 7"], "host");
  expect(result.failed).toBe(false);
  expect(seen.filter((call) => call.method === "POST")).toEqual([
    expect.objectContaining({ body: JSON.stringify({ note: "synthetic file note\nwith a second line\n" }) }),
  ]);
});

it("reads the note from stdin with --note-file -", async () => {
  const seen: { method: string; url: string; body?: string }[] = [];
  const { run } = harness({ transport: notesTransport(() => [], seen), stdin: () => "synthetic stdin note" });
  const result = await run(["account", "note", "add", "--id", "7", "--note-file", "-",
    "--execute", "--confirm", "account 7"], "account");
  expect(result.failed).toBe(false);
  expect(seen.filter((call) => call.method === "POST")).toEqual([
    expect.objectContaining({ body: JSON.stringify({ note: "synthetic stdin note" }) }),
  ]);
});

it.each(["detection", "host", "account"] as const)("preserves literal config and profile in rejection recovery for %s", async (kind) => {
  const config = "production's $config.json";
  const profile = "lab's $scope";
  const { run } = harness({ profile: { ...selected(), name: profile },
    transport: notesTransport(() => [], [], { postStatus: 403 }) });
  const id = kind === "detection" ? "42" : "7";
  const result = await run([kind, "note", "add", "--config", config, "--profile", profile,
    "--id", id, "--note", "synthetic note", "--execute", "--confirm", `${kind} ${id}`], kind);
  expect(result.failed).toBe(true);
  const hints = result.output.help as string[];
  const command = hints[0]!.split("`")[1]!;
  const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" }).split("\0").slice(0, -1);
  expect(argv).toEqual(["vectra-axi", kind, "note", "list", "--config", config,
    "--profile", profile, "--id", id]);
});

it("never exposes the note append through the read session", async () => {
  const { session } = harness({ transport: notesTransport(() => [], []) });
  await expect(session.request("qux.detection.note.add", { pathParams: { id: 42 } }))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
});

it("reads exactly one note source through desiredNote", () => {
  expect(desiredNote(new Map([["note", "synthetic note"]]), "detection")).toBe("synthetic note");
  expect(desiredNote(new Map([["note-file", "-"]]), "host", () => "synthetic stdin note"))
    .toBe("synthetic stdin note");
  expect(() => desiredNote(new Map([["note", "a"], ["note-file", "f"]]), "account"))
    .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  expect(() => desiredNote(new Map(), "detection"))
    .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
});
