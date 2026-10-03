import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, renameSync, readdirSync } from "node:fs";
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

function invoke(args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: home, env, encoding: "utf8", input: "", timeout: 5_000,
  });
}

it.each(["-v", "-V", "--version"])("prints only the package version for %s", (flag) => {
  const result = invoke([flag]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${version}\n`);
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
  ["conflicting help and selector", ["home", "--profile=lab", "--help"], "cannot be combined"],
  ["missing selector value", ["home", "--profile"], "requires a non-empty value"],
  ["duplicate selector", ["home", "--profile=lab", "--profile=other"], "Repeated flag"],
  ["boolean value", ["setup", "--help=false"], "does not accept a value"],
  ["positional input", ["setup", "extra"], "Unexpected argument"],
  ["literal help", ["setup", "--", "--help"], "Unknown flag: --"],
  ["planned endpoint", ["detection", "list"], "Unknown command: detection"],
  ["SDK update", ["update"], "Unknown command: update"],
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
