import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AxiError } from "axi-sdk-js";

// Persisted hooks must outlive validation builds and disposable checkouts.
export function stableHookTarget(path: string): string {
  const target = realpathSync(path);
  const temporaryRoots = [tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"]
    .flatMap((root) => existsSync(root) ? [resolve(root), realpathSync(root)] : [resolve(root)]);
  for (const candidate of [resolve(path), target]) {
    const temporary = temporaryRoots.some((root) => {
      const child = relative(resolve(root), candidate);
      return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
    });
    const disposable = candidate.split(sep).some((part) =>
      [".no-mistakes", ".treehouse", ".worktrees", "worktrees", ".orca"].includes(part));
    let worktree = false;
    for (let dir = dirname(candidate); ; dir = dirname(dir)) {
      const git = join(dir, ".git");
      if (existsSync(git) && statSync(git).isFile()) worktree = true;
      if (dir === dirname(dir)) break;
    }
    if (temporary || disposable || worktree) {
      throw new AxiError("Refusing to install hooks from a temporary directory, worktree or pipeline build",
        "HOOK_INSTALL_FAILED", [
          "Install @knowttl/vectra-axi globally from a stable directory, then run vectra-axi setup hooks",
        ]);
    }
  }
  return target;
}
