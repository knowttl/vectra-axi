import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";
import { loadConfig, selectProfile, type SelectedProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createMutationSender, createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator, type MutationCoordinator, type MutationDefinition } from "../src/writes.js";

// WRITE-00 acceptance: the coordinator is entirely fixture-driven with no
// real mutation family enabled. Every test drives it through this synthetic
// fixture mutation; no live instance, real credential or customer data exists.
const scratch = mkdtempSync(join(import.meta.dirname, ".writes-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const token = "fake-token-SENTINEL";
const NOW = 1_700_000_000_000;
const TIME = new Date(NOW).toISOString();

const enabledProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN", writes: { allowWrites: true, operations: ["qux.fixture.write"] } };
const disabledProfile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token",
  tokenEnv: "SENTINEL_TOKEN" };
const mutation: MutationDefinition = { operation: "qux.fixture.write", method: "POST",
  path: "/api/v2.5/fixture/notes", effect: "write", target: "fixture-note-1",
  payload: { text: "synthetic note" } };

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", token);
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
  vi.stubEnv("VECTRA_AXI_PROFILE", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(configPath, { force: true }); rmSync(auditPath, { force: true, recursive: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function selected(profile: Record<string, unknown> = { ...enabledProfile }, name = "lab"): SelectedProfile {
  writeFileSync(configPath, JSON.stringify({ profiles: { [name]: profile } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  return selectProfile(loaded.config, name);
}

function coordinator(args: {
  profile?: SelectedProfile; transport: RawTransport; clock?: () => number; audit?: string;
}): { coordinator: MutationCoordinator; redactor: SecretRedactor } {
  const profile = args.profile ?? selected();
  const redactor = new SecretRedactor();
  redactor.add(token);
  return {
    coordinator: createMutationCoordinator({ profile, configPath, redactor, transport: args.transport,
      clock: args.clock ?? (() => NOW), auditPath: args.audit ?? auditPath }),
    redactor,
  };
}

const ok = (body: unknown) => ({ status: 200, bodyText: JSON.stringify(body) });
const readState = async (): Promise<unknown> => ({ notes: [] });
const auditLines = (): Record<string, unknown>[] =>
  readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

it("refuses writes by default even with execution requested", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ profile: selected({ ...disabledProfile }), transport });
  await expect(writes.execute(mutation, { execute: true, readState }))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(transport).not.toHaveBeenCalled();
});

it("lets forced read-only override a hand-enabled profile", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  await expect(writes.execute(mutation, { execute: true, readState }))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(transport).not.toHaveBeenCalled();
});

it("refuses operations outside the configured scope", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  await expect(writes.execute({ ...mutation, operation: "qux.other.write" }, { execute: true, readState }))
    .rejects.toMatchObject({ code: "OPERATION_NOT_WRITABLE" });
  expect(transport).not.toHaveBeenCalled();
});

it("uses the environment-selected profile's own scope", async () => {
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: enabledProfile, other: disabledProfile } }));
  vi.stubEnv("VECTRA_AXI_PROFILE", "other");
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config);
  expect(profile.name).toBe("other");
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ profile, transport });
  expect(writes.scope.operations).toEqual([]);
  await expect(writes.execute(mutation, { execute: true, readState }))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(transport).not.toHaveBeenCalled();
});

it("freezes the original scope and origin at creation", async () => {
  const profile = selected();
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ profile, transport });
  profile.writes?.operations.push("qux.other.write");
  profile.origin = "https://evil.invalid";
  await expect(writes.execute({ ...mutation, operation: "qux.other.write" }, { execute: true, readState }))
    .rejects.toMatchObject({ code: "OPERATION_NOT_WRITABLE" });
  const result = await writes.execute(mutation, { execute: true, readState });
  expect(result.kind).toBe("success");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]![0].url).toBe("https://fixture.invalid/api/v2.5/fixture/notes");
});

it("previews without sending when --execute is absent", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  const result = await writes.execute(mutation, { readState });
  expect(result).toEqual({ kind: "dry-run",
    preview: { operation: "qux.fixture.write", method: "POST",
      url: "https://fixture.invalid/api/v2.5/fixture/notes", effect: "write",
      target: "fixture-note-1", noop: false } });
  expect(transport).not.toHaveBeenCalled();
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("rejects --dry-run combined with --execute", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  await expect(writes.execute(mutation, { execute: true, dryRun: true, readState }))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  ["missing", undefined, "CONFIRM_REQUIRED"],
  ["mismatched", "other-target", "CONFIRM_MISMATCH"],
])("refuses disruptive mutations with %s confirmation", async (_name, confirm, code) => {
  const disruptive = { ...mutation, effect: "disruptive" as const };
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  await expect(writes.execute(disruptive, { execute: true, readState, ...(confirm === undefined ? {} : { confirm }) }))
    .rejects.toMatchObject({ code });
  expect(transport).not.toHaveBeenCalled();
});

it("sends a disruptive mutation with matching confirmation", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  const result = await writes.execute({ ...mutation, effect: "disruptive" },
    { execute: true, readState, confirm: "fixture-note-1" });
  expect(result.kind).toBe("success");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("returns a no-op without sending when state already matches", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  const result = await writes.execute(mutation,
    { execute: true, readState, isNoop: () => true });
  expect(result.kind).toBe("noop");
  expect(transport).not.toHaveBeenCalled();
  expect(() => readFileSync(auditPath, "utf8")).toThrow();
});

it("sends the authorization header with If-Match when provided", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  const result = await writes.execute(mutation, { execute: true, readState, ifMatch: `"etag-7"` });
  expect(result.kind).toBe("success");
  expect(transport).toHaveBeenCalledExactlyOnceWith({
    method: "POST",
    url: "https://fixture.invalid/api/v2.5/fixture/notes",
    headers: { Authorization: `Token ${token}`, Accept: "application/json",
      "Content-Type": "application/json", "If-Match": `"etag-7"` },
    body: JSON.stringify({ text: "synthetic note" }),
    tls: { rejectUnauthorized: true },
  });
});

it("records redacted intent and outcome on success", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  const sent = { ...mutation, payload: { text: `synthetic ${token}` } };
  const result = await writes.execute(sent, { execute: true, readState, ifMatch: `etag-${token}`, intentId: "intent-1" });
  expect(result).toMatchObject({ kind: "success", auditId: "intent-1", status: 200 });
  const lines = auditLines();
  expect(lines).toEqual([
    { kind: "intent", id: "intent-1", time: TIME, profile: "lab", operation: "qux.fixture.write",
      method: "POST", url: "https://fixture.invalid/api/v2.5/fixture/notes", target: "fixture-note-1",
      effect: "write", ifMatch: "etag-***redacted***" },
    { kind: "outcome", id: "intent-1", time: TIME, profile: "lab", operation: "qux.fixture.write",
      method: "POST", url: "https://fixture.invalid/api/v2.5/fixture/notes", target: "fixture-note-1",
      effect: "write", ifMatch: "etag-***redacted***", httpStatus: 200, outcome: "SUCCESS" },
  ]);
  expect(readFileSync(auditPath, "utf8")).not.toContain(token);
});

it("blocks the send when intent cannot be recorded", async () => {
  mkdirSync(auditPath, { recursive: true });
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  await expect(writes.execute(mutation, { execute: true, readState }))
    .rejects.toMatchObject({ code: "INTENT_NOT_RECORDED" });
  expect(transport).not.toHaveBeenCalled();
});

it("reports a definitive failure when the server rejects the mutation", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValue({ status: 403, bodyText: JSON.stringify({ message: "denied" }) });
  const { coordinator: writes } = coordinator({ transport });
  const result = await writes.execute(mutation, { execute: true, readState, intentId: "intent-2" });
  expect(result).toMatchObject({ kind: "failed", auditId: "intent-2", status: 403 });
  expect(transport).toHaveBeenCalledTimes(1);
  const outcomes = auditLines().filter((line) => line.kind === "outcome");
  expect(outcomes).toEqual([expect.objectContaining({ id: "intent-2", httpStatus: 403, outcome: "FAILED" })]);
});

it("reports OUTCOME_UNKNOWN without replay when the send times out", async () => {
  const transport = vi.fn<RawTransport>().mockRejectedValue(new Error("socket timed out"));
  const { coordinator: writes } = coordinator({ transport });
  const result = await writes.execute(mutation, { execute: true, readState, intentId: "intent-3" });
  expect(result.kind).toBe("unknown");
  if (result.kind !== "unknown") throw new Error("unreachable");
  expect(result.auditId).toBe("intent-3");
  expect(result.guidance).toContain("intent-3");
  expect(result.guidance).toContain("read back");
  expect(transport).toHaveBeenCalledTimes(1);
  const outcomes = auditLines().filter((line) => line.kind === "outcome");
  expect(outcomes).toEqual([expect.objectContaining({ id: "intent-3", httpStatus: 0, outcome: "OUTCOME_UNKNOWN" })]);
  await expect(writes.execute(mutation, { execute: true, readState, intentId: "intent-3" }))
    .rejects.toMatchObject({ code: "ALREADY_EXECUTED" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
  { name: "missing token", tokenValue: undefined, ifMatch: undefined, caBundle: undefined, code: "AUTH_REQUIRED" },
  { name: "invalid token", tokenValue: "invalid token", ifMatch: undefined, caBundle: undefined, code: "AUTH_FAILED" },
  { name: "blank If-Match", tokenValue: token, ifMatch: " ", caBundle: undefined, code: "VALIDATION_ERROR" },
  { name: "If-Match with newline", tokenValue: token, ifMatch: "etag\n", caBundle: undefined, code: "VALIDATION_ERROR" },
  { name: "unreadable CA", tokenValue: token, ifMatch: undefined, caBundle: "missing-ca.pem", code: "TLS_TRUST_ERROR" },
])("records NOT_SENT and preserves the error for $name", async ({ tokenValue, ifMatch, caBundle, code }) => {
  vi.stubEnv("SENTINEL_TOKEN", tokenValue);
  const transport = vi.fn<RawTransport>();
  const profile = selected({ ...enabledProfile, ...(caBundle ? { caBundle } : {}) });
  const { coordinator: writes } = coordinator({ profile, transport });
  await expect(writes.execute(mutation, { execute: true, readState, ...(ifMatch === undefined ? {} : { ifMatch }) }))
    .rejects.toMatchObject({ code });
  expect(transport).not.toHaveBeenCalled();
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 0, outcome: "NOT_SENT" })]);
});

it.each([
  { name: "rejected credentials", transport: () => vi.fn<RawTransport>().mockResolvedValue({ status: 401, bodyText: "{}" }),
    code: "AUTH_FAILED" },
  { name: "invalid credential response", transport: () => vi.fn<RawTransport>().mockResolvedValue(ok({})),
    code: "AUTH_RESPONSE_INVALID" },
  { name: "credential exchange timeout", transport: () => vi.fn<RawTransport>().mockRejectedValue(new Error("socket timed out")),
    code: "AUTH_EXCHANGE_FAILED" },
])("records NOT_SENT for OAuth $name", async ({ transport: makeTransport, code }) => {
  vi.stubEnv("SENTINEL_SECRET", "synthetic-secret");
  const transport = makeTransport();
  const profile = selected({ kind: "qux", origin: enabledProfile.origin, apiVersion: "2.5", auth: "oauth",
    clientId: "synthetic-client", secretEnv: "SENTINEL_SECRET", writes: enabledProfile.writes });
  const { coordinator: writes } = coordinator({ profile, transport });
  await expect(writes.execute(mutation, { execute: true, readState })).rejects.toMatchObject({ code });
  expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    method: "POST", url: "https://fixture.invalid/api/v2.5/oauth2/token",
  }));
  expect(auditLines().filter((line) => line.kind === "outcome"))
    .toEqual([expect.objectContaining({ httpStatus: 0, outcome: "NOT_SENT" })]);
});

it("reports possible remote success when the outcome cannot be recorded", async () => {
  const transport: RawTransport = async () => {
    rmSync(auditPath, { force: true });
    mkdirSync(auditPath, { recursive: true });
    return ok({ id: 1 });
  };
  const seen = vi.fn(transport);
  const { coordinator: writes } = coordinator({ transport: seen });
  try {
    await writes.execute(mutation, { execute: true, readState });
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ code: "OUTCOME_NOT_RECORDED" });
    expect((error as AxiError).suggestions.join(" ")).toContain("may have been applied");
  }
  expect(seen).toHaveBeenCalledTimes(1);
});

it("aborts without sending when the re-read fails", async () => {
  const read = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce({ notes: [] })
    .mockRejectedValueOnce(new AxiError("fixture read failed", "REQUEST_FAILED", ["Retry the read"]));
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  await expect(writes.execute(mutation, { execute: true, readState: read }))
    .rejects.toMatchObject({ code: "REQUEST_FAILED" });
  expect(transport).not.toHaveBeenCalled();
  const outcomes = auditLines().filter((line) => line.kind === "outcome");
  expect(outcomes).toEqual([expect.objectContaining({ httpStatus: 0, outcome: "NOT_SENT" })]);
});

it("lets the approval hook deny execution", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const { coordinator: writes } = coordinator({ transport });
  await expect(writes.execute(mutation, { execute: true, readState, approval: () => false }))
    .rejects.toMatchObject({ code: "APPROVAL_DENIED" });
  expect(transport).not.toHaveBeenCalled();
  const approved = await writes.execute(mutation, { execute: true, readState, approval: () => true });
  expect(approved.kind).toBe("success");
});

it("rejects forged and retargeted authorizations before any HTTP call", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const profile = selected();
  const redactor = new SecretRedactor();
  const sender = createMutationSender({ profile, configPath, redactor, transport });
  await expect(sender.send({ nonce: "forged", method: "POST", url: "https://fixture.invalid/api/v2.5/fixture/notes" }))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  const authorized = sender.authorize({ method: "POST", url: "https://fixture.invalid/api/v2.5/fixture/notes" });
  await expect(sender.send({ ...authorized, url: "https://fixture.invalid/api/v2.5/other" }))
    .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(() => sender.authorize({ method: "POST", url: "https://evil.invalid/api/v2.5/fixture/notes" }))
    .toThrow(expect.objectContaining({ code: "DESTINATION_DENIED" }));
  expect(transport).not.toHaveBeenCalled();
});

it("refuses to replay an authorization", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const profile = selected();
  const redactor = new SecretRedactor();
  const sender = createMutationSender({ profile, configPath, redactor, transport });
  const other = createMutationSender({ profile, configPath, redactor, transport });
  const authorized = sender.authorize({ method: "POST", url: "https://fixture.invalid/api/v2.5/fixture/notes" });
  await sender.send(authorized);
  await expect(sender.send(authorized)).rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  await expect(other.send(authorized)).rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("keeps the fixture mutation out of the read session", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(ok({ id: 1 }));
  const profile = selected();
  const session = createSession({ profile, configPath, redactor: new SecretRedactor(), transport });
  await expect(session.request("qux.fixture.write")).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect(transport).not.toHaveBeenCalled();
});

it("validates the hand-edited write policy at load", () => {
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: { ...enabledProfile,
    writes: { allowWrites: true, operations: [] } } } }));
  expect(() => loadConfig(configPath)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: { ...enabledProfile,
    writes: { allowWrites: "yes", operations: ["qux.fixture.write"] } } } }));
  expect(() => loadConfig(configPath)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});
