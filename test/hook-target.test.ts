import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { stableHookTarget } from "../src/hook-target.js";
import { main } from "../src/cli.js";

const filesystem = vi.hoisted(() => ({ target: "", worktree: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const { join, resolve, sep } = await import("node:path");
  const base = resolve("/opt/vectra");
  return { ...fs,
    realpathSync: (path: string) => path.startsWith(`${resolve("/opt")}${sep}`)
      ? filesystem.target || path : fs.realpathSync(path),
    existsSync: (path: string) => path === join(base, ".git") ? filesystem.worktree
      : path === join(base, "bin/vectra-axi-hook.js") || fs.existsSync(path),
    statSync: (path: string) => path === join(base, ".git") ? { isFile: () => true } : fs.statSync(path),
  };
});

const target = resolve("/opt/vectra/bin/vectra-axi-hook.js");
const scratch = mkdtempSync(join(import.meta.dirname, "../.cli-test-hook-target-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  filesystem.target = "";
  filesystem.worktree = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("stableHookTarget", () => {
  it("accepts a stable installed package", () => {
    expect(stableHookTarget(target)).toBe(target);
  });

  it.each([
    "/tmp/vectra/bin/vectra-axi-hook.js",
    "/var/tmp/vectra/bin/vectra-axi-hook.js",
    "/home/fixture/.no-mistakes/builds/123/bin/vectra-axi-hook.js",
    "/home/fixture/.treehouse/vectra/1/bin/vectra-axi-hook.js",
    "/home/fixture/.worktrees/vectra/bin/vectra-axi-hook.js",
  ])("rejects a stable-looking symlink to %s", (resolved) => {
    filesystem.target = resolve(resolved);
    expect(() => stableHookTarget(target)).toThrow("Refusing to install hooks");
  });

  it("rejects a linked Git worktree at an arbitrary location", () => {
    filesystem.worktree = true;
    expect(() => stableHookTarget(target)).toThrow("Refusing to install hooks");
  });

  it("rejects the configured temporary directory outside the system defaults", () => {
    vi.stubEnv("TMPDIR", "/home/fixture/custom-temp");
    vi.stubEnv("TMP", "/home/fixture/custom-temp");
    vi.stubEnv("TEMP", "/home/fixture/custom-temp");
    filesystem.target = resolve("/home/fixture/custom-temp/vectra/bin/vectra-axi-hook.js");
    expect(() => stableHookTarget(target)).toThrow("Refusing to install hooks");
  });

  it("does not confuse a sibling of a temporary root with that root", () => {
    filesystem.target = resolve("/tmp-packages/vectra/bin/vectra-axi-hook.js");
    expect(stableHookTarget(target)).toBe(filesystem.target);
  });
});

it("installs stable hooks idempotently in the isolated home", async () => {
  const home = join(scratch, "home");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("XDG_DATA_HOME", join(home, ".local/share"));
  vi.stubEnv("XDG_CACHE_HOME", join(home, ".cache"));
  vi.stubEnv("XDG_STATE_HOME", join(home, ".local/state"));
  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, resolve("/opt/vectra/bin/vectra-axi.js")]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await main(["setup", "hooks"]);
  const paths = [join(home, ".claude/settings.json"), join(home, ".codex/hooks.json"),
    join(home, ".codex/config.toml"), join(home, ".config/opencode/plugins/axi-vectra-axi-hook.js")];
  const before = paths.map((path) => readFileSync(path, "utf8"));
  expect(before.every((content) => content.includes("vectra-axi-hook") || content.includes("hooks = true"))).toBe(true);
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("installed"));
  await main(["setup", "hooks"]);
  expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
});
