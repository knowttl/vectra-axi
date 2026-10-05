#!/usr/bin/env node

// Session-start hook entry point: print the local-only ambient summary and
// always exit 0, never loudly, so agent startup never breaks on config state.
try {
  const { VERSION } = await import("./version.js").catch(() => ({ VERSION: "unknown" }));
  const { hookSummary } = await import("../dist/src/hook.js");
  process.stdout.write(hookSummary({ version: VERSION }));
} catch {
  process.stdout.write("vectra: status unavailable\n");
}
process.exitCode = 0;
