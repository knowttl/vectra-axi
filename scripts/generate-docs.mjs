// Regenerate PACK-01 release records from their single sources in src/.
// Usage: node scripts/generate-docs.mjs [--check]
// --check exits 1 when a committed file differs instead of rewriting it.
// Build first: this imports the compiled catalogue and inventory readers.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageDocument, skillCommandTable } from "../dist/src/docs.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(root, "skills", "vectra-axi", "SKILL.md");
const coveragePath = join(root, "docs", "coverage.md");
const start = "<!-- command-registry:start -->\n";
const end = "\n<!-- command-registry:end -->";

function withTable(skill, table) {
  const before = skill.split(start);
  if (before.length !== 2) throw new Error("SKILL.md is missing its command-registry markers");
  const after = before[1].split(end);
  if (after.length !== 2) throw new Error("SKILL.md is missing its command-registry markers");
  return `${before[0]}${start}${table}${end}${after[1]}`;
}

const check = process.argv.includes("--check");
const table = skillCommandTable();
const skill = withTable(readFileSync(skillPath, "utf8").replace(/\r\n/g, "\n"), table);
const coverage = coverageDocument();
if (check) {
  const stale = [
    ...(readFileSync(skillPath, "utf8").replace(/\r\n/g, "\n") === skill ? [] : [skillPath]),
    ...(readFileSync(coveragePath, "utf8").replace(/\r\n/g, "\n") === coverage ? [] : [coveragePath]),
  ];
  if (stale.length > 0) {
    process.stderr.write(`Stale generated docs: ${stale.join(", ")}. Run: node scripts/generate-docs.mjs\n`);
    process.exit(1);
  }
} else {
  writeFileSync(skillPath, skill);
  writeFileSync(coveragePath, coverage);
}
