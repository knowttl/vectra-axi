import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, renameSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it } from "vitest";

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
  expect(result.stdout).toContain("api: No API operations are implemented");
  expect(result.stderr).toBe("");
  expect(readdirSync(home)).toEqual([]);
});

it.each([{ path: [] }, { path: ["home"] }, { path: ["setup"] }])("provides offline help for $path", ({ path }) => {
  const result = invoke([...path, "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("examples[");
  expect(result.stdout).toContain('"--help": Show concise help; default false');
  expect(result.stdout).toContain('"--profile <name>": "Select a profile by name');
  expect(result.stdout).toContain("--help cannot be combined with --profile");
  expect(result.stdout).not.toContain("detection list");
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
  ["duplicate selector", ["home", "--profile=lab", "--profile=other"], "Repeated flag"],
  ["boolean value", ["setup", "--help=false"], "does not accept a value"],
  ["positional input", ["setup", "extra"], "Unexpected argument"],
  ["literal help", ["setup", "--", "--help"], "Unknown flag: --"],
  ["planned endpoint", ["detection", "list"], "Unknown command: detection"],
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
  expect(result.stdout).toContain("Available commands: home, setup");
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
