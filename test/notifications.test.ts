import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runNotificationRead, runNotificationWrite } from "../src/notifications.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".notifications-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const destinationFile = join(scratch, "destination.json");
const sentinel = "SYNTHETIC_WEBHOOK_SECRET_19";
const desired = { destination_type: "teams_webhook", title: "Synthetic destination", enabled: true,
  config: { event_rules: { system_health: { enabled: true, event_type: "system_health" } },
    destination_params: { url: `https://example.test/hooks/${sentinel}?token=${sentinel}`, token: sentinel } } };
const row = { id: "dest-19", ...desired };
const input = ["--config-file", destinationFile];
const execute = ["--execute", "--confirm", "new notification destination"];
const operation = "rux.notification-destination.create";
beforeEach(() => {
  vi.stubEnv("SYNTHETIC_TOKEN", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
  writeFileSync(destinationFile, JSON.stringify(desired));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(auditPath, { force: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

function harness(options: {
  kind?: "qux" | "rux"; state?: (url: string) => unknown;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean;
} = {}) {
  const kind = options.kind ?? "rux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true,
      operations: ["create", "edit", "delete"].map((action) => `rux.notification-destination.${action}`) },
  } } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config, "lab");
  const seen: { method: string; url: string; body?: string }[] = [];
  const transport: RawTransport = async (request) => {
    if (request.url.endsWith("/oauth2/token")) return {
      status: 200, bodyText: JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }),
    };
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET") return { status: 200, bodyText: JSON.stringify(options.state
      ? options.state(request.url) : request.url.includes("dest-19") ? { destination: row } : { destinations: [] }) };
    if (options.timeout) throw new Error(`timeout ${desired.config.destination_params.url} ${sentinel}`);
    return { status: options.status ?? 200, bodyText: JSON.stringify({ detail: desired.config.destination_params.url }) };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return { seen, redactor,
    read: (action: "list" | "show", args: string[] = []) => runNotificationRead(session,
      new Map(parseInvocation(["notification", "destination", action, ...args]).flags), action),
    run: (action: "create" | "edit" | "delete", args: string[]) => runNotificationWrite(session, coordinator,
      new Map(parseInvocation(["notification", "destination", action, ...args]).flags), action, redactor),
  };
}

it("previews with no webhook secrets and posts the original payload exactly once", async () => {
  const { run, seen } = harness();
  const preview = JSON.stringify((await run("create", input)).output);
  expect(preview).toContain("High risk");
  expect(preview).not.toContain(sentinel);
  expect(preview).not.toContain("?token=");
  expect(seen.map((call) => call.method)).toEqual(["GET"]);
  expect((await run("create", [...input, ...execute])).failed).toBe(false);
  expect(seen.filter((call) => call.method === "POST")).toEqual([{ method: "POST",
    url: "https://fixture.invalid/api/v3.4/notifications/destinations/", body: JSON.stringify(desired) }]);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/SYNTHETIC_WEBHOOK|token=|payload|destination_params/);
});

it("reads the documented list and show envelopes without leaking URLs or tokens", async () => {
  const { read, seen, redactor } = harness({ state: (url) => url.includes("dest-19")
    ? { destination: row } : { destinations: [row] } });
  expect((await read("list")).output).toMatchObject({ count: 1, destinations: [{ id: "dest-19", title: desired.title }] });
  const shown = JSON.stringify((await read("show", ["--id", "dest-19"])).output);
  expect(shown).not.toContain(sentinel);
  expect(shown).not.toContain("?token=");
  expect(redactor.text(`echo ${sentinel} ${desired.config.destination_params.url}`)).not.toContain(sentinel);
  expect(seen.map((call) => call.url)).toEqual([
    "https://fixture.invalid/api/v3.4/notifications/destinations/",
    "https://fixture.invalid/api/v3.4/notifications/destinations/dest-19/",
  ]);
});

it("reports an explicit empty list", async () => {
  expect((await harness().read("list")).output).toMatchObject({ count: 0, destinations: [], help: ["No notification destinations are configured"] });
});

it.each(["edit", "delete"] as const)("sends %s after two reads with exact confirmation", async (action) => {
  const { run, seen } = harness();
  const args = ["--id", "dest-19", ...(action === "edit" ? input : []), "--execute", "--confirm", "notification destination dest-19"];
  expect((await run(action, args)).failed).toBe(false);
  expect(seen.map((call) => call.method)).toEqual(["GET", "GET", action === "edit" ? "PUT" : "DELETE"]);
  expect(seen.at(-1)).toEqual({ method: action === "edit" ? "PUT" : "DELETE",
    url: "https://fixture.invalid/api/v3.4/notifications/destinations/dest-19/",
    ...(action === "edit" ? { body: JSON.stringify(desired) } : {}) });
});

it("refuses QUX reads and writes before HTTP", async () => {
  const { read, run, seen } = harness({ kind: "qux" });
  await expect(read("list")).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  await expect(run("create", input)).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  expect(seen).toEqual([]);
});

it.each([
  [{ allowWrites: false, operations: [operation] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["rux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses profile policy %j", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run("create", [...input, ...execute])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("lets forced read-only override opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run("create", [...input, ...execute])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"], [["--execute", "--confirm", "other"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run("create", [...input, ...args])).rejects.toMatchObject({ code });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
});

it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)(
  "journals rejection or timeout without replay %s %s", async (status, timeout, outcome) => {
    const { run, seen } = harness({ status, timeout });
    const result = await run("create", [...input, ...execute]);
    expect(result.failed).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(journal().at(-1)).toMatchObject({ outcome });
    expect(readFileSync(auditPath, "utf8")).not.toContain(sentinel);
  });

it.each([{}, { destinations: [row, row] }, { destinations: null }])("refuses malformed list %j", async (state) => {
  await expect(harness({ state: () => state }).read("list")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
});

it("refuses show for a different ID", async () => {
  await expect(harness({ state: () => ({ destination: { ...row, id: "other" } }) }).read("show", ["--id", "dest-19"]))
    .rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
});

it("refuses a concurrent secret-only destination change", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ({ destination: ++reads === 1 ? row : {
    ...row, config: { ...row.config, destination_params: { ...row.config.destination_params, url: "https://example.test/?token=OTHER_SYNTHETIC_SECRET" } },
  } }) });
  await expect(run("delete", ["--id", "dest-19", "--execute", "--confirm", "notification destination dest-19"]))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.map((call) => call.method)).toEqual(["GET", "GET"]);
});

it.each([
  { rows: [row] },
  { rows: Array.from({ length: 24 }, (_, index) => ({ ...row, id: `dest-${index}`, title: `Synthetic ${index}` })) },
])("refuses duplicate titles and the destination limit before POST", async ({ rows }) => {
  const { run, seen } = harness({ state: () => ({ destinations: rows }) });
  await expect(run("create", [...input, ...execute])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.map((call) => call.method)).toEqual(["GET"]);
});

it("redacts the current destination in a delete preview", async () => {
  const { run, seen } = harness();
  const output = JSON.stringify((await run("delete", ["--id", "dest-19"])).output);
  expect(output).toContain("dest-19");
  expect(output).not.toContain(sentinel);
  expect(output).not.toContain("?token=");
  expect(seen.map((call) => call.method)).toEqual(["GET"]);
});

it.each(["not json", JSON.stringify({ ...desired, config: null }), JSON.stringify({ ...desired, unexpected: sentinel })])(
  "refuses malformed configuration without exposing content", async (value) => {
    writeFileSync(destinationFile, value);
    const { run, seen } = harness();
    await expect(run("create", input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(seen).toEqual([]);
  });
