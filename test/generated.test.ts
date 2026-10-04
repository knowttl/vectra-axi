import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogue, inventory } from "../src/catalogue.js";
import { coverageDocument, skillCommandTable } from "../src/docs.js";

const skill = readFileSync(new URL("../skills/vectra-axi/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const coverage = readFileSync(new URL("../docs/coverage.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("generated release records", () => {
  it("keeps the committed skill command table generated from the catalogue", () => {
    const block = skill.split("<!-- command-registry:start -->\n")[1]?.split("\n<!-- command-registry:end -->")[0];
    expect(block).toBe(skillCommandTable());
  });

  it("lists every executable leaf in the skill table exactly once", () => {
    const rows = skillCommandTable().split("\n").slice(2);
    expect(rows).toHaveLength(Object.keys(catalogue).length);
    expect(rows).toEqual(Object.keys(catalogue).map(
      (leaf) => `| \`vectra-axi ${leaf}\` | native | read |`));
  });

  it("keeps the committed coverage record generated from the inventory", () => {
    expect(coverage).toBe(coverageDocument());
  });

  it("calls the release the supported QUX SOC read surface, not full coverage", () => {
    expect(coverage).toContain("the supported QUX SOC read surface, not full Vectra API coverage");
    expect(coverage).not.toMatch(/\d+\s*% (complete|coverage)/);
  });

  it("marks only shipped read leaves as named operations", () => {
    const named = inventory.operations.filter((operation) => operation.disposition === "named");
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((operation) => operation.effect === "read")).toBe(true);
    const counts = Object.fromEntries(["named", "planned", "blocked"].map((disposition) => [
      disposition,
      inventory.operations.filter((operation) => operation.disposition === disposition).length,
    ]));
    for (const [disposition, total] of Object.entries(counts)) {
      expect(coverage).toContain(`- ${disposition}: ${total}`);
    }
  });

});
