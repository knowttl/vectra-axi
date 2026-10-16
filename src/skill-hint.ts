import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// One-line skill-install hint for the no-argument home view. The hint shows
// only when vectra-axi runs bare inside a recognized agent host whose own
// skill folders contain no vectra-axi skill; every other command, help text
// and machine-readable output stays byte-identical.
export const SKILL_HINT_LINE =
  "Install the Vectra skill: `npx skills add knowttl/vectra-axi --skill vectra-axi`";

// Per-host skill roots. Each entry names a skill-folder root plus the scope
// it is searched with: user-system roots are checked as-is, ancestors roots
// are checked from the working directory upward to the repository root, cwd
// roots only in the working directory itself, and main-checkout roots in the
// linked-worktree main checkout when the local repository root has no such
// folder. Only a direct `<tool>/SKILL.md` child counts; folders listed in
// host settings files and recursive nested layouts are a documented
// limitation and still show the hint.
export function needsSkillHint(env: NodeJS.ProcessEnv): boolean {
  const host = env.CODEX_THREAD_ID ? "codex"
    : env.PI_SESSION_ID ? "pi"
    : env.OPENCODE === "1" ? "opencode"
    : env.CLAUDECODE === "1" ? "claude" : undefined;
  if (host === undefined) return false;

  try {
    const home = env.HOME || homedir();
    const skill = "vectra-axi/SKILL.md";
    const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
    const managedDirectory = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
      : process.platform === "win32" ? join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode")
      : "/etc/claude-code";
    // https://github.com/vercel-labs/skills/blob/main/src/agents.ts
    const roots: Record<typeof host, { path: string; scope: "user-system" | "cwd" | "ancestors" | "main-checkout" }[]> = {
      // https://developers.openai.com/codex/skills/#where-to-save-skills
      codex: [
        { path: join(home, ".agents/skills"), scope: "user-system" },
        { path: join(codexHome, "skills"), scope: "user-system" },
        { path: join(codexHome, "skills/.system"), scope: "user-system" },
        { path: "/etc/codex/skills", scope: "user-system" },
        { path: ".agents/skills", scope: "ancestors" },
      ],
      // https://code.claude.com/docs/en/skills#where-skills-live
      // https://code.claude.com/docs/en/managed-settings#delivery-mechanisms
      claude: [
        { path: join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "skills"), scope: "user-system" },
        { path: join(managedDirectory, ".claude/skills"), scope: "user-system" },
        { path: ".claude/skills", scope: "ancestors" },
        { path: ".claude/skills", scope: "main-checkout" },
      ],
      // https://opencode.ai/docs/skills/#place-files
      // https://opencode.ai/docs/config/#custom-directory
      opencode: [
        { path: join(home, ".agents/skills"), scope: "user-system" },
        { path: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode/skills"), scope: "user-system" },
        { path: join(home, ".claude/skills"), scope: "user-system" },
        ...(env.OPENCODE_CONFIG_DIR
          ? [{ path: join(env.OPENCODE_CONFIG_DIR, "skills"), scope: "user-system" as const }] : []),
        { path: ".agents/skills", scope: "ancestors" },
        { path: ".opencode/skills", scope: "ancestors" },
        { path: ".claude/skills", scope: "ancestors" },
      ],
      // https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/package-manager.ts
      pi: [
        { path: join(home, ".agents/skills"), scope: "user-system" },
        {
          path: join((env.PI_CODING_AGENT_DIR || join(home, ".pi/agent")).replace(/^~(?=\/|$)/, () => home), "skills"),
          scope: "user-system",
        },
        { path: ".agents/skills", scope: "ancestors" },
        { path: ".pi/skills", scope: "cwd" },
      ],
    };
    if (roots[host].some((root) => root.scope === "user-system" && existsSync(join(root.path, skill)))) return false;

    const cwd = process.cwd();
    // Stop at .git files as well as directories, including disposable worktrees.
    for (let directory = cwd; ; directory = dirname(directory)) {
      if (roots[host].some((root) => (root.scope === "ancestors" || (root.scope === "cwd" && directory === cwd))
        && existsSync(join(directory, root.path, skill)))) return false;
      if (existsSync(join(directory, ".git"))) {
        const fallbackRoots = roots[host].filter((root) => root.scope === "main-checkout"
          && !existsSync(join(directory, root.path)));
        if (fallbackRoots.length > 0) {
          const checkout = mainCheckout(directory);
          if (checkout && fallbackRoots.some((root) => existsSync(join(checkout, root.path, skill)))) return false;
        }
        break;
      }
      if (dirname(directory) === directory) break;
    }
    return true;
  } catch {
    // Discovery must never prevent the home view from rendering.
    return false;
  }
}

// Resolve the main checkout of a linked worktree through its .git pointer
// and the common directory record; anything unreadable means no fallback.
function mainCheckout(worktree: string): string | undefined {
  try {
    const pointer = /^gitdir:\s*(.+)$/.exec(readFileSync(join(worktree, ".git"), "utf8").trim());
    if (!pointer) return undefined;
    const gitDirectory = resolve(worktree, pointer[1]!);
    const commonDirectory = readFileSync(join(gitDirectory, "commondir"), "utf8").trim();
    return commonDirectory ? dirname(resolve(gitDirectory, commonDirectory)) : undefined;
  } catch {
    return undefined;
  }
}
