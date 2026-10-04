import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, renameSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it } from "vitest";
import { decode } from "@toon-format/toon";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(root, ".cli-test-"));
const home = join(scratch, "home");
const unpacked = join(scratch, "package");
const preload = pathToFileURL(join(root, "dist/test/network-guard.js")).href;
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const env = { HOME: home, USERPROFILE: home, NODE_OPTIONS: `--import=${preload}`,
  SystemRoot: process.env.SystemRoot ?? "" };
let bin: string;

beforeAll(() => {
  mkdirSync(home);
  const archive = join(scratch, "vectra-axi.tgz");
  execFileSync(process.execPath, [process.env.npm_execpath!, "pack", "--out", archive], {
    cwd: root, env: { ...process.env, ...env, HOME: join(scratch, "pack-home"), USERPROFILE: join(scratch, "pack-home") },
    stdio: "pipe", timeout: 20_000,
  });
  execFileSync("tar", ["-xzf", archive, "-C", scratch], { timeout: 10_000 });
  symlinkSync(join(root, "node_modules"), join(unpacked, "node_modules"), "junction");
  const manifest = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
  bin = join(unpacked, manifest.bin["vectra-axi"]);
}, 30_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function invoke(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: home, env: { ...env, ...extraEnv }, encoding: "utf8", input: "", timeout: 5_000,
  });
}

it("investigates a detection through the packaged list, show, full and resume commands", () => {
  const config = join(scratch, "investigation.json");
  const trace = join(scratch, "investigation-requests.jsonl");
  const profile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5",
    auth: "token", tokenEnv: "SENTINEL_TOKEN" };
  writeFileSync(config, JSON.stringify({ profiles: {
    lab: profile, other: { ...profile, origin: "https://other.invalid" },
  }, defaultProfile: "other" }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const listed = invoke(["detection", "list", ...context, "--state", "active", "--threat-gte", "70",
    "--fields", "id,state,threat", "--limit", "1"], fixtureEnv);
  expect(listed.status).toBe(0);
  expect(listed.stderr).toBe("");
  const listOutput = decode(listed.stdout) as Record<string, unknown>;
  expect(listOutput).toMatchObject({ profile: "lab", count: "1 of 2 detections", complete: true,
    detections: [{ id: 1, state: "active", threat: null }], cursor: expect.any(String) });
  const showHint = (listOutput.help as string[]).find((hint) => hint.startsWith("Run `"))!;
  const showCommand = /^Run `vectra-axi (detection show .*?)` for full detail$/.exec(showHint)![1]!;
  const showArgs = execFileSync("sh", ["-c", `set -- ${showCommand}; printf '%s\\n' "$@"`],
    { encoding: "utf8" }).trimEnd().split("\n");
  const shown = invoke(showArgs, fixtureEnv);
  expect(shown.status).toBe(0);
  expect(shown.stderr).toBe("");
  const showOutput = decode(shown.stdout) as Record<string, unknown>;
  expect(showOutput).toMatchObject({ profile: "lab", id: 1, threat: null,
    description: `${"synthetic detail ".repeat(100).slice(0, 1200)}\n... (truncated, 1700 chars total)` });
  const [fullHint] = showOutput.help as string[];
  const fullCommand = /^Run `vectra-axi (detection show .*? --full)` for the complete text$/.exec(fullHint!)![1]!;
  const fullArgs = execFileSync("sh", ["-c", `set -- ${fullCommand}; printf '%s\\n' "$@"`],
    { encoding: "utf8" }).trimEnd().split("\n");
  const full = invoke(fullArgs, fixtureEnv);
  expect(full.status).toBe(0);
  expect(full.stderr).toBe("");
  const fullOutput = decode(full.stdout) as Record<string, unknown>;
  expect(fullOutput).toEqual({ profile: "lab", id: 1, detection_type: "synthetic-type", state: "active",
    threat: null, certainty: 80, description: "synthetic detail ".repeat(100) });
  const cursor = listOutput.cursor as string;
  const resumed = invoke(["detection", "list", ...context, "--state", "active", "--threat-gte", "70",
    "--fields", "id,state,threat", "--cursor", cursor], fixtureEnv);
  expect(resumed.status).toBe(0);
  expect(resumed.stderr).toBe("");
  const resumedOutput = decode(resumed.stdout) as Record<string, unknown>;
  expect(resumedOutput).toMatchObject({ profile: "lab", detections: [{ id: 2, state: "active", threat: 72 }],
    complete: true });
  expect(resumedOutput).not.toHaveProperty("cursor");
  const requests = readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(requests).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections?state=active&threat_gte=70" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections/1" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections/1" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections?state=active&threat_gte=70&min_id=2" },
  ]);
});

it("keeps the same numeric host and account IDs distinct through the entity facade", () => {
  const config = join(scratch, "entities.json");
  const trace = join(scratch, "entities-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const hostShown = invoke(["host", "show", ...context, "--id", "7"], fixtureEnv);
  expect(hostShown.status).toBe(0);
  expect(hostShown.stderr).toBe("");
  expect(decode(hostShown.stdout)).toMatchObject({ profile: "lab", type: "host", id: 7, threat: 90 });
  const accountShown = invoke(["account", "show", ...context, "--id", "7"], fixtureEnv);
  expect(accountShown.status).toBe(0);
  expect(accountShown.stderr).toBe("");
  expect(decode(accountShown.stdout)).toMatchObject({ profile: "lab", type: "account", id: 7, threat: 10 });
  const listed = invoke(["entity", "list", ...context, "--type", "host", "--threat-gte", "70"], fixtureEnv);
  expect(listed.status).toBe(0);
  expect(listed.stderr).toBe("");
  const listOutput = decode(listed.stdout) as Record<string, unknown>;
  expect(listOutput).toMatchObject({ profile: "lab", type: "host", count: "1 hosts",
    entities: [{ id: 7, name: "synthetic-host-7", threat: 90, certainty: 80 }], complete: true });
  expect((listOutput.entities as Record<string, unknown>[])[0]).not.toHaveProperty("state");
  const untyped = invoke(["entity", "list", ...context], fixtureEnv);
  expect(untyped.status).toBe(2);
  expect(untyped.stdout).toContain("--type");
  expect(untyped.stderr).toBe("");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/hosts/7" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/accounts/7" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/hosts?t_score_gte=70" },
  ]);
});

it("reads notes and tags through the packaged note, full and tag commands", () => {
  const config = join(scratch, "notes.json");
  const trace = join(scratch, "notes-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const noted = invoke(["detection", "note", "list", ...context, "--id", "42"], fixtureEnv);
  expect(noted.status).toBe(0);
  expect(noted.stderr).toBe("");
  const noteOutput = decode(noted.stdout) as Record<string, unknown>;
  expect(noteOutput).toMatchObject({ profile: "lab", type: "detection", id: 42, count: "2 notes",
    notes: [{ id: 1, note: `${"synthetic detail ".repeat(100).slice(0, 1200)}\n... (truncated, 1700 chars total)` },
      { id: 2, note: "short synthetic note" }],
    complete: true });
  const [noteHint] = noteOutput.help as string[];
  const fullCommand = /^Run `vectra-axi (detection note list .*? --full)` for the complete returned text$/.exec(noteHint!)![1]!;
  const fullArgs = execFileSync("sh", ["-c", `set -- ${fullCommand}; printf '%s\\n' "$@"`],
    { encoding: "utf8" }).trimEnd().split("\n");
  const full = invoke(fullArgs, fixtureEnv);
  expect(full.status).toBe(0);
  expect(full.stderr).toBe("");
  expect(decode(full.stdout)).toMatchObject({ profile: "lab", type: "detection", id: 42, count: "2 notes",
    notes: [{ id: 1, note: "synthetic detail ".repeat(100) }, { id: 2, note: "short synthetic note" }] });
  const tagged = invoke(["host", "tag", "list", ...context, "--id", "7"], fixtureEnv);
  expect(tagged.status).toBe(0);
  expect(tagged.stderr).toBe("");
  expect(decode(tagged.stdout)).toMatchObject({ profile: "lab", type: "host", id: 7,
    count: "1 tags", tags: ["synthetic-tag"], complete: true });
  const empty = invoke(["account", "note", "list", ...context, "--id", "7"], fixtureEnv);
  expect(empty.status).toBe(0);
  expect(empty.stderr).toBe("");
  expect(decode(empty.stdout)).toMatchObject({ profile: "lab", type: "account", id: 7,
    count: "0 notes", notes: "0 notes found for account 7", complete: true });
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections/42/notes" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections/42/notes" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/tagging/host/7" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/accounts/7/notes" },
  ]);
});

it("previews and executes a gated tag replace through the packaged binary", () => {
  const config = join(scratch, "tagset.json");
  const trace = join(scratch, "tagset-requests.jsonl");
  const journal = join(scratch, "tagset-writes.log");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
    writes: { allowWrites: true, operations: ["qux.host.tag.set"] } } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    VECTRA_AXI_WRITE_LOG: journal,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const preview = invoke(["host", "tag", "set", ...context, "--id", "7",
    "--tags", "synthetic-tag,fresh"], fixtureEnv);
  expect(preview.status).toBe(0);
  expect(preview.stderr).toBe("");
  expect(decode(preview.stdout)).toMatchObject({ profile: "lab", type: "host", id: 7,
    current: ["synthetic-tag"], desired: ["synthetic-tag", "fresh"],
    added: ["fresh"], removed: "no tags to remove" });
  const unconfirmed = invoke(["host", "tag", "set", ...context, "--id", "7",
    "--tags", "synthetic-tag,fresh", "--execute"], fixtureEnv);
  expect(unconfirmed.status).toBe(1);
  expect(unconfirmed.stdout).toContain("code: CONFIRM_REQUIRED");
  expect(unconfirmed.stderr).toBe("");
  expect(() => readFileSync(journal, "utf8")).toThrow();
  const applied = invoke(["host", "tag", "set", ...context, "--id", "7",
    "--tags", "synthetic-tag,fresh", "--execute", "--confirm", "host 7"], fixtureEnv);
  expect(applied.status).toBe(0);
  expect(applied.stderr).toBe("");
  const appliedOutput = decode(applied.stdout) as Record<string, unknown>;
  expect(appliedOutput).toMatchObject({ profile: "lab", type: "host", id: 7,
    tags: ["synthetic-tag", "fresh"], audit: expect.any(String) });
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/tagging/host/7" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/tagging/host/7" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/tagging/host/7" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/tagging/host/7" },
    { method: "PATCH", url: "https://fixture.invalid/api/v2.5/tagging/host/7",
      body: { tags: ["synthetic-tag", "fresh"] } },
  ]);
  expect(readFileSync(journal, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)))
    .toEqual([
      expect.objectContaining({ kind: "intent", operation: "qux.host.tag.set", method: "PATCH",
        target: "host 7" }),
      expect.objectContaining({ kind: "outcome", operation: "qux.host.tag.set", httpStatus: 200,
        outcome: "SUCCESS" }),
    ]);
});

it("refuses a packaged tag replace without hand opt-in", () => {
  const config = join(scratch, "tagset-disabled.json");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: join(scratch, "tagset-disabled.jsonl"),
    VECTRA_AXI_WRITE_LOG: join(scratch, "tagset-disabled.log"),
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const refused = invoke(["host", "tag", "set", "--config", config, "--profile", "lab",
    "--id", "7", "--tags", "fresh", "--execute"], fixtureEnv);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toContain("code: WRITES_DISABLED");
  expect(refused.stderr).toBe("");
});

it("previews and executes a gated note append through the packaged binary", () => {
  const config = join(scratch, "noteadd.json");
  const trace = join(scratch, "noteadd-requests.jsonl");
  const journal = join(scratch, "noteadd-writes.log");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
    writes: { allowWrites: true, operations: ["qux.detection.note.add"] } } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    VECTRA_AXI_WRITE_LOG: journal,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const preview = invoke(["detection", "note", "add", ...context, "--id", "42",
    "--note", "synthetic appended note"], fixtureEnv);
  expect(preview.status).toBe(0);
  expect(preview.stderr).toBe("");
  expect(decode(preview.stdout)).toMatchObject({ profile: "lab", type: "detection", id: 42,
    operation: "qux.detection.note.add", note: "synthetic appended note" });
  const unconfirmed = invoke(["detection", "note", "add", ...context, "--id", "42",
    "--note", "synthetic appended note", "--execute"], fixtureEnv);
  expect(unconfirmed.status).toBe(1);
  expect(unconfirmed.stdout).toContain("code: CONFIRM_REQUIRED");
  expect(unconfirmed.stderr).toBe("");
  expect(() => readFileSync(journal, "utf8")).toThrow();
  const applied = invoke(["detection", "note", "add", ...context, "--id", "42",
    "--note", "synthetic appended note", "--execute", "--confirm", "detection 42"], fixtureEnv);
  expect(applied.status).toBe(0);
  expect(applied.stderr).toBe("");
  const appliedOutput = decode(applied.stdout) as Record<string, unknown>;
  expect(appliedOutput).toMatchObject({ profile: "lab", type: "detection", id: 42,
    operation: "qux.detection.note.add", note: "synthetic appended note", audit: expect.any(String) });
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections/42/notes" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections/42/notes" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections/42/notes" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections/42/notes" },
    { method: "POST", url: "https://fixture.invalid/api/v2.5/detections/42/notes",
      body: { note: "synthetic appended note" } },
  ]);
  expect(readFileSync(journal, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)))
    .toEqual([
      expect.objectContaining({ kind: "intent", operation: "qux.detection.note.add", method: "POST",
        target: "detection 42" }),
      expect.objectContaining({ kind: "outcome", operation: "qux.detection.note.add", httpStatus: 200,
        outcome: "SUCCESS" }),
    ]);
  expect(readFileSync(journal, "utf8")).not.toContain("synthetic appended note");
});

it.each([
  { path: [] as string[], readOnly: "1", writes: "disabled" },
  { path: ["home"], readOnly: "1", writes: "disabled" },
  { path: ["setup"], readOnly: "1", writes: "disabled" },
  { path: ["home"], readOnly: "0", writes: "qux.host.tag.set" },
])("shows effective writes on $path with forced read-only=$readOnly", ({ path, readOnly, writes }) => {
  const config = join(scratch, "tagset-home.json");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
    writes: { allowWrites: true, operations: ["qux.host.tag.set"] } } } }));
  const result = invoke([...path, "--config", config], {
    SENTINEL_TOKEN: "packaged-detection-token", VECTRA_AXI_READ_ONLY: readOnly,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`writes: ${writes}`);
  expect(result.stderr).toBe("");
});

it("reads unresolved assignments, the outcome taxonomy and the assignee as distinct resources", () => {
  const config = join(scratch, "assignments.json");
  const trace = join(scratch, "assignments-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const listed = invoke(["assignment", "list", ...context, "--resolved", "false", "--limit", "1"], fixtureEnv);
  expect(listed.status).toBe(0);
  expect(listed.stderr).toBe("");
  const listOutput = decode(listed.stdout) as Record<string, unknown>;
  expect(listOutput).toMatchObject({ profile: "lab", count: "1 of 2 assignments", complete: true,
    assignments: [{ id: 11, host_id: 7, account_id: null, date_resolved: null, status: "unresolved" }],
    cursor: expect.any(String) });
  const resumed = invoke(["assignment", "list", ...context, "--resolved", "false",
    "--cursor", listOutput.cursor as string], fixtureEnv);
  expect(resumed.status).toBe(0);
  expect(resumed.stderr).toBe("");
  expect(decode(resumed.stdout)).toMatchObject({ profile: "lab", complete: true,
    assignments: [{ id: 12, host_id: null, account_id: 7,
      date_resolved: "2026-09-30T12:00:00Z", status: "resolved" }] });
  const outcomes = invoke(["assignment", "outcome", "list", ...context], fixtureEnv);
  expect(outcomes.status).toBe(0);
  expect(outcomes.stderr).toBe("");
  expect(decode(outcomes.stdout)).toMatchObject({ profile: "lab", count: "1 assignment outcomes",
    outcomes: [{ id: 1, title: "Benign True Positive", builtin: true }], complete: true });
  const outcome = invoke(["assignment", "outcome", "show", ...context, "--id", "1"], fixtureEnv);
  expect(outcome.status).toBe(0);
  expect(outcome.stderr).toBe("");
  expect(decode(outcome.stdout)).toMatchObject(
    { profile: "lab", id: 1, category: "benign_true_positive", builtin: true });
  const user = invoke(["user", "show", ...context, "--id", "3"], fixtureEnv);
  expect(user.status).toBe(0);
  expect(user.stderr).toBe("");
  expect(decode(user.stdout)).toMatchObject({ profile: "lab", id: 3, username: "soc-analyst" });
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/assignments?resolved=false&page_size=100" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/assignments?resolved=false&page=2" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/assignment_outcomes?page_size=100" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/assignment_outcomes/1" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/users/3" },
  ]);
});

it("reads groups, paged members and triage rules without implying benign verdicts", () => {
  const config = join(scratch, "groups.json");
  const trace = join(scratch, "groups-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const listed = invoke(["group", "list", ...context], fixtureEnv);
  expect(listed.status).toBe(0);
  expect(listed.stderr).toBe("");
  const listOutput = decode(listed.stdout) as Record<string, unknown>;
  expect(listOutput).toMatchObject({ profile: "lab", count: "1 groups", complete: true,
    groups: [{ id: 8, name: "synthetic-host-group", type: "host" }] });
  const memberHint = (listOutput.help as string[]).find((hint) => hint.startsWith("Run `"))!;
  const memberCommand = /^Run `vectra-axi (group member list .*?)` for paged membership$/.exec(memberHint!)![1]!;
  const memberArgs = execFileSync("sh", ["-c", `set -- ${memberCommand}; printf '%s\\n' "$@"`],
    { encoding: "utf8" }).trimEnd().split("\n");
  const members = invoke(memberArgs, fixtureEnv);
  expect(members.status).toBe(0);
  expect(members.stderr).toBe("");
  expect(decode(members.stdout)).toMatchObject({ profile: "lab", group: 8, count: "1 members",
    members: [{ id: 7, name: "synthetic-host-7" }], complete: true });
  const rule = invoke(["triage", "rule", "show", ...context, "--id", "7"], fixtureEnv);
  expect(rule.status).toBe(0);
  expect(rule.stderr).toBe("");
  const ruleOutput = decode(rule.stdout) as Record<string, unknown>;
  expect(ruleOutput).toMatchObject({ profile: "lab", id: 7, enabled: true,
    triage_category: "synthetic-triage", description: "Synthetic automation",
    detection: "synthetic-detection", is_whitelist: false,
    source_conditions: { OR: [] }, additional_conditions: null });
  expect(ruleOutput.help).toContain(
    "Rules describe triage automation; a matching rule is not evidence a detection is benign");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/groups?page_size=100" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/groups/8/members?page_size=100" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/rules/7" },
  ]);
});

it("distinguishes an empty user window from a denied assignment window", () => {
  const config = join(scratch, "assignments-empty-denied.json");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token",
    DETECTION_TRACE: join(scratch, "assignments-empty-denied-requests.jsonl"),
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const empty = invoke(["user", "list", ...context, "--username", "nobody"], fixtureEnv);
  expect(empty.status).toBe(0);
  expect(empty.stderr).toBe("");
  expect(empty.stdout).toContain("0 users found");
  expect(empty.stdout).toContain("complete: true");
  const denied = invoke(["assignment", "list", ...context, "--resolved", "true"], fixtureEnv);
  expect(denied.status).toBe(1);
  expect(denied.stderr).toBe("");
  expect(denied.stdout).toContain("code: ACCESS_DENIED");
  expect(denied.stdout).toContain("complete: false");
});

it("reads audits in a bounded inclusive window with truthful empty and denied windows", () => {
  const config = join(scratch, "audits.json");
  const trace = join(scratch, "audits-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const listed = invoke(["audit", "list", ...context, "--start-date", "2026-10-01", "--end-date", "2026-10-02"], fixtureEnv);
  expect(listed.status).toBe(0);
  expect(listed.stderr).toBe("");
  expect(decode(listed.stdout)).toMatchObject({ profile: "lab",
    window: "2026-10-01 to 2026-10-02 (inclusive UTC days)", count: "2 audits", complete: true,
    audits: [{ user: "synthetic-admin", result: "success" }, { user: "synthetic-api-client", result: "failure" }] });
  const empty = invoke(["audit", "list", ...context, "--start-date", "2026-10-03", "--end-date", "2026-10-03"], fixtureEnv);
  expect(empty.status).toBe(0);
  expect(empty.stderr).toBe("");
  expect(empty.stdout).toContain("0 audits found");
  expect(empty.stdout).toContain("complete: true");
  const denied = invoke(["audit", "list", ...context, "--start-date", "2026-10-04", "--end-date", "2026-10-04"], fixtureEnv);
  expect(denied.status).toBe(1);
  expect(denied.stderr).toBe("");
  expect(denied.stdout).toContain("code: ACCESS_DENIED");
  const unbounded = invoke(["audit", "list", ...context, "--end-date", "2026-10-02"], fixtureEnv);
  expect(unbounded.status).toBe(2);
  expect(unbounded.stderr).toBe("");
  expect(unbounded.stdout).toContain("audit list requires --start-date");
  expect(unbounded.stdout).toContain("code: VALIDATION_ERROR");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/audits?start=2026-10-01&end=2026-10-02" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/audits?start=2026-10-03&end=2026-10-03" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/audits?start=2026-10-04&end=2026-10-04" },
  ]);
});

it("reads health snapshots and checkpoint events with truthful empty and denied windows", () => {
  const config = join(scratch, "health.json");
  const trace = join(scratch, "health-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const cached = invoke(["health", "list", ...context], fixtureEnv);
  expect(cached.status).toBe(0);
  expect(cached.stderr).toBe("");
  expect(decode(cached.stdout)).toMatchObject({ profile: "lab", cached: true,
    health: { network: { status: "ok" } } });
  const fresh = invoke(["health", "list", ...context, "--fresh"], fixtureEnv);
  expect(fresh.status).toBe(0);
  expect(fresh.stderr).toBe("");
  expect(decode(fresh.stdout)).toMatchObject({ profile: "lab", cached: false });
  const shown = invoke(["health", "show", ...context, "--check", "cpu"], fixtureEnv);
  expect(shown.status).toBe(0);
  expect(shown.stderr).toBe("");
  expect(decode(shown.stdout)).toMatchObject({ profile: "lab", check: "cpu", cached: true });
  const unsupported = invoke(["health", "show", ...context, "--check", "battery"], fixtureEnv);
  expect(unsupported.status).toBe(2);
  expect(unsupported.stderr).toBe("");
  expect(unsupported.stdout).toContain("Unsupported health check");
  const events = invoke(["health", "event", "list", ...context], fixtureEnv);
  expect(events.status).toBe(0);
  expect(events.stderr).toBe("");
  expect(decode(events.stdout)).toMatchObject({ profile: "lab", checkpoint: "chk-2",
    remaining_count: 0, count: "2 health events", complete: true });
  const continued = invoke(["health", "event", "list", ...context, "--from", "chk-2"], fixtureEnv);
  expect(continued.status).toBe(0);
  expect(continued.stderr).toBe("");
  expect(continued.stdout).toContain("0 health events found");
  expect(continued.stdout).toContain("complete: true");
  const denied = invoke(["health", "event", "list", ...context, "--from", "chk-9"], fixtureEnv);
  expect(denied.status).toBe(1);
  expect(denied.stderr).toBe("");
  expect(denied.stdout).toContain("code: ACCESS_DENIED");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/health" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/health?cache=false" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/health/cpu" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/events/health" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/events/health?from=chk-2" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/events/health?from=chk-9" },
  ]);
});

it("reads host and account lockdown status without a lockdown action", () => {
  const config = join(scratch, "lockdown.json");
  const trace = join(scratch, "lockdown-requests.jsonl");
  const profile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5",
    auth: "token", tokenEnv: "SENTINEL_TOKEN" };
  writeFileSync(config, JSON.stringify({ profiles: { lab: profile,
    denied: { ...profile, origin: "https://denied.invalid" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "lab"];
  const host = invoke(["lockdown", "list", ...context, "--type", "host"], fixtureEnv);
  expect(host.status).toBe(0);
  expect(host.stderr).toBe("");
  const hostOutput = decode(host.stdout) as Record<string, unknown>;
  expect(hostOutput).toMatchObject({ profile: "lab", type: "host", count: "1 host lockdowns",
    lockdowns: [{ host_id: 7, locked_by: "synthetic-admin", unlock_date: null }], complete: true });
  expect(hostOutput.help).toContain(
    "Lockdown status only; the CLI declares no lockdown execution leaf");
  expect(hostOutput.help).toContain(
    "Host lockdown status requires the configured Microsoft Defender ATP Lockdown integration");
  const account = invoke(["lockdown", "list", ...context, "--type", "account"], fixtureEnv);
  expect(account.status).toBe(0);
  expect(account.stderr).toBe("");
  expect(decode(account.stdout)).toMatchObject({ profile: "lab", type: "account",
    count: "0 account lockdowns", complete: true });
  expect(account.stdout).toContain("0 account lockdowns found");
  const denied = invoke(["lockdown", "list", "--config", config, "--profile", "denied",
    "--type", "host"], fixtureEnv);
  expect(denied.status).toBe(1);
  expect(denied.stderr).toBe("");
  expect(denied.stdout).toContain("code: ACCESS_DENIED");
  const untyped = invoke(["lockdown", "list", ...context], fixtureEnv);
  expect(untyped.status).toBe(2);
  expect(untyped.stdout).toContain("lockdown list requires --type");
  expect(untyped.stderr).toBe("");
  const execute = invoke(["lockdown", "execute", ...context, "--type", "host", "--id", "7"], fixtureEnv);
  expect(execute.status).toBe(2);
  expect(execute.stdout).toContain("Unknown command: lockdown execute");
  expect(execute.stderr).toBe("");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/lockdown/host" },
    { method: "GET", url: "https://fixture.invalid/api/v2.5/lockdown/account" },
    { method: "GET", url: "https://denied.invalid/api/v2.5/lockdown/host" },
  ]);
});

it("checks profiles through the packaged doctor command", () => {
  const config = join(scratch, "doctor.json");
  const trace = join(scratch, "doctor-requests.jsonl");
  const profile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5",
    auth: "token", tokenEnv: "SENTINEL_TOKEN" };
  writeFileSync(config, JSON.stringify({ profiles: { lab: profile,
    denied: { ...profile, origin: "https://denied.invalid" } } }));
  const fixtureEnv = { SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const checked = invoke(["doctor", "--config", config, "--profile", "lab"], fixtureEnv);
  expect(checked.status).toBe(0);
  expect(checked.stderr).toBe("");
  expect(decode(checked.stdout)).toMatchObject({ count: "1 of 1 profiles ok", complete: true,
    profiles: [{ name: "lab", auth: "token", status: "ok", detail: "1 of 2 detections" }] });
  const refused = invoke(["doctor", "--config", config, "--profile", "denied"], fixtureEnv);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toBe("");
  expect(decode(refused.stdout)).toMatchObject({ count: "0 of 1 profiles ok", complete: false,
    profiles: [{ name: "denied", auth: "token", status: "failed", code: "ACCESS_DENIED" }] });
  const invalid = invoke(["doctor", "--config", join(scratch, "absent.json")]);
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toBe("");
  expect(invalid.stdout).toContain("code: CONFIG_INVALID");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections" },
    { method: "GET", url: "https://denied.invalid/api/v2.5/detections" },
  ]);
});

it("checks a cloud profile through the packaged doctor exchange", () => {
  const config = join(scratch, "rux-doctor.json");
  const trace = join(scratch, "rux-doctor-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { cloud: { kind: "rux", origin: "https://fixture.invalid",
    apiVersion: "3.4", auth: "oauth", clientId: "synthetic-client", secretEnv: "RUX_SECRET" } } }));
  const fixtureEnv = { RUX_SECRET: "packaged-rux-secret", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const result = invoke(["doctor", "--config", config, "--profile", "cloud"], fixtureEnv);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(decode(result.stdout)).toMatchObject({ count: "1 of 1 profiles ok", complete: true,
    profiles: [{ name: "cloud", auth: "oauth", status: "ok", detail: "OAuth exchange ok; RUX reads arrive in RUX-02" }] });
  expect(result.stdout).not.toContain("packaged-rux-secret");
  expect(result.stdout).not.toContain("packaged-rux-token");
  expect(result.stdout).not.toContain("packaged-rux-refresh");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
  ]);
});

it("reads cloud detections and entities through the packaged RUX journey", () => {
  const config = join(scratch, "rux-reads.json");
  const trace = join(scratch, "rux-reads-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { cloud: { kind: "rux", origin: "https://fixture.invalid",
    apiVersion: "3.4", auth: "oauth", clientId: "synthetic-client", secretEnv: "RUX_SECRET" } } }));
  const fixtureEnv = { RUX_SECRET: "packaged-rux-secret", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "cloud"];
  const listed = invoke(["detection", "list", ...context, "--state", "active"], fixtureEnv);
  expect(listed.status).toBe(0);
  expect(listed.stderr).toBe("");
  const listOutput = decode(listed.stdout) as Record<string, unknown>;
  expect(listOutput).toMatchObject({ profile: "cloud", count: "1 detections", complete: true,
    detections: [{ id: 1, detection_type: "synthetic-type", state: "active", threat: 71, certainty: 80 }] });
  const showHint = (listOutput.help as string[]).find((hint) => hint.startsWith("Run `"))!;
  const showCommand = /^Run `vectra-axi (detection show .*?)` for full detail$/.exec(showHint)![1]!;
  const showArgs = execFileSync("sh", ["-c", `set -- ${showCommand}; printf '%s\\n' "$@"`],
    { encoding: "utf8" }).trimEnd().split("\n");
  const shown = invoke(showArgs, fixtureEnv);
  expect(shown.status).toBe(0);
  expect(shown.stderr).toBe("");
  expect(decode(shown.stdout)).toMatchObject(
    { profile: "cloud", id: 1, description: "synthetic cloud detail" });
  const entities = invoke(["entity", "list", ...context, "--type", "host"], fixtureEnv);
  expect(entities.status).toBe(0);
  expect(entities.stderr).toBe("");
  expect(decode(entities.stdout)).toMatchObject({ profile: "cloud", type: "host", count: "1 hosts",
    entities: [{ id: 7, name: "synthetic-host-7", type: "host", urgency_score: 76, importance: 3 }] });
  expect(entities.stdout).not.toContain("packaged-rux-secret");
  expect(entities.stdout).not.toContain("packaged-rux-token");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/detections/?state=active&page_size=100" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/detections/1/" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/entities/?type=host&page_size=100" },
  ]);
});

it("reads cloud groups, members and triage rules through the packaged RUX journey", () => {
  const config = join(scratch, "rux-groups.json");
  const trace = join(scratch, "rux-groups-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { cloud: { kind: "rux", origin: "https://fixture.invalid",
    apiVersion: "3.4", auth: "oauth", clientId: "synthetic-client", secretEnv: "RUX_SECRET" } } }));
  const fixtureEnv = { RUX_SECRET: "packaged-rux-secret", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "cloud"];
  const listed = invoke(["group", "list", ...context], fixtureEnv);
  expect(listed.status).toBe(0);
  expect(listed.stderr).toBe("");
  const listOutput = decode(listed.stdout) as Record<string, unknown>;
  expect(listOutput).toMatchObject({ profile: "cloud", count: "1 groups", complete: true,
    groups: [{ id: 8, name: "synthetic-cloud-group", type: "account" }] });
  const memberHint = (listOutput.help as string[]).find((hint) => hint.startsWith("Run `"))!;
  const memberCommand = /^Run `vectra-axi (group member list .*?)` for paged membership$/.exec(memberHint)![1]!;
  const memberArgs = execFileSync("sh", ["-c", `set -- ${memberCommand}; printf '%s\\n' "$@"`],
    { encoding: "utf8" }).trimEnd().split("\n");
  const members = invoke(memberArgs, fixtureEnv);
  expect(members.status).toBe(0);
  expect(members.stderr).toBe("");
  expect(decode(members.stdout)).toMatchObject({ profile: "cloud", group: 8, count: "1 members",
    members: [{ uid: "synthetic-account@fixture.invalid" }] });
  const shown = invoke(["group", "show", ...context, "--id", "8"], fixtureEnv);
  expect(shown.status).toBe(0);
  expect(shown.stderr).toBe("");
  expect(decode(shown.stdout)).toMatchObject(
    { profile: "cloud", id: 8, type: "account", member_count: 1 });
  const rules = invoke(["triage", "rule", "list", ...context], fixtureEnv);
  expect(rules.status).toBe(0);
  expect(rules.stderr).toBe("");
  expect(decode(rules.stdout)).toMatchObject({ profile: "cloud", count: "1 triage rules",
    rules: [{ id: 7, enabled: true, triage_category: "synthetic-triage" }] });
  const ruleShown = invoke(["triage", "rule", "show", ...context, "--id", "7"], fixtureEnv);
  expect(ruleShown.status).toBe(0);
  expect(ruleShown.stderr).toBe("");
  expect(decode(ruleShown.stdout)).toMatchObject(
    { profile: "cloud", id: 7, detection: "synthetic-detection", is_whitelist: false });
  expect(ruleShown.stdout).not.toContain("packaged-rux-secret");
  expect(ruleShown.stdout).not.toContain("packaged-rux-token");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/groups/?include_members=false&page_size=100" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/groups/8/members/?page_size=100" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/groups/8/?include_members=false" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/rules/?page_size=100" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/rules/7/" },
  ]);
});

it("shows a packaged cloud profile without a credential exchange", () => {
  const config = join(scratch, "rux-home.json");
  writeFileSync(config, JSON.stringify({ profiles: { cloud: { kind: "rux", origin: "https://fixture.invalid",
    apiVersion: "3.4", auth: "oauth", clientId: "synthetic-client", secretEnv: "UNSET_RUX_SECRET" } } }));
  const result = invoke(["home", "--config", config]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("kind: rux");
  expect(result.stdout).toContain("auth: oauth");
  expect(result.stdout).toContain("writes: disabled");
  expect(result.stdout).not.toContain("synthetic-client");
  expect(result.stderr).toBe("");
});

it("forwards inline descending ordering through the packaged list command", () => {
  const config = join(scratch, "ordering.json");
  const trace = join(scratch, "ordering-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const result = invoke(["detection", "list", "--config", config, "--profile", "lab", "--ordering=-id"], {
    SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}`,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(decode(result.stdout)).toMatchObject({ profile: "lab", complete: true,
    detections: [{ id: 2 }, { id: 1 }] });
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections?ordering=-id" },
  ]);
});

it.each([
  ["empty", 0, "0 detections found with state empty", "complete: true"],
  ["denied", 1, "code: ACCESS_DENIED", "complete: false"],
  ["malformed", 1, "code: RESPONSE_INVALID", "complete: false"],
] as const)("reports a packaged %s window with its exit status", (state, status, message, complete) => {
  const config = join(scratch, `detection-${state}.json`);
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const result = invoke(["detection", "list", "--config", config, "--profile", "lab", "--state", state], {
    SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: join(scratch, `requests-${state}.jsonl`),
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}`,
  });
  expect(result.status).toBe(status);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("profile: lab");
  expect(result.stdout).toContain(message);
  expect(result.stdout).toContain(complete);
});

it.each(["-v", "-V", "--version"])("prints only the package version for %s", (flag) => {
  const result = invoke([flag]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${version}\n`);
  expect(result.stderr).toBe("");
});

it("shows a packaged token profile without emitting or resolving its secret", () => {
  const config = join(scratch, "profile.json");
  const sentinel = "fake-secret-packaged-SENTINEL";
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN", applianceRelease: "9.4" } } }));
  const result = invoke(["home", "--config", config], { SENTINEL_TOKEN: sentinel });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("state: configured");
  expect(result.stdout).toContain("name: lab");
  expect(result.stdout).toContain("writes: disabled");
  expect(result.stdout).not.toContain(sentinel);
  expect(result.stderr).toBe("");
});

it("reports packaged ambiguous-profile guidance", () => {
  const config = join(scratch, "ambiguous.json");
  const profile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" };
  writeFileSync(config, JSON.stringify({ profiles: { one: profile, two: profile } }));
  const result = invoke(["--config", config]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("code: PROFILE_AMBIGUOUS");
  expect(result.stdout).toContain("Pass --profile <name>");
  expect(result.stderr).toBe("");
});

it("shows a packaged OAuth profile with no credential exchange or secret required", () => {
  const config = join(scratch, "oauth.json");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "oauth", clientId: "synthetic-client", secretEnv: "UNSET_OAUTH_SECRET" } } }));
  const result = invoke(["home", "--config", config]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("state: configured");
  expect(result.stdout).toContain("auth: oauth");
  expect(result.stdout).toContain("writes: disabled");
  expect(result.stdout).not.toContain("synthetic-client");
  expect(result.stderr).toBe("");
});

it("scrubs known secrets from packaged profile output", () => {
  const config = join(scratch, "redaction.json");
  const sentinel = "fake-secret-profile-SENTINEL";
  writeFileSync(config, JSON.stringify({ profiles: { [sentinel]: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN", applianceRelease: sentinel } } }));
  const result = invoke(["setup", "--config", config], { SENTINEL_TOKEN: sentinel });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("***redacted***");
  expect(result.stdout).not.toContain(sentinel);
  expect(result.stderr).toBe("");
});

it("ignores repository-local credentials unless explicitly selected", () => {
  const local = join(home, "vectra-axi.config.json");
  writeFileSync(local, "malformed fake credential config");
  try {
    const result = invoke([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("state: unconfigured");
    expect(result.stderr).toBe("");
  } finally { rmSync(local); }
});

it("keeps help offline even with an invalid explicit config", () => {
  const result = invoke(["setup", "--help", "--config", join(scratch, "absent.json")]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"--config <path>"');
  expect(result.stderr).toBe("");
});

it("shows unconfigured state with closed stdin and a clean home", () => {
  const result = invoke([]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("bin:");
  expect(result.stdout).toContain("vectra-axi.js");
  expect(result.stdout).toContain("state: unconfigured\nprofiles: 0");
  expect(result.stdout).toContain("See README.md for shipped operations and write restrictions");
  expect(result.stderr).toBe("");
  expect(readdirSync(home)).toEqual([]);
});

it.each([{ path: [] as string[], leaf: false }, { path: ["home"], leaf: true }, { path: ["setup"], leaf: true }])(
    "provides offline help for $path", ({ path, leaf }) => {
  const result = invoke([...path, "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("examples[");
  expect(result.stdout).toContain('"--help": Show concise help; default false');
  expect(result.stdout).toContain('"--profile <name>": "Select a profile by name');
  expect(result.stdout).toContain("--help cannot be combined with --profile");
  if (leaf) expect(result.stdout).not.toContain("detection list");
  else expect(result.stdout).toContain("detection list");
  expect(result.stderr).toBe("");
});

it.each([
  { path: ["detection", "list"], flag: '"--state <state>"' },
  { path: ["detection", "show"], flag: '"--id <id>"' },
  { path: ["host", "list"], flag: '"--threat-gte <score>"' },
  { path: ["entity", "show"], flag: '"--type <kind>"' },
  { path: ["detection", "note", "list"], flag: '"--id <id>"' },
  { path: ["host", "tag", "list"], flag: '"--id <id>"' },
  { path: ["assignment", "list"], flag: '"--resolved <bool>"' },
  { path: ["assignment", "outcome", "list"], flag: '"--limit <rows>"' },
  { path: ["assignment", "outcome", "show"], flag: '"--id <id>"' },
  { path: ["user", "list"], flag: '"--username <name>"' },
  { path: ["user", "show"], flag: '"--id <id>"' },
  { path: ["group", "list"], flag: '"--type <kind>"' },
  { path: ["group", "show"], flag: '"--id <id>"' },
  { path: ["group", "member", "list"], flag: '"--is-key-asset <bool>"' },
  { path: ["triage", "rule", "list"], flag: '"--contains <text>"' },
  { path: ["triage", "rule", "show"], flag: '"--id <id>"' },
  { path: ["lockdown", "list"], flag: '"--type <kind>"' },
  { path: ["doctor"], flag: '"--profile <name>"' },
])("provides offline help for $path", ({ path, flag }) => {
  const result = invoke([...path, "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("examples[");
  expect(result.stdout).toContain(flag);
  expect(result.stdout).toContain('"--profile <name>"');
  expect(result.stdout).toContain("--help cannot be combined with --profile");
  expect(result.stderr).toBe("");
});

it.each([
  ["list help with an invalid explicit config", ["detection", "list", "--help", "--config", join(scratch, "absent.json")]],
  ["show help with an invalid explicit config", ["detection", "show", "--help", "--config", join(scratch, "absent.json")]],
  ["list help with invalid fields", ["detection", "list", "--help", "--fields", "score"]],
  ["show help with an invalid ID", ["detection", "show", "--help", "--id", "nope"]],
  ["entity list help with an invalid explicit config", ["entity", "list", "--help", "--config", join(scratch, "absent.json")]],
  ["entity show help with an invalid ID", ["entity", "show", "--help", "--id", "nope"]],
  ["note list help with an invalid explicit config", ["detection", "note", "list", "--help", "--config", join(scratch, "absent.json")]],
  ["tag list help with an invalid ID", ["host", "tag", "list", "--help", "--id", "nope"]],
  ["doctor help with an invalid explicit config", ["doctor", "--help", "--config", join(scratch, "absent.json")]],
])("keeps %s offline", (_name, args) => {
  const result = invoke(args);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("examples[");
  expect(result.stderr).toBe("");
});

it("reports a missing profile for detection reads as a runtime error on stdout", () => {
  const result = invoke(["detection", "list", "--state", "active"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("code: PROFILE_REQUIRED");
  expect(result.stderr).toBe("");
});

it.each([
  { args: ["host", "show"], message: "host show requires --id" },
  { args: ["account", "show", "--id", "0"], message: "--id must be a positive integer" },
  { args: ["entity", "list"], message: "entity reads require --type" },
  { args: ["entity", "list", "--type", "host", "--threat-gte", "high"], message: "--threat-gte must be a number" },
  { args: ["entity", "show", "--type", "host"], message: "entity show requires --id" },
  { args: ["assignment", "list", "--resolved", "maybe"], message: "--resolved must be true or false" },
  { args: ["assignment", "list", "--account", "1.5"], message: "--account must be a non-negative integer" },
  { args: ["assignment", "list", "--fields", "urgency"], message: "Unknown --fields value: urgency" },
  { args: ["assignment", "outcome", "list", "--fields", "score"], message: "Unknown --fields value: score" },
  { args: ["assignment", "outcome", "show"], message: "assignment outcome show requires --id" },
  { args: ["assignment", "outcome", "show", "--id", "0"], message: "--id must be a positive integer" },
  { args: ["user", "list", "--fields", "role"], message: "Unknown --fields value: role" },
  { args: ["user", "show"], message: "user show requires --id" },
  { args: ["user", "show", "--id", "1.5"], message: "--id must be a positive integer" },
  { args: ["host", "list", "--fields", "urgency"], message: "Unknown --fields value: urgency" },
  { args: ["entity", "list", "--type", "host", "--fields", "state"], message: "Unknown --fields value: state" },
  { args: ["detection", "show", "--id", "0"], message: "--id must be a positive integer" },
  { args: ["detection", "show", "--id", "1.5"], message: "--id must be a positive integer" },
  { args: ["detection", "list", "--host-id", "1.5"], message: "--host-id must be a non-negative integer" },
  { args: ["detection", "list", "--min-id", "1.5"], message: "--min-id must be a non-negative integer" },
  { args: ["detection", "list", "--max-id", "1.5"], message: "--max-id must be a non-negative integer" },
  { args: ["detection", "list", "--certainty-gte", "high"], message: "--certainty-gte must be a number" },
  { args: ["detection", "list", "--threat-gte", "high"], message: "--threat-gte must be a number" },
  { args: ["detection", "list", "--limit", "0"], message: "--limit must be a positive integer" },
  { args: ["detection", "list", "--fields", "score"], message: "Unknown --fields value: score" },
  { args: ["detection", "list", "--fields", ","], message: "Unknown --fields value: (empty)" },
  { args: ["detection", "list", "--cursor", "opaque", "--fields", "score"], message: "Unknown --fields value: score" },
  { args: ["detection", "note", "list"], message: "detection note list requires --id" },
  { args: ["detection", "note", "list", "--id", "0"], message: "--id must be a positive integer" },
  { args: ["host", "tag", "list", "--id", "1.5"], message: "--id must be a positive integer" },
  { args: ["account", "note", "list", "--id", "7", "--limit", "5"], message: "Unknown flag: --limit" },
  { args: ["lockdown", "list"], message: "lockdown list requires --type" },
  { args: ["lockdown", "list", "--type", "sensor"], message: "--type must be one of" },
].flatMap(({ args, message }) => [
  { context: "unconfigured", args, message },
  { context: "unreadable config", args: [...args, "--config", join(scratch, "absent.json")], message },
]))("validates $args before $context selection", ({ args, message }) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("");
  const output = decode(result.stdout) as Record<string, unknown>;
  expect(output).toMatchObject({ code: "VALIDATION_ERROR", error: expect.stringContaining(message) });
});

it.each([
  ["unknown host flag", ["host", "list", "--state", "active"], "Unknown flag: --state"],
  ["facade range flag", ["entity", "list", "--type", "host", "--min-id", "1"], "Unknown flag: --min-id"],
  ["unknown detection leaf", ["detection", "note"], "Unknown command: detection note"],
  ["unknown note verb", ["detection", "note", "show", "--id", "7"], "Unknown command: detection note show"],
  ["bare detection group", ["detection"], "Unknown command: detection"],
  ["unknown list flag", ["detection", "list", "--stat", "active"], "Unknown flag: --stat"],
  ["unknown show flag", ["detection", "show", "--id", "7", "--limit", "5"], "Unknown flag: --limit"],
  ["unknown doctor flag", ["doctor", "--limit", "1"], "Unknown flag: --limit"],
  ["unknown assignment flag", ["assignment", "list", "--state", "active"], "Unknown flag: --state"],
  ["unknown outcome leaf", ["assignment", "outcome", "delete"], "Unknown command: assignment outcome delete"],
  ["bare assignment outcome group", ["assignment", "outcome"], "Unknown command: assignment outcome"],
  ["lockdown execution leaf", ["lockdown", "execute", "--type", "host"], "Unknown command: lockdown execute"],
  ["bare lockdown group", ["lockdown"], "Unknown command: lockdown"],
])("rejects %s before any profile or network work", (_name, args, message) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain(message);
  expect(result.stdout).toContain("code: VALIDATION_ERROR");
  expect(result.stderr).toBe("");
});

it("reports a missing profile as a runtime error on stdout", () => {
  const result = invoke(["home", "--profile", "lab"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("code: PROFILE_REQUIRED");
  expect(result.stdout).toContain("Run vectra-axi setup");
  expect(result.stderr).toBe("");
});

it.each([
  ["unknown flag", ["home", "--profil", "lab"], "Unknown flag: --profil"],
  ["unknown flag beside help", ["setup", "--help", "--typo"], "Unknown flag: --typo"],
  ["missing selector value", ["home", "--profile"], "requires a non-empty value"],
  ["missing ordering before another flag", ["detection", "list", "--ordering", "--limit", "1"], "--ordering requires a non-empty value"],
  ["empty inline ordering", ["detection", "list", "--ordering="], "--ordering requires a non-empty value"],
  ["duplicate selector", ["home", "--profile=lab", "--profile=other"], "Repeated flag"],
  ["boolean value", ["setup", "--help=false"], "does not accept a value"],
  ["positional input", ["setup", "extra"], "Unexpected argument"],
  ["literal help", ["setup", "--", "--help"], "Unknown flag: --"],
  ["planned endpoint", ["lockdown", "show"], "Unknown command: lockdown show"],
  ["prototype command", ["constructor"], "Unknown command: constructor"],
  ["version combination", ["--version", "--help"], "Unknown flag: --version"],
  ["unknown flag before profile", ["home", "--typo", "--profile=lab"], "Unknown flag: --typo"],
])("rejects %s before any profile or network work", (_name, args, message) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain(message);
  expect(result.stdout).toContain("code: VALIDATION_ERROR");
  expect(result.stdout).toContain("--help");
  expect(result.stderr).toBe("");
});

it.each([
  ["--help", "--profile=lab"],
  ["--profile=lab", "--help"],
  ["--help", "--profile", "lab"],
  ["--profile", "lab", "--help"],
  ["home", "--help", "--profile=lab"],
  ["home", "--profile=lab", "--help"],
  ["home", "--help", "--profile", "lab"],
  ["home", "--profile", "lab", "--help"],
  ["setup", "--help", "--profile=lab"],
  ["setup", "--profile=lab", "--help"],
  ["setup", "--help", "--profile", "lab"],
  ["setup", "--profile", "lab", "--help"],
].map((args) => ({ args })))("rejects mutually exclusive flags for $args", ({ args }) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain("--help cannot be combined with --profile");
  expect(result.stdout).toContain("code: VALIDATION_ERROR");
  expect(result.stderr).toBe("");
});

it.each([
  { args: ["update"] },
  { args: ["update", "--help"] },
  { args: ["update", "--profile=lab"] },
])("rejects $args in the catalogue before SDK dispatch", ({ args }) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain("Unknown command: update");
  expect(result.stdout).toContain("code: VALIDATION_ERROR");
  expect(result.stdout).toContain("Available commands: home, setup, doctor, detection list, detection show, host list, host show, account list, account show, entity list, entity show, detection note list, detection tag list, detection tag set, detection note add, host note list, host tag list, host tag set, host note add, account note list, account tag list, account tag set, account note add, assignment list, assignment outcome list, assignment outcome show, user list, user show, audit list, group list, group show, group member list, triage rule list, triage rule show, health list, health show, health event list");
  expect(result.stdout).toContain("lockdown list");
  expect(result.stderr).toBe("");
  expect(readdirSync(home)).toEqual([]);
});

it("answers version without loading the command graph", () => {
  const graph = join(unpacked, "dist/src/cli.js");
  renameSync(graph, `${graph}.disabled`);
  try {
    const result = invoke(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
    expect(result.stderr).toBe("");
  } finally {
    renameSync(`${graph}.disabled`, graph);
  }
});

it("keeps version latency near the Node startup floor", () => {
  const elapsed = (args: string[]) => {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { env, encoding: "utf8", input: "", timeout: 5_000 });
    expect(result.status).toBe(0);
    return performance.now() - start;
  };
  const floor = Math.min(...Array.from({ length: 5 }, () => elapsed(["-e", "console.log(1)"])));
  const version = Math.min(...Array.from({ length: 5 }, () => elapsed([bin, "--version"])));
  expect(version).toBeLessThan(floor * 3);
});

it("reads cloud health and lockdown status through the packaged RUX journey", () => {
  const config = join(scratch, "rux-health.json");
  const trace = join(scratch, "rux-health-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { cloud: { kind: "rux", origin: "https://fixture.invalid",
    apiVersion: "3.4", auth: "oauth", clientId: "synthetic-client", secretEnv: "RUX_SECRET" } } }));
  const fixtureEnv = { RUX_SECRET: "packaged-rux-secret", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}` };
  const context = ["--config", config, "--profile", "cloud"];
  const listed = invoke(["health", "list", ...context], fixtureEnv);
  expect(listed.status).toBe(0);
  expect(listed.stderr).toBe("");
  expect(decode(listed.stdout)).toMatchObject({ profile: "cloud", cached: true,
    health: { network: { status: "ok" } } });
  const shown = invoke(["health", "show", ...context, "--check", "cpu"], fixtureEnv);
  expect(shown.status).toBe(0);
  expect(shown.stderr).toBe("");
  expect(decode(shown.stdout)).toMatchObject({ profile: "cloud", check: "cpu",
    health: { cpu: { status: "ok" } } });
  const events = invoke(["health", "event", "list", ...context], fixtureEnv);
  expect(events.status).toBe(0);
  expect(events.stderr).toBe("");
  expect(decode(events.stdout)).toMatchObject({ profile: "cloud", checkpoint: "102",
    count: "2 health events", complete: true });
  const continued = invoke(["health", "event", "list", ...context, "--from", "102"], fixtureEnv);
  expect(continued.status).toBe(0);
  expect(continued.stderr).toBe("");
  expect(decode(continued.stdout)).toMatchObject({ count: "0 health events", complete: true });
  const host = invoke(["lockdown", "list", ...context, "--type", "host"], fixtureEnv);
  expect(host.status).toBe(0);
  expect(host.stderr).toBe("");
  expect(decode(host.stdout)).toMatchObject({ profile: "cloud", type: "host",
    count: "1 host lockdowns", complete: true });
  const account = invoke(["lockdown", "list", ...context, "--type", "account"], fixtureEnv);
  expect(account.status).toBe(0);
  expect(account.stderr).toBe("");
  expect(decode(account.stdout)).toMatchObject({ profile: "cloud", type: "account",
    count: "0 account lockdowns", complete: true });
  expect(account.stdout).not.toContain("packaged-rux-secret");
  expect(account.stdout).not.toContain("packaged-rux-token");
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/health/" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/health/cpu/" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/events/health/" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/events/health/?from=102" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/lockdown/?type=host" },
    { method: "POST", url: "https://fixture.invalid/oauth2/token" },
    { method: "GET", url: "https://fixture.invalid/api/v3.4/lockdown/?type=account" },
  ]);
});

it("shows a packaged cloud profile without a credential exchange", () => {
  const config = join(scratch, "rux-home.json");
  writeFileSync(config, JSON.stringify({ profiles: { cloud: { kind: "rux", origin: "https://fixture.invalid",
    apiVersion: "3.4", auth: "oauth", clientId: "synthetic-client", secretEnv: "UNSET_RUX_SECRET" } } }));
  const result = invoke(["home", "--config", config]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("kind: rux");
  expect(result.stdout).toContain("auth: oauth");
  expect(result.stdout).toContain("writes: disabled");
  expect(result.stdout).not.toContain("synthetic-client");
  expect(result.stderr).toBe("");
});

it("forwards inline descending ordering through the packaged list command", () => {
  const config = join(scratch, "ordering.json");
  const trace = join(scratch, "ordering-requests.jsonl");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const result = invoke(["detection", "list", "--config", config, "--profile", "lab", "--ordering=-id"], {
    SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}`,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(decode(result.stdout)).toMatchObject({ profile: "lab", complete: true,
    detections: [{ id: 2 }, { id: 1 }] });
  expect(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { method: "GET", url: "https://fixture.invalid/api/v2.5/detections?ordering=-id" },
  ]);
});

it.each([
  ["empty", 0, "0 detections found with state empty", "complete: true"],
  ["denied", 1, "code: ACCESS_DENIED", "complete: false"],
  ["malformed", 1, "code: RESPONSE_INVALID", "complete: false"],
] as const)("reports a packaged %s window with its exit status", (state, status, message, complete) => {
  const config = join(scratch, `detection-${state}.json`);
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" } } }));
  const result = invoke(["detection", "list", "--config", config, "--profile", "lab", "--state", state], {
    SENTINEL_TOKEN: "packaged-detection-token", DETECTION_TRACE: join(scratch, `requests-${state}.jsonl`),
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(join(root, "dist/test/detection-transport.js")).href}`,
  });
  expect(result.status).toBe(status);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("profile: lab");
  expect(result.stdout).toContain(message);
  expect(result.stdout).toContain(complete);
});

it.each(["-v", "-V", "--version"])("prints only the package version for %s", (flag) => {
  const result = invoke([flag]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${version}\n`);
  expect(result.stderr).toBe("");
});

it("shows a packaged token profile without emitting or resolving its secret", () => {
  const config = join(scratch, "profile.json");
  const sentinel = "fake-secret-packaged-SENTINEL";
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN", applianceRelease: "9.4" } } }));
  const result = invoke(["home", "--config", config], { SENTINEL_TOKEN: sentinel });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("state: configured");
  expect(result.stdout).toContain("name: lab");
  expect(result.stdout).toContain("writes: disabled");
  expect(result.stdout).not.toContain(sentinel);
  expect(result.stderr).toBe("");
});

it("reports packaged ambiguous-profile guidance", () => {
  const config = join(scratch, "ambiguous.json");
  const profile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN" };
  writeFileSync(config, JSON.stringify({ profiles: { one: profile, two: profile } }));
  const result = invoke(["--config", config]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("code: PROFILE_AMBIGUOUS");
  expect(result.stdout).toContain("Pass --profile <name>");
  expect(result.stderr).toBe("");
});

it("shows a packaged OAuth profile with no credential exchange or secret required", () => {
  const config = join(scratch, "oauth.json");
  writeFileSync(config, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "oauth", clientId: "synthetic-client", secretEnv: "UNSET_OAUTH_SECRET" } } }));
  const result = invoke(["home", "--config", config]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("state: configured");
  expect(result.stdout).toContain("auth: oauth");
  expect(result.stdout).toContain("writes: disabled");
  expect(result.stdout).not.toContain("synthetic-client");
  expect(result.stderr).toBe("");
});

it("scrubs known secrets from packaged profile output", () => {
  const config = join(scratch, "redaction.json");
  const sentinel = "fake-secret-profile-SENTINEL";
  writeFileSync(config, JSON.stringify({ profiles: { [sentinel]: { kind: "qux", origin: "https://fixture.invalid",
    apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN", applianceRelease: sentinel } } }));
  const result = invoke(["setup", "--config", config], { SENTINEL_TOKEN: sentinel });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("***redacted***");
  expect(result.stdout).not.toContain(sentinel);
  expect(result.stderr).toBe("");
});

it("ignores repository-local credentials unless explicitly selected", () => {
  const local = join(home, "vectra-axi.config.json");
  writeFileSync(local, "malformed fake credential config");
  try {
    const result = invoke([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("state: unconfigured");
    expect(result.stderr).toBe("");
  } finally { rmSync(local); }
});

it("keeps help offline even with an invalid explicit config", () => {
  const result = invoke(["setup", "--help", "--config", join(scratch, "absent.json")]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"--config <path>"');
  expect(result.stderr).toBe("");
});

it("shows unconfigured state with closed stdin and a clean home", () => {
  const result = invoke([]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("bin:");
  expect(result.stdout).toContain("vectra-axi.js");
  expect(result.stdout).toContain("state: unconfigured\nprofiles: 0");
  expect(result.stdout).toContain("detection, host, account, type-qualified entity, note, tag, assignment, outcome, user, group, member, triage rule, audit, health and lockdown reads");
  expect(result.stderr).toBe("");
  expect(readdirSync(home)).toEqual([]);
});

it.each([{ path: [] as string[], leaf: false }, { path: ["home"], leaf: true }, { path: ["setup"], leaf: true }])(
    "provides offline help for $path", ({ path, leaf }) => {
  const result = invoke([...path, "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("examples[");
  expect(result.stdout).toContain('"--help": Show concise help; default false');
  expect(result.stdout).toContain('"--profile <name>": "Select a profile by name');
  expect(result.stdout).toContain("--help cannot be combined with --profile");
  if (leaf) expect(result.stdout).not.toContain("detection list");
  else expect(result.stdout).toContain("detection list");
  expect(result.stderr).toBe("");
});

it.each([
  { path: ["detection", "list"], flag: '"--state <state>"' },
  { path: ["detection", "show"], flag: '"--id <id>"' },
  { path: ["host", "list"], flag: '"--threat-gte <score>"' },
  { path: ["entity", "show"], flag: '"--type <kind>"' },
  { path: ["detection", "note", "list"], flag: '"--id <id>"' },
  { path: ["host", "tag", "list"], flag: '"--id <id>"' },
  { path: ["assignment", "list"], flag: '"--resolved <bool>"' },
  { path: ["assignment", "outcome", "list"], flag: '"--limit <rows>"' },
  { path: ["assignment", "outcome", "show"], flag: '"--id <id>"' },
  { path: ["user", "list"], flag: '"--username <name>"' },
  { path: ["user", "show"], flag: '"--id <id>"' },
  { path: ["group", "list"], flag: '"--type <kind>"' },
  { path: ["group", "show"], flag: '"--id <id>"' },
  { path: ["group", "member", "list"], flag: '"--is-key-asset <bool>"' },
  { path: ["triage", "rule", "list"], flag: '"--contains <text>"' },
  { path: ["triage", "rule", "show"], flag: '"--id <id>"' },
  { path: ["lockdown", "list"], flag: '"--type <kind>"' },
  { path: ["doctor"], flag: '"--profile <name>"' },
])("provides offline help for $path", ({ path, flag }) => {
  const result = invoke([...path, "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("examples[");
  expect(result.stdout).toContain(flag);
  expect(result.stdout).toContain('"--profile <name>"');
  expect(result.stdout).toContain("--help cannot be combined with --profile");
  expect(result.stderr).toBe("");
});

it.each([
  ["list help with an invalid explicit config", ["detection", "list", "--help", "--config", join(scratch, "absent.json")]],
  ["show help with an invalid explicit config", ["detection", "show", "--help", "--config", join(scratch, "absent.json")]],
  ["list help with invalid fields", ["detection", "list", "--help", "--fields", "score"]],
  ["show help with an invalid ID", ["detection", "show", "--help", "--id", "nope"]],
  ["entity list help with an invalid explicit config", ["entity", "list", "--help", "--config", join(scratch, "absent.json")]],
  ["entity show help with an invalid ID", ["entity", "show", "--help", "--id", "nope"]],
  ["note list help with an invalid explicit config", ["detection", "note", "list", "--help", "--config", join(scratch, "absent.json")]],
  ["tag list help with an invalid ID", ["host", "tag", "list", "--help", "--id", "nope"]],
  ["doctor help with an invalid explicit config", ["doctor", "--help", "--config", join(scratch, "absent.json")]],
])("keeps %s offline", (_name, args) => {
  const result = invoke(args);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("examples[");
  expect(result.stderr).toBe("");
});

it("reports a missing profile for detection reads as a runtime error on stdout", () => {
  const result = invoke(["detection", "list", "--state", "active"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("code: PROFILE_REQUIRED");
  expect(result.stderr).toBe("");
});

it.each([
  { args: ["host", "show"], message: "host show requires --id" },
  { args: ["account", "show", "--id", "0"], message: "--id must be a positive integer" },
  { args: ["entity", "list"], message: "entity reads require --type" },
  { args: ["entity", "list", "--type", "host", "--threat-gte", "high"], message: "--threat-gte must be a number" },
  { args: ["entity", "show", "--type", "host"], message: "entity show requires --id" },
  { args: ["assignment", "list", "--resolved", "maybe"], message: "--resolved must be true or false" },
  { args: ["assignment", "list", "--account", "1.5"], message: "--account must be a non-negative integer" },
  { args: ["assignment", "list", "--fields", "urgency"], message: "Unknown --fields value: urgency" },
  { args: ["assignment", "outcome", "list", "--fields", "score"], message: "Unknown --fields value: score" },
  { args: ["assignment", "outcome", "show"], message: "assignment outcome show requires --id" },
  { args: ["assignment", "outcome", "show", "--id", "0"], message: "--id must be a positive integer" },
  { args: ["user", "list", "--fields", "role"], message: "Unknown --fields value: role" },
  { args: ["user", "show"], message: "user show requires --id" },
  { args: ["user", "show", "--id", "1.5"], message: "--id must be a positive integer" },
  { args: ["host", "list", "--fields", "urgency"], message: "Unknown --fields value: urgency" },
  { args: ["entity", "list", "--type", "host", "--fields", "state"], message: "Unknown --fields value: state" },
  { args: ["detection", "show", "--id", "0"], message: "--id must be a positive integer" },
  { args: ["detection", "show", "--id", "1.5"], message: "--id must be a positive integer" },
  { args: ["detection", "list", "--host-id", "1.5"], message: "--host-id must be a non-negative integer" },
  { args: ["detection", "list", "--min-id", "1.5"], message: "--min-id must be a non-negative integer" },
  { args: ["detection", "list", "--max-id", "1.5"], message: "--max-id must be a non-negative integer" },
  { args: ["detection", "list", "--certainty-gte", "high"], message: "--certainty-gte must be a number" },
  { args: ["detection", "list", "--threat-gte", "high"], message: "--threat-gte must be a number" },
  { args: ["detection", "list", "--limit", "0"], message: "--limit must be a positive integer" },
  { args: ["detection", "list", "--fields", "score"], message: "Unknown --fields value: score" },
  { args: ["detection", "list", "--fields", ","], message: "Unknown --fields value: (empty)" },
  { args: ["detection", "list", "--cursor", "opaque", "--fields", "score"], message: "Unknown --fields value: score" },
  { args: ["detection", "note", "list"], message: "detection note list requires --id" },
  { args: ["detection", "note", "list", "--id", "0"], message: "--id must be a positive integer" },
  { args: ["host", "tag", "list", "--id", "1.5"], message: "--id must be a positive integer" },
  { args: ["account", "note", "list", "--id", "7", "--limit", "5"], message: "Unknown flag: --limit" },
  { args: ["lockdown", "list"], message: "lockdown list requires --type" },
  { args: ["lockdown", "list", "--type", "sensor"], message: "--type must be one of" },
].flatMap(({ args, message }) => [
  { context: "unconfigured", args, message },
  { context: "unreadable config", args: [...args, "--config", join(scratch, "absent.json")], message },
]))("validates $args before $context selection", ({ args, message }) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("");
  const output = decode(result.stdout) as Record<string, unknown>;
  expect(output).toMatchObject({ code: "VALIDATION_ERROR", error: expect.stringContaining(message) });
});

it.each([
  ["unknown host flag", ["host", "list", "--state", "active"], "Unknown flag: --state"],
  ["facade range flag", ["entity", "list", "--type", "host", "--min-id", "1"], "Unknown flag: --min-id"],
  ["unknown detection leaf", ["detection", "note"], "Unknown command: detection note"],
  ["unknown note verb", ["detection", "note", "show", "--id", "7"], "Unknown command: detection note show"],
  ["bare detection group", ["detection"], "Unknown command: detection"],
  ["unknown list flag", ["detection", "list", "--stat", "active"], "Unknown flag: --stat"],
  ["unknown show flag", ["detection", "show", "--id", "7", "--limit", "5"], "Unknown flag: --limit"],
  ["unknown doctor flag", ["doctor", "--limit", "1"], "Unknown flag: --limit"],
  ["unknown assignment flag", ["assignment", "list", "--state", "active"], "Unknown flag: --state"],
  ["unknown outcome leaf", ["assignment", "outcome", "delete"], "Unknown command: assignment outcome delete"],
  ["bare assignment outcome group", ["assignment", "outcome"], "Unknown command: assignment outcome"],
  ["lockdown execution leaf", ["lockdown", "execute", "--type", "host"], "Unknown command: lockdown execute"],
  ["bare lockdown group", ["lockdown"], "Unknown command: lockdown"],
])("rejects %s before any profile or network work", (_name, args, message) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain(message);
  expect(result.stdout).toContain("code: VALIDATION_ERROR");
  expect(result.stderr).toBe("");
});

it("reports a missing profile as a runtime error on stdout", () => {
  const result = invoke(["home", "--profile", "lab"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("code: PROFILE_REQUIRED");
  expect(result.stdout).toContain("Run vectra-axi setup");
  expect(result.stderr).toBe("");
});

it.each([
  ["unknown flag", ["home", "--profil", "lab"], "Unknown flag: --profil"],
  ["unknown flag beside help", ["setup", "--help", "--typo"], "Unknown flag: --typo"],
  ["missing selector value", ["home", "--profile"], "requires a non-empty value"],
  ["missing ordering before another flag", ["detection", "list", "--ordering", "--limit", "1"], "--ordering requires a non-empty value"],
  ["empty inline ordering", ["detection", "list", "--ordering="], "--ordering requires a non-empty value"],
  ["duplicate selector", ["home", "--profile=lab", "--profile=other"], "Repeated flag"],
  ["boolean value", ["setup", "--help=false"], "does not accept a value"],
  ["positional input", ["setup", "extra"], "Unexpected argument"],
  ["literal help", ["setup", "--", "--help"], "Unknown flag: --"],
  ["planned endpoint", ["lockdown", "show"], "Unknown command: lockdown show"],
  ["prototype command", ["constructor"], "Unknown command: constructor"],
  ["version combination", ["--version", "--help"], "Unknown flag: --version"],
  ["unknown flag before profile", ["home", "--typo", "--profile=lab"], "Unknown flag: --typo"],
])("rejects %s before any profile or network work", (_name, args, message) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain(message);
  expect(result.stdout).toContain("code: VALIDATION_ERROR");
  expect(result.stdout).toContain("--help");
  expect(result.stderr).toBe("");
});

it.each([
  ["--help", "--profile=lab"],
  ["--profile=lab", "--help"],
  ["--help", "--profile", "lab"],
  ["--profile", "lab", "--help"],
  ["home", "--help", "--profile=lab"],
  ["home", "--profile=lab", "--help"],
  ["home", "--help", "--profile", "lab"],
  ["home", "--profile", "lab", "--help"],
  ["setup", "--help", "--profile=lab"],
  ["setup", "--profile=lab", "--help"],
  ["setup", "--help", "--profile", "lab"],
  ["setup", "--profile", "lab", "--help"],
].map((args) => ({ args })))("rejects mutually exclusive flags for $args", ({ args }) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain("--help cannot be combined with --profile");
  expect(result.stdout).toContain("code: VALIDATION_ERROR");
  expect(result.stderr).toBe("");
});

it.each([
  { args: ["update"] },
  { args: ["update", "--help"] },
  { args: ["update", "--profile=lab"] },
])("rejects $args in the catalogue before SDK dispatch", ({ args }) => {
  const result = invoke(args);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain("Unknown command: update");
  expect(result.stdout).toContain("code: VALIDATION_ERROR");
  expect(result.stdout).toContain("Available commands: home, setup, doctor, detection list, detection show, host list, host show, account list, account show, entity list, entity show, detection note list, detection tag list, detection tag set, host note list, host tag list, host tag set, account note list, account tag list, account tag set, assignment list, assignment outcome list, assignment outcome show, user list, user show, audit list, group list, group show, group member list, triage rule list, triage rule show, health list, health show, health event list");
  expect(result.stdout).toContain("lockdown list");
  expect(result.stderr).toBe("");
  expect(readdirSync(home)).toEqual([]);
});

it("answers version without loading the command graph", () => {
  const graph = join(unpacked, "dist/src/cli.js");
  renameSync(graph, `${graph}.disabled`);
  try {
    const result = invoke(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
    expect(result.stderr).toBe("");
  } finally {
    renameSync(`${graph}.disabled`, graph);
  }
});

it("keeps version latency near the Node startup floor", () => {
  const elapsed = (args: string[]) => {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { env, encoding: "utf8", input: "", timeout: 5_000 });
    expect(result.status).toBe(0);
    return performance.now() - start;
  };
  const floor = Math.min(...Array.from({ length: 5 }, () => elapsed(["-e", "console.log(1)"])));
  const version = Math.min(...Array.from({ length: 5 }, () => elapsed([bin, "--version"])));
  expect(version).toBeLessThan(floor * 3);
});
