import { encode } from "@toon-format/toon";
import { loadConfig } from "./profiles.js";

// Session-start ambient summary behind the vectra-axi-hook entry point.
// Local configuration state only: every configured profile name with its
// qux/rux kind and effective write posture, the package version and one
// next-step hint. No session, transport, OAuth exchange or network call of
// any kind; every failure collapses to a short line with exit code 0, so a
// missing or broken config never fails loudly at session start.

// The forced-read-only switch is owned by src/writes.ts (READ_ONLY_ENV);
// it is mirrored here so this summary stays off the session and mutation
// import graph. test/hook.test.ts pins the name and behavior together.
const READ_ONLY_ENV_MIRROR = "VECTRA_AXI_READ_ONLY";

export type HookOptions = {
  version: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
};

// Next-step hints name real catalogue leaves; test/hook.test.ts asserts
// every `vectra-axi ...` command mentioned here exists in the catalogue, so
// the hook text cannot drift from the single source.
const CONFIGURED_HINT = "Run vectra-axi doctor --profile <name> to check a profile";
const SETUP_HINT = "Run vectra-axi setup to find the config path and example";

export function hookSummary(options: HookOptions): string {
  try {
    return renderHookSummary(options);
  } catch {
    return "vectra: status unavailable\n";
  }
}

function renderHookSummary({ version, env = process.env, configPath }: HookOptions): string {
  let loaded;
  try {
    loaded = loadConfig(configPath ?? env.VECTRA_AXI_CONFIG, undefined);
  } catch {
    return `${encode({ vectra: "configuration invalid",
      help: ["Check the selected config file's path, permissions and JSON syntax"] })}\n`;
  }
  const names = Object.keys(loaded.config.profiles);
  if (names.length === 0) {
    return `${encode({ vectra: "not configured", help: [SETUP_HINT] })}\n`;
  }
  const forced = env[READ_ONLY_ENV_MIRROR] === "1";
  return `${encode({
    vectra: "configured",
    version,
    profiles: names.map((name) => {
      const profile = loaded.config.profiles[name]!;
      return { name, kind: profile.kind,
        writes: !forced && profile.writes?.allowWrites === true ? profile.writes.operations.join(",") : "disabled" };
    }),
    help: [CONFIGURED_HINT],
  })}\n`;
}
