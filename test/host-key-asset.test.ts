import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runHostKeyAsset } from "../src/host-key-asset.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".host-key-asset-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
beforeEach(() => {
  vi.stubEnv("SYNTHETIC_TOKEN", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(auditPath, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function harness(options: {
  kind?: "qux" | "rux"; state?: () => unknown;
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean;
} = {}) {
  const kind = options.kind ?? "qux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true, operations: [`${kind}.host.key-asset.set`] },
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
    if (request.method === "GET") return {
      status: 200, bodyText: JSON.stringify({ id: 7, key_asset: options.state ? options.state() : false }),
    };
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return {
    seen,
    run: (args: string[] = []) => runHostKeyAsset(session, coordinator,
      new Map(parseInvocation(["host", "key-asset", "set", ...args]).flags)),
  };
}
const input = ["--id", "7", "--value", "true"];
const execute = ["--execute", "--confirm", "host 7"];
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

it.each([
  ["qux", "true", false, "True"], ["qux", "false", true, "False"],
  ["rux", "true", "false", "true"], ["rux", "false", "true", "false"],
] as const)("previews then sets %s key-asset %s with the documented payload", async (kind, value, state, wire) => {
  const { run, seen } = harness({ kind, state: () => state });
  const args = ["--id", "7", "--value", value];
  expect((await run(args)).output).toMatchObject({ current: value !== "true", desired: value === "true", proposed: { key_asset: wire } });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect((await run([...args, ...execute])).failed).toBe(false);
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([
    { method: "PATCH", url: `https://fixture.invalid/api/v${kind === "qux" ? "2.5" : "3.4"}/hosts/7${kind === "rux" ? "/" : ""}`,
      body: JSON.stringify({ key_asset: wire }) },
  ]);
  expect(seen.filter((call) => call.method === "GET")).toHaveLength(3);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/key_asset|payload|synthetic-secret|synthetic-access/);
});

it.each([true, "True", "true"])("skips already-set state %s", async (state) => {
  const { run, seen } = harness({ state: () => state });
  expect((await run([...input, ...execute])).output).toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  [{ allowWrites: false, operations: ["qux.host.key-asset.set"] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["qux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses disallowed profile writes %j", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("lets forced read-only override opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"],
  [["--execute", "--confirm", "host 8"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run([...input, ...args])).rejects.toMatchObject({ code });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  [], ["--id", "0", "--value", "true"], ["--id", "9007199254740992", "--value", "true"],
  ["--id", "7", "--value", "True"], ["--id", "7"], ["--value", "true"],
].map((args) => ({ args })))("refuses invalid input $args", async ({ args }) => {
  const { run, seen } = harness();
  await expect(run(args)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it.each([undefined, null, 1, "unknown"])("refuses malformed state %s", async (state) => {
  const { run, seen } = harness({ state: () => state });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
});

it.each([
  [403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"],
] as const)("journals failure or ambiguity without replay %s %s", async (status, timeout, outcome) => {
  const { run, seen } = harness({ status, timeout });
  expect((await run([...input, ...execute])).failed).toBe(true);
  expect(seen.filter((call) => call.method === "PATCH")).toHaveLength(1);
  expect(journal().at(-1)).toMatchObject({ outcome });
});

it("skips when the pre-send read reaches desired state", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ++reads > 1 });
  expect((await run([...input, ...execute])).output).toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method === "PATCH")).toEqual([]);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});
