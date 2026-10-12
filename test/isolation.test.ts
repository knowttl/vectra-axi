import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const outerHome = mkdtempSync(join(root, ".cli-test-outer-home-"));
afterAll(() => rmSync(outerHome, { recursive: true, force: true }));

it("keeps test subprocess writes out of the invoking HOME and XDG directories", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts/isolated.mjs"), process.execPath, "-e", `
    const fs = require('node:fs');
    const path = require('node:path');
    const home = require('node:os').homedir();
    for (const dir of [path.join(home, '.claude'), path.join(home, '.codex'),
      process.env.USERPROFILE, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME,
      process.env.XDG_CACHE_HOME, process.env.XDG_STATE_HOME]) {
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'test-write'), 'sentinel');
    }
    console.log(home);
  `], { env: { ...process.env, HOME: outerHome, USERPROFILE: outerHome,
    XDG_CONFIG_HOME: join(outerHome, "config"), XDG_DATA_HOME: join(outerHome, "data"),
    XDG_CACHE_HOME: join(outerHome, "cache"), XDG_STATE_HOME: join(outerHome, "state") }, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).not.toBe(outerHome);
  expect(existsSync(result.stdout.trim())).toBe(false);
  for (const path of ["test-write", ".claude", ".codex", "config", "data", "cache", "state"]) {
    expect(existsSync(join(outerHome, path))).toBe(false);
  }
});
