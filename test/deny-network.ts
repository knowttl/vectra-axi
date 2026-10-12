import "./network-guard.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";

// Config fixtures must be private even on hosts with a group-writable umask.
process.umask(0o077);

// The suite must never discover the invoking account's configuration.
const home = mkdtempSync(join(import.meta.dirname, ".test-home-"));
Object.assign(process.env, {
  HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
  APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"),
});
for (const key of Object.keys(process.env)) if (key.startsWith("VECTRA_AXI_")) delete process.env[key];
afterAll(() => rmSync(home, { recursive: true, force: true }));
