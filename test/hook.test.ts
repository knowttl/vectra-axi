import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/catalogue.js";
import { hookSummary } from "../src/hook.js";
import { READ_ONLY_ENV, readOnlyForced } from "../src/writes.js";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(root, ".hook-test-"));
const preload = pathToFileURL(join(root, "dist/test/network-guard.js")).href;
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

const quxProfile = { kind: "qux", origin: "https://qux.fixture.invalid", apiVersion: "2.5",
  auth: "token", tokenEnv: "SENTINEL_TOKEN" };
const quxWritesProfile = { ...quxProfile, writes: { allowWrites: true, operations: ["qux.host.tag.set"] } };
const ruxProfile = { kind: "rux", origin: "https://cloud.fixture.invalid", apiVersion: "3.4",
  auth: "oauth", clientId: "synthetic-client", secretEnv: "SENTINEL_SECRET" };

const emptyConfig = writeConfig("empty.json", { profiles: {} });
const mixedConfig = writeConfig("mixed.json", { profiles: { lab: quxWritesProfile, cloud: ruxProfile } });
const writesConfig = writeConfig("writes.json", { profiles: { lab: quxWritesProfile } });

function writeConfig(name: string, config: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function hookEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}

describe("hookSummary", () => {
  it("reports unconfigured with one setup hint when no profiles exist", () => {
    const out = hookSummary({ version, configPath: emptyConfig });
    expect(out).toContain("not configured");
    expect(out).toContain("vectra-axi setup");
  });

  it("summarizes configured profile names, kinds, posture, version and one hint", () => {
    const out = hookSummary({ version, configPath: mixedConfig });
    expect(out).toContain("configured");
    expect(out).toContain(version);
    expect(out).toContain("lab");
    expect(out).toContain("qux");
    expect(out).toContain("qux.host.tag.set");
    expect(out).toContain("cloud");
    expect(out).toContain("rux");
    expect(out).toContain("disabled");
    expect(out).toContain("vectra-axi doctor");
  });

  it("reports configuration invalid for malformed or missing files", () => {
    const malformed = join(scratch, "malformed.json");
    writeFileSync(malformed, "{not json");
    expect(hookSummary({ version, configPath: malformed })).toContain("configuration invalid");
    expect(hookSummary({ version, configPath: join(scratch, "absent.json") }))
      .toContain("configuration invalid");
  });

  it("never prints secret values", () => {
    vi.stubEnv("SENTINEL_TOKEN", "hook-token-SENTINEL");
    vi.stubEnv("SENTINEL_SECRET", "hook-secret-SENTINEL");
    const out = hookSummary({ version, configPath: mixedConfig });
    expect(out).not.toContain("hook-token-SENTINEL");
    expect(out).not.toContain("hook-secret-SENTINEL");
  });

  it("mirrors the forced-read-only switch owned by writes.ts", () => {
    for (const value of ["1", "0", "", undefined]) {
      const env = value === undefined ? {} : { [READ_ONLY_ENV]: value };
      expect(readOnlyForced(env)).toBe(value === "1");
      const out = hookSummary({ version, env: hookEnv(env), configPath: writesConfig });
      expect(out).toContain(readOnlyForced(env) ? "disabled" : "qux.host.tag.set");
    }
  });

  it("names only real catalogue leaves in its hints", () => {
    for (const leaf of ["doctor", "setup"]) expect(catalogue).toHaveProperty(leaf);
    expect(hookSummary({ version, configPath: mixedConfig })).toContain("vectra-axi doctor");
    expect(hookSummary({ version, configPath: emptyConfig })).toContain("vectra-axi setup");
  });
});

describe("vectra-axi-hook entry point", () => {
  const bin = join(root, "bin", "vectra-axi-hook.js");

  function invoke(extraEnv: Record<string, string> = {}) {
    const home = mkdtempSync(join(scratch, "home-"));
    return spawnSync(process.execPath, [bin], {
      cwd: home,
      env: { HOME: home, USERPROFILE: home, NODE_OPTIONS: `--import=${preload}`,
        SystemRoot: process.env.SystemRoot ?? "", ...extraEnv },
      encoding: "utf8", input: "", timeout: 5_000,
    });
  }

  it("prints a short not-configured line with exit 0 and empty stderr when unconfigured", () => {
    const result = invoke();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("not configured");
    expect(result.stdout.split("\n").filter((line) => line.trim()).length).toBeLessThanOrEqual(4);
  });

  it("prints the configured summary offline with exit 0 and no secrets", () => {
    const result = invoke({ VECTRA_AXI_CONFIG: mixedConfig,
      SENTINEL_TOKEN: "hook-token-SENTINEL", SENTINEL_SECRET: "hook-secret-SENTINEL" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const fragment of ["configured", version, "lab", "qux", "cloud", "rux",
      "qux.host.tag.set", "disabled", "vectra-axi doctor"]) {
      expect(result.stdout).toContain(fragment);
    }
    expect(result.stdout).not.toContain("hook-token-SENTINEL");
    expect(result.stdout).not.toContain("hook-secret-SENTINEL");
  });
});

describe("vectra-axi setup hooks", () => {
  const bin = join(root, "bin", "vectra-axi.js");

  function invoke(args: string[], home: string) {
    return spawnSync(process.execPath, [bin, ...args], {
      cwd: home,
      env: { HOME: home, USERPROFILE: home, NODE_OPTIONS: `--import=${preload}`,
        SystemRoot: process.env.SystemRoot ?? "" },
      encoding: "utf8", input: "", timeout: 10_000,
    });
  }

  it("shows help offline without installing anything", () => {
    const home = mkdtempSync(join(scratch, "help-home-"));
    const result = invoke(["setup", "hooks", "--help"], home);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("vectra-axi setup hooks");
  });

  it("installs session hooks idempotently", () => {
    const home = mkdtempSync(join(scratch, "install-home-"));
    mkdirSync(home, { recursive: true });
    const first = invoke(["setup", "hooks"], home);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("installed");
    const claude = join(home, ".claude", "settings.json");
    const codex = join(home, ".codex", "hooks.json");
    const plugin = join(home, ".config", "opencode", "plugins", "axi-vectra-axi-hook.js");
    for (const path of [claude, codex, plugin]) {
      expect(readFileSync(path, "utf8")).toContain("vectra-axi-hook");
    }
    const before = [claude, codex, plugin].map((path) => readFileSync(path, "utf8"));
    const second = invoke(["setup", "hooks"], home);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
    expect([claude, codex, plugin].map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });
});
