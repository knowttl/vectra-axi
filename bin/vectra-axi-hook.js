#!/usr/bin/env node
import { VERSION } from "./version.js";

// Session-start hook entry point: print the local-only ambient summary and
// always exit 0, never loudly, so agent startup never breaks on config state.
try {
  const { hookSummary } = await import("../dist/src/hook.js");
  process.stdout.write(hookSummary({ version: VERSION }));
} catch {
  process.stdout.write("vectra: status unavailable\n");
}
process.exitCode = 0;
