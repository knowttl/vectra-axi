import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SKILL_HINT_LINE, needsSkillHint } from "../src/skill-hint.js";

vi.mock("node:fs", { spy: true });

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const COMMAND = "npx skills add knowttl/vectra-axi --skill vectra-axi";

type TestCase = {
  name: string;
  env: Record<string, string>;
  installed?: string;
  systemSkill?: string;
  worktree?: string;
  hint: boolean;
};

const cases: TestCase[] = [
  { name: "Codex missing", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, hint: true },
  { name: "Codex global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.agents/skills", hint: false },
  { name: "Codex project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.agents/skills", hint: false },
  { name: "Codex native global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.codex/skills", hint: false },
  { name: "Codex custom native global", env: { CODEX_THREAD_ID: "thread", CODEX_HOME: "custom" }, installed: "custom/skills", hint: false },
  { name: "Codex bundled system", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.codex/skills/.system", hint: false },
  { name: "Codex custom bundled system", env: { CODEX_THREAD_ID: "thread", CODEX_HOME: "custom" }, installed: "custom/skills/.system", hint: false },
  { name: "Codex admin", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, systemSkill: "/etc/codex/skills/vectra-axi/SKILL.md", hint: false },
  { name: "Codex custom home replaces native default", env: { CODEX_THREAD_ID: "thread", CODEX_HOME: "custom" }, installed: "home/.codex/skills", hint: true },
  { name: "Claude missing", env: { CLAUDECODE: "1" }, installed: undefined, hint: true },
  { name: "Claude global", env: { CLAUDECODE: "1" }, installed: "home/.claude/skills", hint: false },
  { name: "Codex-only global install in Claude", env: { CLAUDECODE: "1" }, installed: "home/.agents/skills", hint: true },
  { name: "Claude project", env: { CLAUDECODE: "1" }, installed: "repo/.claude/skills", hint: false },
  { name: "Claude current directory", env: { CLAUDECODE: "1" }, installed: "repo/nested/.claude/skills", hint: false },
  { name: "Claude does not load descendants at startup", env: { CLAUDECODE: "1" }, installed: "repo/nested/child/.claude/skills", hint: true },
  { name: "Claude stops at repository root", env: { CLAUDECODE: "1" }, installed: ".claude/skills", hint: true },
  { name: "Codex-only project install in Claude", env: { CLAUDECODE: "1" }, installed: "repo/.agents/skills", hint: true },
  { name: "Claude custom global", env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "custom" }, installed: "custom/skills", hint: false },
  { name: "Claude custom home replaces native default", env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "custom" }, installed: "home/.claude/skills", hint: true },
  {
    name: "Claude managed enterprise", env: { CLAUDECODE: "1" }, installed: undefined, hint: false,
    systemSkill: join(process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
      : process.platform === "win32" ? join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode")
      : "/etc/claude-code", ".claude/skills/vectra-axi/SKILL.md"),
  },
  { name: "Claude ignores Codex admin", env: { CLAUDECODE: "1" }, installed: undefined, systemSkill: "/etc/codex/skills/vectra-axi/SKILL.md", hint: true },
  { name: "Claude ignores OpenCode global", env: { CLAUDECODE: "1" }, installed: "home/.config/opencode/skills", hint: true },
  { name: "Claude ignores OpenCode project", env: { CLAUDECODE: "1" }, installed: "repo/.opencode/skills", hint: true },
  { name: "Claude ignores Pi global", env: { CLAUDECODE: "1" }, installed: "home/.pi/agent/skills", hint: true },
  { name: "Claude ignores Pi project", env: { CLAUDECODE: "1" }, installed: "repo/.pi/skills", hint: true },
  { name: "Claude main checkout with relative metadata", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "relative", hint: false },
  { name: "Claude main checkout with absolute metadata", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "absolute", hint: false },
  { name: "Claude main checkout with absolute git pointer", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "absolute-pointer", hint: false },
  { name: "Claude main checkout with absolute common directory", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "absolute-common", hint: false },
  { name: "Claude empty local root blocks main checkout", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "local-root", hint: true },
  { name: "Claude installed local root", env: { CLAUDECODE: "1" }, installed: "repo/.claude/skills", worktree: "relative", hint: false },
  { name: "Claude nested install with empty local root", env: { CLAUDECODE: "1" }, installed: "repo/nested/.claude/skills", worktree: "local-root", hint: false },
  { name: "Claude missing common directory metadata", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "missing-common", hint: true },
  { name: "Claude empty common directory metadata", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "empty-common", hint: true },
  { name: "Claude invalid git pointer", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "invalid-pointer", hint: true },
  { name: "Claude main checkout without skill", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "missing-skill", hint: true },
  { name: "Codex ignores Claude main checkout", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, worktree: "relative", hint: true },
  { name: "OpenCode ignores Claude main checkout", env: { OPENCODE: "1" }, installed: undefined, worktree: "relative", hint: true },
  { name: "Pi ignores Claude main checkout", env: { PI_SESSION_ID: "session" }, installed: undefined, worktree: "relative", hint: true },
  { name: "OpenCode missing", env: { OPENCODE: "1" }, installed: undefined, hint: true },
  { name: "OpenCode shared global", env: { OPENCODE: "1" }, installed: "home/.agents/skills", hint: false },
  { name: "OpenCode project", env: { OPENCODE: "1" }, installed: "repo/.agents/skills", hint: false },
  { name: "OpenCode shared current directory", env: { OPENCODE: "1" }, installed: "repo/nested/.agents/skills", hint: false },
  { name: "OpenCode stops at repository root", env: { OPENCODE: "1" }, installed: ".opencode/skills", hint: true },
  { name: "OpenCode native global", env: { OPENCODE: "1" }, installed: "home/.config/opencode/skills", hint: false },
  { name: "OpenCode XDG global", env: { OPENCODE: "1", XDG_CONFIG_HOME: "custom" }, installed: "custom/opencode/skills", hint: false },
  { name: "OpenCode config directory", env: { OPENCODE: "1", OPENCODE_CONFIG_DIR: "custom" }, installed: "custom/skills", hint: false },
  { name: "OpenCode config directory keeps global roots", env: { OPENCODE: "1", OPENCODE_CONFIG_DIR: "custom" }, installed: "home/.config/opencode/skills", hint: false },
  { name: "OpenCode native project", env: { OPENCODE: "1" }, installed: "repo/.opencode/skills", hint: false },
  { name: "OpenCode native current directory", env: { OPENCODE: "1" }, installed: "repo/nested/.opencode/skills", hint: false },
  { name: "OpenCode Claude global", env: { OPENCODE: "1" }, installed: "home/.claude/skills", hint: false },
  { name: "OpenCode Claude project", env: { OPENCODE: "1" }, installed: "repo/.claude/skills", hint: false },
  { name: "OpenCode Claude current directory", env: { OPENCODE: "1" }, installed: "repo/nested/.claude/skills", hint: false },
  { name: "OpenCode ignores Codex native global", env: { OPENCODE: "1" }, installed: "home/.codex/skills", hint: true },
  { name: "OpenCode ignores Pi global", env: { OPENCODE: "1" }, installed: "home/.pi/agent/skills", hint: true },
  { name: "OpenCode ignores Pi project", env: { OPENCODE: "1" }, installed: "repo/.pi/skills", hint: true },
  { name: "Pi missing", env: { PI_SESSION_ID: "session" }, installed: undefined, hint: true },
  { name: "Pi global", env: { PI_SESSION_ID: "session" }, installed: "home/.agents/skills", hint: false },
  { name: "Pi project", env: { PI_SESSION_ID: "session" }, installed: "repo/.agents/skills", hint: false },
  { name: "Pi shared current directory", env: { PI_SESSION_ID: "session" }, installed: "repo/nested/.agents/skills", hint: false },
  { name: "Pi stops at repository root", env: { PI_SESSION_ID: "session" }, installed: ".agents/skills", hint: true },
  { name: "Pi native global", env: { PI_SESSION_ID: "session" }, installed: "home/.pi/agent/skills", hint: false },
  { name: "Pi native current directory", env: { PI_SESSION_ID: "session" }, installed: "repo/nested/.pi/skills", hint: false },
  { name: "Pi native ancestor is not loaded", env: { PI_SESSION_ID: "session" }, installed: "repo/.pi/skills", hint: true },
  { name: "Pi custom native global", env: { PI_SESSION_ID: "session", PI_CODING_AGENT_DIR: "custom" }, installed: "custom/skills", hint: false },
  { name: "Pi tilde native global", env: { PI_SESSION_ID: "session", PI_CODING_AGENT_DIR: "~/pi-custom" }, installed: "home/pi-custom/skills", hint: false },
  { name: "Pi custom home replaces native default", env: { PI_SESSION_ID: "session", PI_CODING_AGENT_DIR: "custom" }, installed: "home/.pi/agent/skills", hint: true },
  { name: "Pi ignores Codex native global", env: { PI_SESSION_ID: "session" }, installed: "home/.codex/skills", hint: true },
  { name: "Pi ignores Claude global", env: { PI_SESSION_ID: "session" }, installed: "home/.claude/skills", hint: true },
  { name: "Pi ignores Claude project", env: { PI_SESSION_ID: "session" }, installed: "repo/.claude/skills", hint: true },
  { name: "Pi ignores OpenCode global", env: { PI_SESSION_ID: "session" }, installed: "home/.config/opencode/skills", hint: true },
  { name: "Pi ignores OpenCode project", env: { PI_SESSION_ID: "session" }, installed: "repo/.opencode/skills", hint: true },
  { name: "no host", env: {}, installed: undefined, hint: false },
  { name: "another host's install", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.claude/skills", hint: true },
  { name: "Codex ignores Claude project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.claude/skills", hint: true },
  { name: "Codex ignores OpenCode global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.config/opencode/skills", hint: true },
  { name: "Codex ignores OpenCode project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.opencode/skills", hint: true },
  { name: "Codex ignores Pi global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.pi/agent/skills", hint: true },
  { name: "Codex ignores Pi project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.pi/skills", hint: true },
  { name: "outside repository", env: { CODEX_THREAD_ID: "thread" }, installed: ".agents/skills", hint: true },
  { name: "current directory", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/nested/.agents/skills", hint: false },
];

describe("the skill-install hint", () => {
  it("shows the exact install command once", () => {
    expect(SKILL_HINT_LINE).toContain(`\`${COMMAND}\``);
    expect(SKILL_HINT_LINE.match(/npx skills add/g)).toHaveLength(1);
  });

  it.each(cases)("detects the installed skill per host: $name", ({ env, installed, hint, ...testCase }) => {
    const root = mkdtempSync(join(tmpdir(), "vectra-axi-skill-hint-"));
    const cwd = join(root, "repo/nested");
    const home = join(root, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home);
    // A worktree's .git entry is a file, not a directory.
    writeFileSync(join(root, "repo/.git"), "gitdir: unused");
    if ("worktree" in testCase && testCase.worktree !== undefined) {
      const gitDirectory = join(root, "main/.git/worktrees/linked");
      mkdirSync(gitDirectory, { recursive: true });
      writeFileSync(join(root, "repo/.git"), testCase.worktree === "invalid-pointer" ? "invalid"
        : `gitdir: ${testCase.worktree === "absolute" || testCase.worktree === "absolute-pointer"
          ? gitDirectory : "../main/.git/worktrees/linked"}\n`);
      if (testCase.worktree !== "missing-common") {
        writeFileSync(join(gitDirectory, "commondir"), testCase.worktree === "empty-common" ? "\n"
          : `${testCase.worktree === "absolute" || testCase.worktree === "absolute-common"
            ? join(root, "main/.git") : "../.."}\n`);
      }
      if (testCase.worktree !== "missing-skill") {
        const directory = join(root, "main/.claude/skills/vectra-axi");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "SKILL.md"), "installed skill");
      }
      if (testCase.worktree === "local-root") mkdirSync(join(root, "repo/.claude/skills"), { recursive: true });
    }
    if (installed !== undefined) {
      const directory = join(root, installed, "vectra-axi");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), "installed skill");
    }
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation(((path: unknown) => {
      if (typeof path === "string" && !path.startsWith(`${root}${sep}`)) {
        return "systemSkill" in testCase && path === testCase.systemSkill;
      }
      return realFs.existsSync(path as string);
    }) as typeof fs.existsSync);
    try {
      expect(needsSkillHint({
        ...env,
        HOME: home,
        ...(process.env.ProgramFiles ? { ProgramFiles: process.env.ProgramFiles } : {}),
        ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: join(root, env.CLAUDE_CONFIG_DIR) } : {}),
        ...(env.CODEX_HOME ? { CODEX_HOME: join(root, env.CODEX_HOME) } : {}),
        ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: join(root, env.XDG_CONFIG_HOME) } : {}),
        ...(env.OPENCODE_CONFIG_DIR ? { OPENCODE_CONFIG_DIR: join(root, env.OPENCODE_CONFIG_DIR) } : {}),
        ...(env.PI_CODING_AGENT_DIR ? {
          PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR.startsWith("~")
            ? env.PI_CODING_AGENT_DIR : join(root, env.PI_CODING_AGENT_DIR),
        } : {}),
      } as NodeJS.ProcessEnv)).toBe(hint);
    } finally {
      existsSpy.mockRestore();
      cwdSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still renders home when the working directory cannot be read", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("working directory removed");
    });
    try {
      expect(needsSkillHint({ CODEX_THREAD_ID: "thread", HOME: "/missing-vectra-axi-test-home" } as NodeJS.ProcessEnv))
        .toBe(false);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
