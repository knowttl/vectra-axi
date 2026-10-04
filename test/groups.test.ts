import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { BENIGN_DISCLAIMER, GROUP_LIST_FIELDS, groupQuery, listFields, listLimit,
  MEMBER_LIST_FIELDS, memberQuery, RULE_LIST_FIELDS, ruleQuery,
  runGroupList, runGroupMemberList, runGroupShow, runRuleList, runRuleShow,
  groupId, ruleId } from "../src/groups.js";
import { createSession, type RawTransport, type Session } from "../src/session.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".groups-test-"));
const path = join(scratch, "config.json");
const tokenProfile = {
  kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
};
const token = "fake-token-SENTINEL";

beforeEach(() => {
  process.env.SENTINEL_TOKEN = token;
});
afterEach(() => {
  delete process.env.SENTINEL_TOKEN;
  rmSync(path, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function session(transport: RawTransport, profile = "lab"): Session {
  writeFileSync(path, JSON.stringify({ profiles: { [profile]: tokenProfile } }));
  const loaded = loadConfig(path, new SecretRedactor());
  return createSession({ profile: selectProfile(loaded.config, profile), configPath: loaded.path,
    redactor: new SecretRedactor(), transport });
}

const flags = (argv: string[]): Map<string, string | boolean> =>
  new Map(parseInvocation(argv).flags);

// Fixtures keep group kinds verbatim: host, account, IP and domain groups
// are distinct type strings, and members stay scoped to their group ID.
const hostGroup = { id: 8, name: "synthetic-host-group", type: "host" };
const adGroup = { id: 9, name: "synthetic-ad-group", type: "synthetic-ad" };
const member7 = { id: 7, name: "synthetic-host-7" };
const rule7 = { id: 7, enabled: true, triage_category: "synthetic-triage" };
const listPage = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200, bodyText: JSON.stringify({ results: rows, ...extra }),
});

it("maps group filters to the wire keys and preserves kinds verbatim", async () => {
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/groups"
      + "?name=synthetic&type=synthetic-ad&page_size=100");
    return listPage([hostGroup, adGroup], { count: 2 });
  };
  const result = await runGroupList(session(transport),
    flags(["group", "list", "--name", "synthetic", "--type", "synthetic-ad"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 2,
    count: "2 groups",
    groups: [hostGroup, adGroup],
    complete: true,
    help: ["Run `vectra-axi group member list --profile lab --id 8` for paged membership"],
  } });
});

it.each([
  ["absolute", "https://fixture.invalid/api/v2.5/groups?type=host&page=2&page_size=100"],
  ["relative", "/api/v2.5/groups?type=host&page=2&page_size=100"],
])("follows %s group next links", async (_kind, next) => {
  const second = { ...hostGroup, id: 9 };
  const transport: RawTransport = async (request) => {
    if (request.url === "https://fixture.invalid/api/v2.5/groups?type=host&page_size=100") {
      return listPage([hostGroup], { count: 2, next });
    }
    if (request.url === "https://fixture.invalid/api/v2.5/groups?type=host&page=2&page_size=100") {
      return listPage([second], { count: 2 });
    }
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const result = await runGroupList(session(transport), flags(["group", "list", "--type", "host"]));
  expect(result).toMatchObject({ failed: false, output: {
    groups: [hostGroup, second], count: "2 groups", complete: true,
  } });
  expect(result.output).not.toHaveProperty("cursor");
});

it("resumes group windows at the next page with their filters", async () => {
  const second = { ...hostGroup, id: 9 };
  const transport: RawTransport = async (request) => {
    if (request.url === "https://fixture.invalid/api/v2.5/groups?type=host&page_size=100") {
      return listPage([hostGroup], { count: 2, next: "/api/v2.5/groups?type=host&page=2" });
    }
    if (request.url === "https://fixture.invalid/api/v2.5/groups?type=host&page=2") {
      return listPage([second], { count: 2 });
    }
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const owned = session(transport);
  const first = await runGroupList(owned, flags(["group", "list", "--type", "host", "--limit", "1"]));
  expect(first).toMatchObject({ failed: false, output: {
    groups: [hostGroup], count: "1 of 2 groups", complete: true, cursor: expect.any(String),
  } });
  const result = await runGroupList(owned,
    flags(["group", "list", "--type", "host", "--cursor", first.output.cursor as string]));
  expect(result).toMatchObject({ failed: false, output: { groups: [second], complete: true } });
  expect(result.output).not.toHaveProperty("cursor");
});

it("keeps host, account, IP and domain group kinds distinct", async () => {
  const rows = [
    { id: 1, name: "synthetic-hosts", type: "host" },
    { id: 2, name: "synthetic-accounts", type: "account" },
    { id: 3, name: "synthetic-ips", type: "ip" },
    { id: 4, name: "synthetic-domains", type: "domain" },
  ];
  const transport: RawTransport = async () => listPage(rows, { count: 4 });
  const result = await runGroupList(session(transport), flags(["group", "list"]));
  expect(result.output.groups).toEqual(rows);
  expect(new Set((result.output.groups as Record<string, unknown>[]).map((row) => row.type))).toEqual(
    new Set(["host", "account", "ip", "domain"]));
});

it.each(["true", "false", "maybe"])("rejects the removed include-members flag with %s", (value) => {
  expect(() => parseInvocation(["group", "list", "--include-members", value]))
    .toThrowError(/Unknown flag/);
});

it("shows one group with its kind and a paged-membership hint", async () => {
  const detail = { ...adGroup, id: 8, description: "Synthetic AD group", importance: "medium",
    last_modified_by: "synthetic-user", last_modified_timestamp: "2026-09-30T12:00:00Z",
    is_ad_group: true, ad_group_dn: "CN=synthetic,DC=fixture,DC=invalid" };
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/groups/8");
    expect(request.method).toBe("GET");
    return { status: 200, bodyText: JSON.stringify({ ...detail, members: [member7] }) };
  };
  const result = await runGroupShow(session(transport), flags(["group", "show", "--id", "8"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    ...detail,
    help: ["Run `vectra-axi group member list --profile lab --id 8` for complete paged membership"],
  } });
  expect(result.output).not.toHaveProperty("members");
});

it("lists one group's members through the paged member route", async () => {
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/groups/8/members"
      + "?name=synthetic&ordering=-id&is_key_asset=false&page_size=100");
    return listPage([member7], { count: 1 });
  };
  const result = await runGroupMemberList(session(transport),
    flags(["group", "member", "list", "--id", "8", "--name", "synthetic",
      "--ordering=-id", "--is-key-asset", "false"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    group: 8,
    total: 1,
    count: "1 members",
    members: [member7],
    complete: true,
    help: ["Run `vectra-axi group show --profile lab --id 8` for the group detail"],
  } });
});

it("pages member windows through the collection reader with the group scope", async () => {
  const second = { id: 21, name: "synthetic-host-21" };
  const transport: RawTransport = async (request) => {
    if (request.url === "https://fixture.invalid/api/v2.5/groups/8/members?page_size=100") {
      return listPage([member7], { count: 2,
        next: "https://fixture.invalid/api/v2.5/groups/8/members?page=2" });
    }
    if (request.url === "https://fixture.invalid/api/v2.5/groups/8/members?page=2") {
      return listPage([second], { count: 2 });
    }
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const owned = session(transport);
  const first = await runGroupMemberList(owned, flags(["group", "member", "list", "--id", "8", "--limit", "1"]));
  expect(first.output).toMatchObject({ group: 8, count: "1 of 2 members", cursor: expect.any(String) });
  const secondResult = await runGroupMemberList(owned,
    flags(["group", "member", "list", "--id", "8", "--cursor", first.output.cursor as string]));
  expect(secondResult.output).toMatchObject({ group: 8, members: [second], complete: true });
  await expect(runGroupMemberList(owned,
    flags(["group", "member", "list", "--id", "9", "--cursor", first.output.cursor as string])))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

it("keeps member windows from different groups separate", async () => {
  const other = { id: 31, name: "synthetic-account-31" };
  const transport: RawTransport = async (request) => {
    if (request.url === "https://fixture.invalid/api/v2.5/groups/8/members?page_size=100") {
      return listPage([member7], { count: 1 });
    }
    if (request.url === "https://fixture.invalid/api/v2.5/groups/9/members?page_size=100") {
      return listPage([other], { count: 1 });
    }
    throw new Error(`Unexpected synthetic request: ${request.url}`);
  };
  const owned = session(transport);
  const first = await runGroupMemberList(owned, flags(["group", "member", "list", "--id", "8"]));
  const secondResult = await runGroupMemberList(owned, flags(["group", "member", "list", "--id", "9"]));
  expect(first.output).toMatchObject({ group: 8, members: [member7] });
  expect(secondResult.output).toMatchObject({ group: 9, members: [other] });
});

it("maps rule filters to the wire keys without a client fields selector", async () => {
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/rules?contains=synthetic&ordering=-id&page_size=100");
    return listPage([rule7], { count: 1 });
  };
  const result = await runRuleList(session(transport),
    flags(["triage", "rule", "list", "--contains", "synthetic", "--ordering=-id"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 1,
    count: "1 triage rules",
    rules: [rule7],
    complete: true,
    help: ["Run `vectra-axi triage rule show --profile lab --id 7` for full detail", BENIGN_DISCLAIMER],
  } });
});

it("shows one triage rule without implying a benign verdict", async () => {
  const detail = { ...rule7, description: "Synthetic automation", detection: "synthetic-detection",
    is_whitelist: false,
    source_conditions: { OR: [{ AND: [{ ANY_OF: { field: "host",
      values: [{ value: "synthetic-host", label: "Synthetic host" }], groups: [], label: "Host" } }] }] },
    additional_conditions: { NONE_OF: { field: "remote1_dns",
      values: [{ value: "fixture.invalid", label: "Synthetic domain" }], groups: [], label: "Domain" } } };
  const transport: RawTransport = async (request) => {
    expect(request.url).toBe("https://fixture.invalid/api/v2.5/rules/7");
    expect(request.method).toBe("GET");
    return { status: 200, bodyText: JSON.stringify({ ...detail, verdict: "benign" }) };
  };
  const result = await runRuleShow(session(transport), flags(["triage", "rule", "show", "--id", "7"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    ...detail,
    help: [BENIGN_DISCLAIMER],
  } });
  expect(result.output).not.toHaveProperty("verdict");
});

it.each([
  ["description", 42],
  ["source_conditions", "synthetic-condition"],
  ["source_conditions", []],
  ["additional_conditions", true],
  ["additional_conditions", []],
  ["detection", { id: 7 }],
  ["is_whitelist", "false"],
  ["is_whitelist", null],
])("rejects malformed rule detail %s: %j", async (field, value) => {
  const transport: RawTransport = async () => ({ status: 200,
    bodyText: JSON.stringify({ ...rule7, [field]: value }) });
  await expect(runRuleShow(session(transport), flags(["triage", "rule", "show", "--id", "7"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

const conditionLeaf = { field: "host", values: [{ value: "synthetic-host", label: "Synthetic host" }],
  groups: [{ value: 8, label: "Synthetic group" }], label: "Host" };

it.each(["source_conditions", "additional_conditions"])("validates every node in %s", async (field) => {
  const tree = { AND: [{ OR: [{ ANY_OF: conditionLeaf }, { NONE_OF: conditionLeaf }] }] };
  const transport: RawTransport = async () => ({ status: 200,
    bodyText: JSON.stringify({ ...rule7, [field]: tree }) });
  const result = await runRuleShow(session(transport), flags(["triage", "rule", "show", "--id", "7"]));
  expect(result.output[field]).toEqual(tree);
  expect(result.output.help).toEqual([BENIGN_DISCLAIMER]);
});

describe.each(["source_conditions", "additional_conditions"])("%s condition validation", (field) => {
  it.each([
    { OR: 42 },
    { AND: false },
    { AND: [null] },
    { OR: [{ AND: [42] }] },
    { AND: [], OR: [] },
    {},
    { UNKNOWN: [] },
    { ANY_OF: null },
    { NONE_OF: [] },
    { ANY_OF: { ...conditionLeaf, field: 42 } },
    { NONE_OF: { ...conditionLeaf, label: false } },
    { ANY_OF: { ...conditionLeaf, values: "synthetic-host" } },
    { NONE_OF: { ...conditionLeaf, groups: {} } },
    { ANY_OF: { ...conditionLeaf, values: [{ value: [], label: "Synthetic host" }] } },
    { NONE_OF: { ...conditionLeaf, groups: [{ value: 8, label: false }] } },
    { ANY_OF: { ...conditionLeaf, values: [{ label: "Synthetic host" }] } },
    { NONE_OF: { ...conditionLeaf, groups: [{ value: 8 }] } },
    { OR: [{ AND: [{ ANY_OF: { ...conditionLeaf, groups: [null] } }] }] },
  ])("rejects malformed tree %j", async (tree) => {
    const transport: RawTransport = async () => ({ status: 200,
      bodyText: JSON.stringify({ ...rule7, [field]: tree }) });
    await expect(runRuleShow(session(transport), flags(["triage", "rule", "show", "--id", "7"])))
      .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });
});

it.each([
  ["description", 42],
  ["importance", false],
  ["last_modified_by", []],
  ["last_modified_timestamp", 42],
  ["is_ad_group", "true"],
  ["ad_group_dn", {}],
])("rejects malformed group detail %s", async (field, value) => {
  const transport: RawTransport = async () => ({ status: 200,
    bodyText: JSON.stringify({ ...hostGroup, [field]: value }) });
  await expect(runGroupShow(session(transport), flags(["group", "show", "--id", "8"])))
    .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
});

it("shows a group when release-dependent metadata is absent", async () => {
  const transport: RawTransport = async () => ({ status: 200, bodyText: JSON.stringify(hostGroup) });
  const result = await runGroupShow(session(transport), flags(["group", "show", "--id", "8"]));
  expect(result.output).toMatchObject(hostGroup);
  expect(result.output).not.toHaveProperty("is_ad_group");
});

it("shows a rule with null optional investigation fields", async () => {
  const detail = { ...rule7, description: null, source_conditions: null,
    additional_conditions: null, detection: null, is_whitelist: true };
  const transport: RawTransport = async () => ({ status: 200, bodyText: JSON.stringify(detail) });
  const result = await runRuleShow(session(transport), flags(["triage", "rule", "show", "--id", "7"]));
  expect(result.output).toEqual({ profile: "lab", ...detail, help: [BENIGN_DISCLAIMER] });
});

it("reports an empty rule window as success with an explicit zero", async () => {
  const transport: RawTransport = async () => listPage([], { count: 0 });
  const result = await runRuleList(session(transport),
    flags(["triage", "rule", "list", "--contains", "nothing"]));
  expect(result).toEqual({ failed: false, output: {
    profile: "lab",
    total: 0,
    count: "0 triage rules",
    rules: "0 triage rules found with contains nothing",
    complete: true,
    help: ["Widen the filters or omit them to list every triage rule"],
  } });
});

it("reports denial as a failed disposition rather than an empty result", async () => {
  const transport: RawTransport = async () => ({ status: 403, bodyText: "{}" });
  for (const run of [
    (owned: Session) => runGroupList(owned, flags(["group", "list"])),
    (owned: Session) => runGroupMemberList(owned, flags(["group", "member", "list", "--id", "8"])),
    (owned: Session) => runRuleList(owned, flags(["triage", "rule", "list"])),
  ]) {
    const result = await run(session(transport));
    expect(result.failed).toBe(true);
    expect(result.output).toMatchObject({ profile: "lab", complete: false, code: "ACCESS_DENIED" });
  }
});

it("rejects malformed group, member and rule rows instead of projecting them", async () => {
  const groupTransport: RawTransport = async () =>
    listPage([{ ...hostGroup, type: 42 }], { count: 1 });
  const groupResult = await runGroupList(session(groupTransport), flags(["group", "list"]));
  expect(groupResult).toMatchObject({ failed: true, output: { complete: false, code: "RESPONSE_INVALID" } });
  const memberTransport: RawTransport = async () =>
    listPage([{ ...member7, id: "seven" }], { count: 1 });
  const memberResult = await runGroupMemberList(session(memberTransport),
    flags(["group", "member", "list", "--id", "8"]));
  expect(memberResult).toMatchObject({ failed: true, output: { complete: false, code: "RESPONSE_INVALID" } });
  const ruleTransport: RawTransport = async () =>
    listPage([{ ...rule7, enabled: "yes" }], { count: 1 });
  const ruleResult = await runRuleList(session(ruleTransport), flags(["triage", "rule", "list"]));
  expect(ruleResult).toMatchObject({ failed: true, output: { complete: false, code: "RESPONSE_INVALID" } });
});

it.each([
  ["group create", ["group", "create"]],
  ["group update", ["group", "update", "--id", "8"]],
  ["group delete", ["group", "delete", "--id", "8"]],
  ["group member create", ["group", "member", "create", "--id", "8"]],
  ["group member delete", ["group", "member", "delete", "--id", "8"]],
  ["triage rule create", ["triage", "rule", "create"]],
  ["triage rule update", ["triage", "rule", "update", "--id", "7"]],
  ["triage rule delete", ["triage", "rule", "delete", "--id", "7"]],
])("refuses the %s mutation leaf as an unknown command", (_name, argv) => {
  expect(() => parseInvocation(argv)).toThrowError(/^Unknown command: /);
});

// Flag validation runs before profile selection in cli.ts, so these unit
// cases assert the validators throw without any session or transport.
it.each([
  ["empty group name", () => groupQuery(flags(["group", "list", "--name", "  "])),
    "--name requires a non-empty value"],
  ["non-boolean is-key-asset", () => memberQuery(flags(["group", "member", "list", "--id", "8", "--is-key-asset", "yes"])),
    "--is-key-asset must be true or false"],
  ["zero limit", () => listLimit(flags(["group", "list", "--limit", "0"])),
    "--limit must be a positive integer"],
  ["unknown group field", () => listFields(flags(["group", "list", "--fields", "members"]), GROUP_LIST_FIELDS),
    "Unknown --fields value: members"],
  ["unknown member field", () => listFields(flags(["group", "member", "list", "--fields", "type"]), MEMBER_LIST_FIELDS),
    "Unknown --fields value: type"],
  ["unknown rule field", () => listFields(flags(["triage", "rule", "list", "--fields", "name"]), RULE_LIST_FIELDS),
    "Unknown --fields value: name"],
  ["missing group id", () => groupId(flags(["group", "show"]), "group show"),
    "group show requires --id"],
  ["zero member group id", () => groupId(flags(["group", "member", "list", "--id", "0"]), "group member list"),
    "--id must be a positive integer group ID"],
  ["missing rule id", () => ruleId(flags(["triage", "rule", "show"])),
    "triage rule show requires --id"],
  ["fractional rule id", () => ruleId(flags(["triage", "rule", "show", "--id", "1.5"])),
    "--id must be a positive integer rule ID"],
])("rejects %s before profile selection", (_name, run, message) => {
  expect(run).toThrowError(message);
});
