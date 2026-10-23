import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { catalogue, help, inventory, listPaging, parseInvocation } from "../src/catalogue.js";
import { commandDocument, commandSummary, coverageDocument, skillCommandTable } from "../src/docs.js";

const skill = readFileSync(new URL("../skills/vectra-axi/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const coverage = readFileSync(new URL("../docs/coverage.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("generated release records", () => {
  it("keeps the published command reference and README summary current", () => {
    const commands = readFileSync(new URL("../docs/commands.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(commands).toBe(commandDocument());
    expect(readme.split("<!-- command-registry:start -->\n")[1]?.split("\n<!-- command-registry:end -->")[0])
      .toBe(commandSummary());
  });
  it.each(Object.keys(catalogue).filter((leaf) => leaf.endsWith(" list")))
  ("inventories the pagination contract of %s", (leaf) => {
    expect(listPaging(leaf)).toBeTruthy();
    expect(help(leaf).pagination).toBe(listPaging(leaf));
    const operations = inventory.operations.filter((operation) =>
      operation.command === leaf && operation.disposition === "named");
    for (const operation of operations) {
      expect(listPaging(leaf)).toContain(operation.deployment.toUpperCase());
      expect(listPaging(leaf)).toContain(operation.paging === "none" ? "nonpaged" : operation.paging.replace("-", " "));
    }
    if (operations.some((operation) => operation.paging === "collection")) {
      expect(parseInvocation([...leaf.split(" "), "--all"]).flags.has("all")).toBe(true);
      expect(() => parseInvocation([...leaf.split(" "), "--all", "--limit", "1"]))
        .toThrow("--all cannot be combined with --limit");
    } else {
      expect(() => parseInvocation([...leaf.split(" "), "--all"])).toThrow("Unknown flag");
    }
  });

  it.each([...new Set(inventory.operations
    .filter((operation) => operation.disposition === "named" && operation.id.startsWith("rux."))
    .map((operation) => operation.command!))])("does not label %s QUX-only when it supports RUX", (leaf) => {
    expect(help(leaf).description).not.toMatch(/^(?!.*\bRUX\b).*\bQUX\b/);
  });

  it.each([...new Set(inventory.operations
    .filter((operation) => operation.disposition === "named" && operation.command)
    .map((operation) => operation.command!))]
    .filter((leaf) => !inventory.operations.some((operation) =>
      operation.disposition === "named" && operation.command === leaf && operation.deployment === "rux")))
  ("keeps QUX-only deployment wording in %s help", (leaf) => {
    expect(help(leaf).description).toMatch(/\bQUX\b/);
    expect(help(leaf).description).not.toMatch(/\bRUX\b/);
  });

  it.each(["detection event list", "entity scoring list"])("keeps %s RUX-only", (leaf) => {
    expect(help(leaf).description).toMatch(/\bRUX\b/);
    expect(help(leaf).description).not.toMatch(/\bQUX\b/);
  });

  it("retains deployment-specific entity filters and member release requirements", () => {
    expect(help("entity list").description).toContain("score filters are QUX-only");
    expect(help("group member list").description).toContain("QUX v2.5 (appliance 9.2+)");
    expect(help("group member list").description).toContain("RUX v3.4");
    expect(help("user list").description).toContain("username filtering is QUX-only");
  });

  it("keeps skill discovery frontmatter valid for loaders", () => {
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    expect(frontmatter).toBeDefined();
    const metadata = parse(frontmatter!);
    expect(metadata.name).toBe("vectra-axi");
    expect(typeof metadata.description).toBe("string");
    expect(metadata.description.trim()).not.toBe("");
    expect(metadata["user-invocable"]).toBe(false);
  });
  it("keeps the committed skill command table generated from the catalogue", () => {
    const block = skill.split("<!-- command-registry:start -->\n")[1]?.split("\n<!-- command-registry:end -->")[0];
    expect(block).toBe(skillCommandTable());
  });

  it("lists every executable leaf in the skill table exactly once", () => {
    const rows = skillCommandTable().split("\n").slice(2);
    expect(rows).toHaveLength(Object.keys(catalogue).length);
    expect(rows).toEqual(Object.keys(catalogue).map((leaf) => {
      const lookup = leaf === "group member add" || leaf === "group member remove" ? "group member set" : leaf;
      const effect = inventory.operations.find((operation) => operation.command === lookup)?.effect ?? "read";
      return `| \`npx -y @knowttl/vectra-axi ${leaf}\` | native | ${effect} | ${listPaging(leaf) ?? "-"} |`;
    }));
  });

  it("keeps the committed coverage record generated from the inventory", () => {
    expect(coverage).toBe(coverageDocument());
  });

  it("keeps installed skill links public and README anchors valid", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const anchors = [...readme.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
      match[1]!.toLowerCase().replace(/[^\w -]/g, "").replace(/ /g, "-"));
    const links = [...skill.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toMatch(/^https:\/\//);
      if (link.includes("/README.md#")) expect(anchors).toContain(link.split("#")[1]);
    }
    expect(skill).not.toContain("src/catalogue.ts");
    expect(skill).not.toMatch(/`vectra-axi /);
    expect(skill).toContain("README.md#doctor");
    expect(skill).toContain("README.md#development--testing");
  });

  it("describes shipped QUX and RUX writes without claiming full API coverage", () => {
    expect(coverage).not.toMatch(/\d+\s*% (complete|coverage)/);
  });

  it("ships QUX/RUX note-append, tag, assignment and note edit/delete writes", () => {
    const named = inventory.operations.filter((operation) => operation.disposition === "named");
    const deploymentsFor = (suffix: string): string[] =>
      [...new Set(named.filter((operation) => operation.id.endsWith(suffix)).map((operation) => operation.deployment))].sort();
    for (const suffix of [".note.add", ".tag.set", ".tag.bulk-set", ".tag.bulk-delete", ".note.edit", ".note.delete",
      ".assignment.create", ".assignment.reassign", ".assignment.unassign"]) {
      expect(deploymentsFor(suffix)).toEqual(["qux", "rux"]);
    }
    expect(inventory.deferredFamilies.find((family) => family.id === "rux.later.note-writes")?.disposition).toBe("planned");
  });

  it("marks only shipped read leaves and the gated tag replaces, note appends and note edits/deletes as named operations", () => {
    const named = inventory.operations.filter((operation) => operation.disposition === "named");
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((operation) => ["read", "write", "disruptive"].includes(operation.effect))).toBe(true);
    const counts = Object.fromEntries(["named", "implemented", "planned", "blocked"].map((disposition) => [
      disposition,
      inventory.operations.filter((operation) => operation.disposition === disposition).length,
    ]));
    for (const [disposition, total] of Object.entries(counts)) {
      expect(coverage).toContain(`- ${disposition}: ${total}`);
    }
  });

});
