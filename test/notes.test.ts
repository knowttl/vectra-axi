import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { catalogue, inventory, parseInvocation } from "../src/catalogue.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { NOTE_TRUNCATE_AT, embeddedNoteSummary, runNoteList, runTagList, type NoteKind } from "../src/notes.js";
import { runDetectionShow } from "../src/detections.js";
import { runAccountShow, runHostShow } from "../src/entities.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".notes-test-"));
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

const routes: Record<NoteKind, { notes: string; tags: string }> = {
  detection: {
    notes: "https://fixture.invalid/api/v2.5/detections/42/notes",
    tags: "https://fixture.invalid/api/v2.5/tagging/detection/42",
  },
  host: {
    notes: "https://fixture.invalid/api/v2.5/hosts/7/notes",
    tags: "https://fixture.invalid/api/v2.5/tagging/host/7",
  },
  account: {
    notes: "https://fixture.invalid/api/v2.5/accounts/7/notes",
    tags: "https://fixture.invalid/api/v2.5/tagging/account/7",
  },
};
const ids: Record<NoteKind, string> = { detection: "42", host: "7", account: "7" };

it.each(["detection", "host", "account"] as const)("reads full %s notes through the versioned notes route", async (kind) => {
  const id = ids[kind];
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    expect(request.method).toBe("GET");
    return { status: 200, bodyText: JSON.stringify([
      { id: 1, note: "synthetic first note" },
      { id: 2, note: "synthetic second note" },
    ]) };
  };
  const result = await runNoteList(session(transport), flags([kind, "note", "list", "--id", id]), kind);
  expect(url).toBe(routes[kind].notes);
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: kind,
    id: Number(id),
    count: "2 notes",
    notes: [{ id: 1, note: "synthetic first note" }, { id: 2, note: "synthetic second note" }],
    complete: true,
  } });
});

it.each(["detection", "host", "account"] as const)("reads %s tags through the versioned tagging route", async (kind) => {
  const id = ids[kind];
  let url = "";
  const transport: RawTransport = async (request) => {
    url = request.url;
    expect(request.method).toBe("GET");
    return { status: 200, bodyText: JSON.stringify({ tags: ["synthetic-a", "synthetic-b"] }) };
  };
  const result = await runTagList(session(transport), flags([kind, "tag", "list", "--id", id]), kind);
  expect(url).toBe(routes[kind].tags);
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: kind,
    id: Number(id),
    count: "2 tags",
    tags: ["synthetic-a", "synthetic-b"],
    complete: true,
  } });
});

it("previews long note text with its total and a --full hint for the returned text", async () => {
  const text = "synthetic note ".repeat(100);
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify([{ id: 1, note: text }]),
  });
  const owned = session(transport);
  const previewed = await runNoteList(owned, flags(["detection", "note", "list", "--id", "42"]), "detection");
  expect(previewed.output.notes).toEqual([
    { id: 1, note: `${text.slice(0, NOTE_TRUNCATE_AT)}\n... (truncated, ${text.length} chars total)` },
  ]);
  expect(previewed.output.help).toEqual([
    "Run `vectra-axi detection note list --profile lab --id 42 --full` for the complete returned text",
  ]);
  const full = await runNoteList(owned, flags(["detection", "note", "list", "--id", "42", "--full"]), "detection");
  expect(full).toEqual({ failed: false, output: {
    profile: "lab",
    type: "detection",
    id: 42,
    count: "1 notes",
    notes: [{ id: 1, note: text }],
    complete: true,
  } });
});

it("preserves null and absent note text", async () => {
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify([{ id: 1, note: null }, { id: 2 }]),
  });
  const result = await runNoteList(session(transport), flags(["host", "note", "list", "--id", "7"]), "host");
  expect(result.output.notes).toEqual([{ id: 1, note: null }, { id: 2 }]);
});

it("states an explicit empty notes result with its owner", async () => {
  const transport: RawTransport = async () => ({ status: 200, bodyText: "[]" });
  const result = await runNoteList(session(transport), flags(["account", "note", "list", "--id", "7"]), "account");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "account",
    id: 7,
    count: "0 notes",
    notes: "0 notes found for account 7",
    complete: true,
  } });
});

it("states an explicit empty tags result with its owner", async () => {
  const transport: RawTransport = async () => ({ status: 200, bodyText: JSON.stringify({ tags: [] }) });
  const result = await runTagList(session(transport), flags(["host", "tag", "list", "--id", "7"]), "host");
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    type: "host",
    id: 7,
    count: "0 tags",
    tags: "0 tags found for host 7",
    complete: true,
  } });
});

it("surfaces denied note and tag reads as access errors", async () => {
  const seen: string[] = [];
  const transport: RawTransport = async (request) => {
    seen.push(request.url);
    return { status: 403, bodyText: "{}" };
  };
  const owned = session(transport);
  await expect(runNoteList(owned, flags(["detection", "note", "list", "--id", "42"]), "detection"))
    .rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(runTagList(owned, flags(["detection", "tag", "list", "--id", "42"]), "detection"))
    .rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(seen).toEqual([
    "https://fixture.invalid/api/v2.5/detections/42/notes",
    "https://fixture.invalid/api/v2.5/tagging/detection/42",
  ]);
});

it.each([
  ["notes envelope", "[1,2]", "notes response is malformed"],
  ["note entry", '[{"id":1,"note":7}]', "valid note fields"],
  ["note id", '[{"id":0,"note":"x"}]', "valid note fields"],
  ["tags envelope", "[]", "tags list"],
  ["tags entry", '{"tags":["ok",7]}', "tags list"],
  ["tags missing", "{}", "tags list"],
])("rejects a malformed %s before shaping output", async (_name, bodyText, message) => {
  const transport: RawTransport = async () => ({ status: 200, bodyText });
  const owned = session(transport);
  const noteArgs = ["detection", "note", "list", "--id", "42"] as const;
  const tagArgs = ["detection", "tag", "list", "--id", "42"] as const;
  if (_name.startsWith("note")) {
    await expect(runNoteList(owned, flags([...noteArgs]), "detection"))
      .rejects.toMatchObject({ code: "RESPONSE_INVALID", message: expect.stringContaining(message) });
  } else {
    await expect(runTagList(owned, flags([...tagArgs]), "detection"))
      .rejects.toMatchObject({ code: "RESPONSE_INVALID", message: expect.stringContaining(message) });
  }
});

it.each([
  ["detection", "note"],
  ["detection", "tag"],
  ["host", "note"],
  ["host", "tag"],
  ["account", "note"],
  ["account", "tag"],
] as const)("requires --id for %s %s before any HTTP call", async (kind, family) => {
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return { status: 200, bodyText: "[]" };
  };
  const run = family === "note" ? runNoteList : runTagList;
  await expect(run(session(transport), flags([kind, family, "list"]), kind))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining(`${kind} ${family} list requires --id`) });
  await expect(run(session(transport), flags([kind, family, "list", "--id", "0"]), kind))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(calls).toBe(0);
});

it("surfaces an embedded note summary separately from the full notes resource", async () => {
  const summary = "synthetic embedded summary";
  const detectionTransport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({
      id: 1, detection_type: "synthetic-type", state: "active", threat: 71, certainty: 80, note: summary,
    }),
  });
  const shown = await runDetectionShow(session(detectionTransport), flags(["detection", "show", "--id", "1"]));
  expect(shown.output).toMatchObject({ note_summary: summary });
  expect(shown.output.help).toEqual([
    "Run `vectra-axi detection note list --profile lab --id 1` for the full notes",
  ]);
  expect(shown.output).not.toHaveProperty("note");
  expect(embeddedNoteSummary({ note: summary })).toBe(summary);
  expect(embeddedNoteSummary({})).toBeUndefined();
  expect(embeddedNoteSummary({ note: null })).toBeUndefined();
});

it("points host and account summaries at their own note leaves", async () => {
  const summary = "synthetic embedded summary";
  const transport: RawTransport = async (request) => {
    const id = 7;
    const base = request.url.includes("/hosts")
      ? { id, name: "synthetic-host-7", state: "active", threat: 90, certainty: 80 }
      : { id, name: "synthetic-account-7", state: "active", threat: 10, certainty: 20 };
    return { status: 200, bodyText: JSON.stringify({ ...base, note: summary }) };
  };
  const owned = session(transport);
  const host = await runHostShow(owned, flags(["host", "show", "--id", "7"]));
  expect(host.output).toMatchObject({ type: "host", note_summary: summary });
  expect(host.output.help).toEqual(["Run `vectra-axi host note list --profile lab --id 7` for the full notes"]);
  const account = await runAccountShow(owned, flags(["account", "show", "--id", "7"]));
  expect(account.output).toMatchObject({ type: "account", note_summary: summary });
  expect(account.output.help).toEqual(["Run `vectra-axi account note list --profile lab --id 7` for the full notes"]);
});

it("omits the summary key when no embedded summary is present", async () => {
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ id: 1, detection_type: "t", state: "active", threat: 1, certainty: 1 }),
  });
  const shown = await runDetectionShow(session(transport), flags(["detection", "show", "--id", "1"]));
  expect(shown.output).not.toHaveProperty("note_summary");
  expect(shown.output).not.toHaveProperty("help");
});

it("rejects a malformed embedded summary", async () => {
  const transport: RawTransport = async () => ({
    status: 200, bodyText: JSON.stringify({ id: 1, detection_type: "t", state: "active", threat: 1, certainty: 1, note: 7 }),
  });
  await expect(runDetectionShow(session(transport), flags(["detection", "show", "--id", "1"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("constructs no write request for notes or tags", async () => {
  expect(Object.keys(catalogue).filter((leaf) =>
    leaf.includes("note") || leaf.includes("tag"))).toEqual([
    "detection note list",
    "detection tag list",
    "host note list",
    "host tag list",
    "account note list",
    "account tag list",
  ]);
  const deferred = inventory.deferredFamilies
    .filter((family) => family.id.endsWith("note-writes") || family.id.endsWith("tag-writes"));
  expect(deferred.map((family) => family.id).sort()).toEqual([
    "qux.later.note-writes",
    "qux.later.tag-writes",
    "rux.later.note-writes",
    "rux.later.tag-writes",
  ]);
  for (const family of deferred) expect(family.disposition).toBe("planned");
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return { status: 200, bodyText: "{}" };
  };
  await expect(session(transport).request("qux.detection.note.create", { pathParams: { id: 42 } }))
    .rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect(calls).toBe(0);
});

it.each([
  [["detection", "note", "list", "--id", "42"], "detection note list"],
  [["detection", "tag", "list", "--id", "42"], "detection tag list"],
  [["host", "note", "list", "--id", "7"], "host note list"],
  [["host", "tag", "list", "--id", "7"], "host tag list"],
  [["account", "note", "list", "--id", "7"], "account note list"],
  [["account", "tag", "list", "--id", "7"], "account tag list"],
])("resolves %s to the %s leaf", (argv, leaf) => {
  expect(parseInvocation(argv)).toMatchObject({ leaf, home: false });
});

it.each([
  [["detection", "note"], "Unknown command: detection note"],
  [["host", "tag"], "Unknown command: host tag"],
  [["account", "note"], "Unknown command: account note"],
  [["detection", "note", "list", "--tags", "x"], "Unknown flag: --tags"],
  [["host", "tag", "list", "--full"], "Unknown flag: --full"],
  [["detection", "note", "list", "--id", "42", "--limit", "5"], "Unknown flag: --limit"],
  [["detection", "note", "show", "--id", "42"], "Unknown command: detection note show"],
])("rejects %s at the catalogue", (argv, message) => {
  expect(() => parseInvocation(argv)).toThrow(expect.objectContaining({
    code: "VALIDATION_ERROR", message: expect.stringContaining(message),
  }));
});
