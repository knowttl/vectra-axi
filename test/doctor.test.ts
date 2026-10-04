import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { doctorTargets, runDoctor } from "../src/doctor.js";
import type { RawTransport } from "../src/session.js";
import { loadConfig } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { parseInvocation } from "../src/catalogue.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".doctor-test-"));
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
  delete process.env.VECTRA_AXI_PROFILE;
  rmSync(path, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function loaded(names: string[] = ["lab"]) {
  writeFileSync(path, JSON.stringify({ profiles: Object.fromEntries(names.map((name) => [name, tokenProfile])) }));
  return loadConfig(path, new SecretRedactor());
}

function doctor(names: string[], transport: RawTransport) {
  const owned = loaded(names);
  return runDoctor({ loaded: owned, names,
    redactor: new SecretRedactor(), transport });
}

const detection = { id: 1, detection_type: "synthetic-type", state: "active", threat: null, certainty: 80 };
const body = (value: unknown): { status: number; bodyText: string } =>
  ({ status: 200, bodyText: JSON.stringify(value) });

// The bounded check is one first-page detection read: a returned continuation
// is kept as evidence of more rows, never followed for a one-row window.
it("checks a profile with one bounded detection read", async () => {
  const urls: string[] = [];
  const transport: RawTransport = async (request) => {
    urls.push(request.url);
    expect(request.method).toBe("GET");
    return body({ results: [detection], count: 2,
      next: "https://fixture.invalid/api/v2.5/detections?min_id=2" });
  };
  const result = await doctor(["lab"], transport);
  expect(urls).toEqual(["https://fixture.invalid/api/v2.5/detections"]);
  expect(result).toEqual({ failed: false, output: {
    config: path,
    check: expect.stringContaining("qux.detection.list"),
    count: "1 of 1 profiles ok",
    profiles: [{ name: "lab", auth: "token", check: expect.any(String), status: "ok", detail: "1 of 2 detections" }],
    complete: true,
    help: [`Run \`vectra-axi detection list --config ${path} --profile lab\` to start an investigation`],
  } });
});

it.each(["ok", "read failure", "credential failure"])("preserves context in %s follow-ups", async (scenario) => {
  const configPath = join(scratch, "lab's config.json");
  const names = ["lab's profile", "other profile"];
  writeFileSync(configPath, JSON.stringify({ profiles: Object.fromEntries(names.map((name) => [name, tokenProfile])) }));
  if (scenario === "credential failure") delete process.env.SENTINEL_TOKEN;
  try {
    const owned = loadConfig(configPath, new SecretRedactor());
    const transport: RawTransport = async () => scenario === "read failure"
      ? { status: 403, bodyText: "{}" } : body({ results: [detection], count: 1 });
    const result = await runDoctor({ loaded: owned, names, redactor: new SecretRedactor(), transport });
    const hints = (result.output.help as string[]).filter((hint) => hint.includes("`vectra-axi "));
    expect(hints).toHaveLength(2);
    expect(result.output.help).not.toEqual(expect.arrayContaining([expect.stringContaining("--cursor")]));
    const invocations = hints.map((hint) => {
      const command = /`vectra-axi (.*?)`/.exec(hint)![1]!;
      const args = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`],
        { encoding: "utf8" }).trimEnd().split("\n");
      return parseInvocation(args);
    });
    expect(invocations.map((invocation) => ({ leaf: invocation.leaf,
      config: invocation.flags.get("config"), profile: invocation.flags.get("profile") }))).toEqual(
      names.map((name) => ({ leaf: scenario === "ok" ? "detection list" : "doctor", config: configPath, profile: name })));
    expect(invocations.map((invocation) => doctorTargets(
      loadConfig(invocation.flags.get("config") as string).config, invocation.flags.get("profile") as string))).toEqual(
      names.map((name) => [name]));
  } finally {
    rmSync(configPath, { force: true });
  }
});

it("reports an empty detection window as an ok profile", async () => {
  const transport: RawTransport = async () => body({ results: [], count: 0 });
  const result = await doctor(["lab"], transport);
  expect(result.failed).toBe(false);
  expect(result.output).toMatchObject({ count: "1 of 1 profiles ok", complete: true,
    profiles: [{ name: "lab", status: "ok", detail: "0 detections" }] });
});

it.each([
  ["denied access", 403, "ACCESS_DENIED"],
  ["rejected credential", 401, "AUTH_FAILED"],
  ["malformed page", 200, "RESPONSE_INVALID"],
])("reports %s as a failed profile row", async (_name, status, code) => {
  const transport: RawTransport = async () =>
    status === 200 ? body({ results: [{ ...detection, threat: "high" }], count: 1 }) : { status, bodyText: "{}" };
  const result = await doctor(["lab"], transport);
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({ count: "0 of 1 profiles ok", complete: false,
    profiles: [{ name: "lab", auth: "token", status: "failed", code }] });
  const help = (result.output as { help: string[] }).help;
  expect(help.some((hint) => hint.startsWith("[lab]"))).toBe(true);
});

it("reports an unreachable origin as a failed profile row", async () => {
  const transport: RawTransport = async () => {
    throw new Error("synthetic connection refused");
  };
  const result = await doctor(["lab"], transport);
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    profiles: [{ name: "lab", status: "failed", code: "TRANSPORT_FAILED" }] });
});

it("reports an unset token reference without any HTTP call", async () => {
  delete process.env.SENTINEL_TOKEN;
  let calls = 0;
  const transport: RawTransport = async () => {
    calls += 1;
    return body({ results: [detection], count: 1 });
  };
  const result = await doctor(["lab"], transport);
  expect(calls).toBe(0);
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({
    profiles: [{ name: "lab", status: "failed", code: "AUTH_REQUIRED" }] });
});

// Doctor never tries passwords, signs in interactively or enables writes:
// token profiles send only GETs to the documented detection route, and the
// only POST anywhere is the named OAuth exchange covered below.
it("sends only documented detection GETs for a token profile", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const transport: RawTransport = async (request) => {
    calls.push({ method: request.method, url: request.url });
    return body({ results: [detection], count: 1 });
  };
  await doctor(["lab"], transport);
  expect(calls).toEqual([{ method: "GET", url: "https://fixture.invalid/api/v2.5/detections" }]);
});

it("never emits the configured secret in its rows", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  const result = await doctor(["lab"], transport);
  expect(JSON.stringify(result.output)).not.toContain(token);
});

it("checks every profile when none is selected and fails when any fails", async () => {
  const transport: RawTransport = async (request) => request.url.startsWith("https://fixture.invalid")
    ? body({ results: [detection], count: 1 })
    : { status: 403, bodyText: "{}" };
  writeFileSync(path, JSON.stringify({ profiles: {
    lab: tokenProfile, other: { ...tokenProfile, origin: "https://other.invalid" } } }));
  const owned = loadConfig(path, new SecretRedactor());
  const result = await runDoctor({ loaded: owned, names: ["lab", "other"],
    redactor: new SecretRedactor(), transport });
  expect(result.failed).toBe(true);
  expect(result.output).toMatchObject({ count: "1 of 2 profiles ok", complete: false,
    profiles: [{ name: "lab", status: "ok" }, { name: "other", status: "failed", code: "ACCESS_DENIED" }] });
});

it("drives an OAuth profile through the named exchange before the bounded read", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const transport: RawTransport = async (request) => {
    calls.push({ method: request.method, url: request.url });
    if (request.method === "POST") {
      return { status: 200, bodyText: JSON.stringify(
        { access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 3600 }) };
    }
    return body({ results: [detection], count: 1 });
  };
  process.env.OAUTH_SECRET = "fake-oauth-secret-SENTINEL";
  try {
    writeFileSync(path, JSON.stringify({ profiles: { lab: { kind: "qux", origin: "https://fixture.invalid",
      apiVersion: "2.5", auth: "oauth", clientId: "synthetic-client", secretEnv: "OAUTH_SECRET" } } }));
    const owned = loadConfig(path, new SecretRedactor());
    const result = await runDoctor({ loaded: owned, names: ["lab"],
      redactor: new SecretRedactor(), transport });
    expect(calls).toEqual([
      { method: "POST", url: "https://fixture.invalid/api/v2.5/oauth2/token" },
      { method: "GET", url: "https://fixture.invalid/api/v2.5/detections" },
    ]);
    expect(result.failed).toBe(false);
  } finally {
    delete process.env.OAUTH_SECRET;
  }
});

const pair = { lab: tokenProfile, other: tokenProfile };
type TargetOptions = { setup: Record<string, unknown>; flag?: string; env?: string; defaults?: string };
it.each([
  ["explicit flag", { setup: pair, flag: "other" }, ["other"]],
  ["environment selection", { setup: pair, env: "other" }, ["other"]],
  ["configured default", { setup: pair, defaults: "other" }, ["other"]],
  ["sole profile", { setup: { lab: tokenProfile } }, ["lab"]],
  ["every profile without a selection", { setup: pair }, ["lab", "other"]],
] as Array<[string, TargetOptions, string[]]>)("targets %s", (_name, options, expected) => {
  const profiles = options.setup as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ profiles,
    ...(options.defaults === undefined ? {} : { defaultProfile: options.defaults }) }));
  const owned = loadConfig(path, new SecretRedactor());
  if (options.env !== undefined) process.env.VECTRA_AXI_PROFILE = options.env;
  expect(doctorTargets(owned.config, options.flag)).toEqual(expected);
});

// Target resolution throws before runDoctor starts, so an unconfigured
// doctor makes no HTTP call: there is no session to build one with.
it("requires configuration before any profile check", () => {
  writeFileSync(path, JSON.stringify({ profiles: {} }));
  const owned = loadConfig(path, new SecretRedactor());
  expect(() => doctorTargets(owned.config, undefined)).toThrowError("No profiles are configured");
});
