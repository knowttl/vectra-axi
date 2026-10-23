import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runMatchRead, runMatchWrite, type MatchAction } from "../src/match.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, MULTIPART_FILE_LIMIT_BYTES, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".match-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const file = join(scratch, "synthetic.rules");
const content = '# synthetic ruleset café - no production signatures\n';
const id = "00000000-0000-4000-8000-000000000001";
const device = "SYNTH0001";
const rule = { uuid: id, name: "synthetic.rules", hashsum: "synthetic-digest", device_serials: [], timestamp: "2026-10-23T00:00:00Z" };
const actions: MatchAction[] = ["enablement.set", "ruleset.upload", "ruleset.delete", "assignment.set", "assignment.delete"];
const enable = ["--device", device, "--value", "true"];
const execute = ["--execute", "--confirm", `match device ${device}`];
beforeEach(() => {
  vi.stubEnv("SYNTHETIC_TOKEN", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
  writeFileSync(file, content);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(auditPath, { force: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

function harness(options: {
  kind?: "qux" | "rux"; state?: (url: string, reads: number) => unknown; enabled?: boolean; assigned?: boolean;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean; afterRead?: (reads: number) => void;
} = {}) {
  const kind = options.kind ?? "qux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true, operations: actions.map((action) => `${kind}.match.${action}`) },
  } } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config, "lab");
  const seen: Parameters<RawTransport>[0][] = [];
  let reads = 0;
  const transport: RawTransport = async (request) => {
    if (request.url.endsWith("/oauth2/token")) return {
      status: 200, bodyText: JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }),
    };
    seen.push(request);
    if (request.method === "GET") {
      ++reads;
      const state = options.state ? options.state(request.url, reads) : request.url.includes("/enablement")
        ? { is_enabled: options.enabled ?? false } : request.url.includes("/rules") ? rule
        : { device_to_rules_map: [{ device_serial: device, rules: options.assigned ? [id] : [] }] };
      options.afterRead?.(reads);
      return { status: 200, bodyText: JSON.stringify(state) };
    }
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return { seen,
    read: (kind: "enablement" | "ruleset" | "assignment", args: string[] = []) => runMatchRead(session,
      new Map(parseInvocation(["match", kind, kind === "assignment" ? "list" : "show", ...args]).flags), kind),
    run: async (action: MatchAction, args: string[]) => runMatchWrite(session, coordinator,
      new Map(parseInvocation(["match", ...action.split("."), ...args]).flags), action),
  };
}

it.each(["qux", "rux"] as const)("previews reboot and licence warnings without sending on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  const preview = await run("enablement.set", enable);
  expect(preview.output).toMatchObject({ target: `match device ${device}`, before: { is_enabled: false } });
  expect(preview.output.warning).toMatch(/reboot/);
  expect(preview.output.warning).toMatch(/licence/);
  expect(seen.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: "GET", url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/vectra-match/enablement${kind === "rux" ? "/" : ""}?device_serial=${device}` },
  ]);
});

it.each(["qux", "rux"] as const)("posts exact enablement body and metadata-only journal on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  expect((await run("enablement.set", [...enable, ...execute])).failed).toBe(false);
  expect(seen.map((row) => row.method)).toEqual(["GET", "GET", "POST"]);
  expect(seen.at(-1)).toMatchObject({
    url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/vectra-match/enablement${kind === "rux" ? "/" : ""}`,
    body: JSON.stringify({ device_serial: device, desired_state: true }),
  });
  expect(journal().map((row) => [row.kind, row.effect])).toEqual([["intent", "disruptive"], ["outcome", "disruptive"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/payload|desired_state|synthetic-secret|synthetic-access/);
});

it.each([true, false])("unchanged enablement %s is a no-op", async (enabled) => {
  const { run, seen } = harness({ enabled });
  expect((await run("enablement.set", ["--device", device, "--value", String(enabled), ...execute])).output.state).toContain("no-op");
  expect(seen.map((row) => row.method)).toEqual(["GET"]);
});

it("disables an enabled device with an explicit false body", async () => {
  const { run, seen } = harness({ enabled: true });
  await run("enablement.set", ["--device", device, "--value", "false", ...execute]);
  expect(seen.at(-1)?.body).toBe(JSON.stringify({ device_serial: device, desired_state: false }));
});

it.each(["qux", "rux"] as const)("uploads multipart bytes and journals only metadata on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  const preview = await run("ruleset.upload", ["--file", file]);
  expect(JSON.stringify(preview)).not.toContain(content);
  expect(JSON.stringify(preview)).not.toContain(scratch);
  if (kind === "rux") expect(preview.output.uploadWarning).toMatch(/deprecated.*\/rules\/upload\//);
  await run("ruleset.upload", ["--file", file, "--execute", "--confirm", "new match ruleset"]);
  const sent = seen.filter((row) => row.method === "POST");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe(`https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/vectra-match/rules${kind === "rux" ? "/" : ""}`);
  const boundary = sent[0]!.headers["Content-Type"]!.split("boundary=")[1];
  expect(Buffer.from(sent[0]!.body!, "latin1")).toEqual(Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.rules"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]));
  expect(journal().map((row) => row.file)).toEqual(Array(2).fill({ name: "synthetic.rules", size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex") }));
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/café|production signatures|payload|filePath|synthetic-secret|synthetic-access/);
});

it.each(["qux", "rux"] as const)("deletes rulesets by UUID on %s", async (kind) => {
  const { run, seen } = harness({ kind });
  await run("ruleset.delete", ["--uuid", id, "--execute", "--confirm", `match ruleset ${id}`]);
  expect(seen.at(-1)).toMatchObject({ method: "DELETE", body: JSON.stringify({ uuid: id }),
    url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/vectra-match/rules${kind === "rux" ? "/" : ""}` });
});

it.each([
  ["qux", "set", false, "POST", { uuid: id, device_serials: [device] }],
  ["rux", "set", false, "POST", { uuid: id, device_serials: [device] }],
  ["qux", "delete", true, "DELETE", { uuid: id, device_serial: device }],
  ["rux", "delete", true, "DELETE", { uuid: id, device_serial: device }],
] as const)("%s assignment %s uses the documented body", async (kind, action, assigned, method, body) => {
  const { run, seen } = harness({ kind, assigned });
  await run(`assignment.${action}`, ["--device", device, "--uuid", id, "--execute", "--confirm", `match assignment ${device} ruleset ${id}`]);
  expect(seen.at(-1)).toMatchObject({ method, body: JSON.stringify(body),
    url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/vectra-match/assignment${kind === "rux" ? "/" : ""}` });
});

it.each([["set", true], ["delete", false]] as const)("unchanged assignment %s is a no-op", async (action, assigned) => {
  const { run, seen } = harness({ assigned });
  expect((await run(`assignment.${action}`, ["--device", device, "--uuid", id, "--execute"])).output.state).toContain("no-op");
  expect(seen.every((row) => row.method === "GET")).toBe(true);
});

it.each([
  [{ allowWrites: false, operations: ["qux.match.enablement.set"] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["qux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses policy %j before HTTP", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run("enablement.set", [...enable, ...execute])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("forced read-only overrides Match opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run("enablement.set", enable)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([[["--execute"], "CONFIRM_REQUIRED"], [["--execute", "--confirm", "other"], "CONFIRM_MISMATCH"]] as const)(
  "refuses unconfirmed reboot %j", async (args, code) => {
    const { run, seen } = harness();
    await expect(run("enablement.set", [...enable, ...args])).rejects.toMatchObject({ code });
    expect(seen.every((row) => row.method === "GET")).toBe(true);
  });

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)("records %s timeout=%s without replay", async (status, timeout, outcome) => {
  const { run, seen } = harness({ status, timeout });
  expect((await run("enablement.set", [...enable, ...execute])).failed).toBe(true);
  expect(seen.filter((row) => row.method === "POST")).toHaveLength(1);
  expect(journal().at(-1).outcome).toBe(outcome);
});

it("refuses a ruleset changed before sending", async () => {
  const { run, seen } = harness({ state: (_url, reads) => ({ ...rule, hashsum: String(reads) }) });
  await expect(run("ruleset.delete", ["--uuid", id, "--execute", "--confirm", `match ruleset ${id}`])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.every((row) => row.method === "GET")).toBe(true);
  expect(journal().at(-1).outcome).toBe("NOT_SENT");
});

it("refuses a file changed during the pre-send read", async () => {
  const { run, seen } = harness({ afterRead: (reads) => { if (reads === 2) writeFileSync(file, "changed"); } });
  await expect(run("ruleset.upload", ["--file", file, "--execute", "--confirm", "new match ruleset"])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.every((row) => row.method === "GET")).toBe(true);
  expect(journal().at(-1).outcome).toBe("NOT_SENT");
});

it("refuses an oversized ruleset before HTTP", async () => {
  writeFileSync(file, Buffer.alloc(MULTIPART_FILE_LIMIT_BYTES + 1));
  const { run, seen } = harness();
  await expect(run("ruleset.upload", ["--file", file])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([
  ["enablement.set", ["--device", "../bad", "--value", "true"]],
  ["enablement.set", ["--device", device, "--value", "yes"]],
  ["ruleset.delete", ["--uuid", "../bad"]],
  ["ruleset.upload", ["--file", "-"]],
  ["ruleset.upload", ["--file", scratch]],
  ["assignment.set", ["--uuid", id]],
] as const)("refuses invalid %s arguments before HTTP", async (action, args) => {
  const { run, seen } = harness();
  await expect(run(action, [...args])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([{}, { is_enabled: "false" }, { is_enabled: false, details: "licence unavailable" }])("refuses malformed enablement %j", async (state) => {
  const { run, seen } = harness({ state: () => state });
  await expect(run("enablement.set", [...enable, ...execute])).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.every((row) => row.method === "GET")).toBe(true);
});

it("reads ruleset metadata without exposing rule bytes", async () => {
  const { read } = harness({ state: () => ({ ...rule, data: content }) });
  const result = await read("ruleset", ["--uuid", id]);
  expect(result.output).toMatchObject(rule);
  expect(JSON.stringify(result)).not.toContain(content);
});

it("reports an explicit empty assignment list", async () => {
  expect((await harness({ state: () => ({ device_to_rules_map: [] }) }).read("assignment")).output)
    .toMatchObject({ count: 0, device_to_rules_map: [], help: ["No Match device assignments are configured"] });
});

it.each([
  {},
  { device_to_rules_map: [{ device_serial: device, rules: [id, id] }] },
  { device_to_rules_map: [{ device_serial: device, rules: [] }, { device_serial: device, rules: [id] }] },
])("refuses malformed assignment maps before deletion %j", async (state) => {
  const { run, seen } = harness({ state: () => state });
  await expect(run("assignment.delete", ["--device", device, "--uuid", id, "--execute", "--confirm", `match assignment ${device} ruleset ${id}`]))
    .rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.every((row) => row.method === "GET")).toBe(true);
});

it("refuses a mismatched ruleset UUID before deletion", async () => {
  const { run, seen } = harness({ state: () => ({ ...rule, uuid: "other" }) });
  await expect(run("ruleset.delete", ["--uuid", id, "--execute", "--confirm", `match ruleset ${id}`]))
    .rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.every((row) => row.method === "GET")).toBe(true);
});
