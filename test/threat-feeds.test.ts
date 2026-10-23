import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, MULTIPART_FILE_LIMIT_BYTES, type RawTransport } from "../src/session.js";
import { runThreatFeedRead, runThreatFeedWrite } from "../src/threat-feeds.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".threat-feeds-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const file = join(scratch, "neutral-stix.xml");
const stix = '<?xml version="1.0" encoding="UTF-8"?><stix:STIX_Package xmlns:stix="http://stix.mitre.org/stix-1" version="1.2" id="neutral:Package-00000000-0000-4000-8000-000000000001"><stix:STIX_Header><stix:Title>Neutral café</stix:Title></stix:STIX_Header></stix:STIX_Package>';
const feed = { id: "3", name: "neutral-feed", _rev: "1-neutral", uploadResults: null,
  defaults: { category: "cnc", certainty: "High", indicatorType: "Watchlist", duration: 7 } };
const input = ["--name", "neutral-feed", "--category", "cnc", "--certainty", "High", "--indicator-type", "Watchlist", "--duration", "7"];
const confirm = ["--execute", "--confirm", "threat feed 3"];
type Action = "create" | "edit" | "delete" | "file.set" | "file.delete";
beforeEach(() => {
  vi.stubEnv("SYNTHETIC_TOKEN", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
  writeFileSync(file, stix);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(auditPath, { force: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

function harness(options: {
  kind?: "qux" | "rux"; state?: (url: string, reads: number) => unknown;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean;
  afterRead?: (reads: number) => void;
} = {}) {
  const kind = options.kind ?? "rux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true, operations: ["create", "edit", "delete", "file.set", "file.delete"]
      .map((action) => `${kind}.threat-feed.${action}`) },
  } } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config, "lab");
  const seen: { method: string; url: string; body?: string; headers: Record<string, string> }[] = [];
  let reads = 0;
  const transport: RawTransport = async (request) => {
    if (request.url.endsWith("/oauth2/token")) return {
      status: 200, bodyText: JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }),
    };
    seen.push(request);
    if (request.method === "GET") {
      ++reads;
      const state = options.state ? options.state(request.url, reads) : request.url.includes("/3") ? feed
        : kind === "qux" ? { threatFeeds: [] } : { count: 0, results: [], next: null };
      options.afterRead?.(reads);
      return { status: 200, bodyText: JSON.stringify(state) };
    }
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return { seen,
    read: (action: "list" | "show", args: string[] = []) => runThreatFeedRead(session,
      new Map(parseInvocation(["threat-feed", action, ...args]).flags), action),
    run: async (action: Action, args: string[]) => runThreatFeedWrite(session, coordinator,
      new Map(parseInvocation(["threat-feed", ...action.split("."), ...args]).flags), action),
  };
}

it.each(["qux", "rux"] as const)("reads list and show on %s without exposing STIX data", async (kind) => {
  const row = kind === "qux" ? { ...feed, id: undefined, _id: "3" } : feed;
  const { read } = harness({ kind, state: (url) => url.includes("/3") ? { ...row, data: stix }
    : kind === "qux" ? { threatFeeds: [row] } : { count: 1, results: [row], next: null } });
  expect((await read("list")).output).toMatchObject({ count: 1, feeds: [{ id: "3", name: "neutral-feed" }] });
  const detail = await read("show", ["--id", "3"]);
  expect(detail.output).toMatchObject(feed);
  expect(JSON.stringify(detail)).not.toContain("STIX_Package");
});

it("reports an explicit empty state", async () => {
  expect((await harness().read("list")).output).toMatchObject({ count: 0, feeds: [], help: ["No threat feeds are configured on this instance"] });
});

it("traverses RUX pages through the bounded reader", async () => {
  const { read, seen } = harness({ state: (url) => url.includes("page=2")
    ? { count: 2, results: [{ ...feed, id: "4" }], next: null }
    : { count: 2, results: [feed], next: "https://fixture.invalid/api/v3.4/threatFeeds/?page=2" } });
  expect((await read("list")).output.count).toBe(2);
  expect(seen).toHaveLength(2);
});

it.each(["qux", "rux"] as const)("previews then creates exact JSON on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  await run("create", input);
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  await run("create", [...input, "--execute", "--confirm", "new threat feed neutral-feed"]);
  const sent = seen.filter((call) => call.method === "POST");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/threatFeeds${kind === "rux" ? "/" : ""}`,
    body: JSON.stringify({ threatFeed: { name: feed.name, defaults: feed.defaults } }) });
  expect(journal().map((row) => row.kind)).toEqual(["intent", "outcome"]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/payload|defaults|synthetic-secret|synthetic-access/);
});

it.each(["qux", "rux"] as const)("uploads exact multipart bytes and journals metadata only on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  const args = ["--id", "3", "--file", file];
  const preview = await run("file.set", args);
  expect(JSON.stringify(preview)).not.toContain("STIX_Package");
  expect(JSON.stringify(preview)).not.toContain(scratch);
  await run("file.set", [...args, ...confirm]);
  const sent = seen.filter((call) => call.method === "POST");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe(`https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/threatFeeds/3${kind === "rux" ? "/" : ""}`);
  const boundary = sent[0]!.headers["Content-Type"]!.split("boundary=")[1];
  expect(Buffer.from(sent[0]!.body!, "latin1")).toEqual(Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="neutral-stix.xml"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(stix), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]));
  expect(journal().map((row) => row.file)).toEqual(Array(2).fill({ name: "neutral-stix.xml", size: Buffer.byteLength(stix),
    sha256: createHash("sha256").update(stix).digest("hex") }));
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/STIX_Package|café|payload|filePath|synthetic-secret|synthetic-access/);
});

it("refuses an oversized file before any HTTP send", async () => {
  writeFileSync(file, Buffer.alloc(MULTIPART_FILE_LIMIT_BYTES + 1));
  const { run, seen } = harness();
  await expect(run("file.set", ["--id", "3", "--file", file, ...confirm])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it("accepts the exact size bound", async () => {
  writeFileSync(file, Buffer.alloc(MULTIPART_FILE_LIMIT_BYTES, 65));
  const { run, seen } = harness();
  await run("file.set", ["--id", "3", "--file", file, ...confirm]);
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
});

it("refuses a file changed during the pre-send re-read", async () => {
  const { run, seen } = harness({ afterRead: (reads) => { if (reads === 2) writeFileSync(file, "changed"); } });
  await expect(run("file.set", ["--id", "3", "--file", file, ...confirm])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect(journal().at(-1).outcome).toBe("NOT_SENT");
});

it.each(["qux", "rux"] as const)("edits supplied fields preserving defaults on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  await run("edit", ["--id", "3", "--duration", "14", ...confirm]);
  expect(seen.at(-1)).toMatchObject({ method: "PATCH", body: JSON.stringify({ threatFeed: { defaults: { ...feed.defaults, duration: 14 } } }) });
});

it.each(["delete", "file.delete"] as const)("sends %s to its exact route", async (action) => {
  const { run, seen } = harness();
  await run(action, ["--id", "3", ...confirm]);
  expect(seen.at(-1)).toMatchObject({ method: "DELETE",
    url: `https://fixture.invalid/api/v3.4/threatFeeds/3/${action === "file.delete" ? "file/" : ""}` });
  expect(seen.at(-1)!.body).toBeUndefined();
});

it("acknowledges an unchanged edit without sending", async () => {
  const { run, seen } = harness();
  expect((await run("edit", ["--id", "3", "--duration", "7", ...confirm])).output.state).toContain("no-op");
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it("refuses changed metadata before sending", async () => {
  const { run, seen } = harness({ state: (_url, reads) => reads < 3 ? feed : { ...feed, _rev: "2-neutral" } });
  await expect(run("edit", ["--id", "3", "--duration", "14", ...confirm])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect(journal().at(-1).outcome).toBe("NOT_SENT");
});

it.each([
  [{ allowWrites: false, operations: ["rux.threat-feed.file.set"] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["rux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses policy %j", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run("file.set", ["--id", "3", "--file", file, ...confirm])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("forced read-only overrides write opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run("create", input)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([[["--execute"], "CONFIRM_REQUIRED"], [["--execute", "--confirm", "other"], "CONFIRM_MISMATCH"]] as const)(
  "refuses incorrect confirmation %j", async (args, code) => {
    const { run, seen } = harness();
    await expect(run("file.set", ["--id", "3", "--file", file, ...args])).rejects.toMatchObject({ code });
    expect(seen.every((call) => call.method === "GET")).toBe(true);
  });

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)(
  "records %s / timeout %s without replay", async (status, timeout, outcome) => {
    const { run, seen } = harness({ status, timeout });
    expect((await run("file.set", ["--id", "3", "--file", file, ...confirm])).failed).toBe(true);
    expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(journal().at(-1).outcome).toBe(outcome);
  });

it.each([
  ["create", []], ["create", ["--name", "neutral-feed", "--category", "cnc", "--certainty", "Unknown", "--indicator-type", "Watchlist", "--duration", "7"]],
  ["edit", ["--id", "3"]], ["edit", ["--id", "3", "--duration", "0"]],
  ["delete", ["--id", "../bad"]], ["file.set", ["--id", "3", "--file", "-"]],
  ["file.set", ["--id", "3", "--file", scratch]], ["file.set", ["--id", "3", "--file", join(scratch, "absent")]],
] as const)("refuses invalid %s arguments before HTTP", async (action, args) => {
  const { run, seen } = harness();
  await expect(run(action, [...args])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([{}, { ...feed, id: "other" }, { ...feed, defaults: null }])("refuses unsafe detail response %j", async (state) => {
  await expect(harness({ state: () => state }).read("show", ["--id", "3"]))
    .rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
});
