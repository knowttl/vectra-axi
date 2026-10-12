import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "vectra-axi-validation-"));
try {
  const [command, ...args] = process.argv.slice(2);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state") },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
