import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInvocation } from "../src/catalogue.js";
import { runExportSettingSet, runInternalNetworkRead, runInternalNetworkSet } from "../src/settings.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, type RawTransport } from "../src/session.js";
import { createMutationCoordinator } from "../src/writes.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".settings-test-"));
const configPath = join(scratch, "config.json");
const auditPath = join(scratch, "writes.log");
const operation = "qux.setting.internal-network.set";
const empty = { included_subnets: [], excluded_subnets: [], dropped_subnets: [] };
const desired = { include: ["198.51.100.0/24"], exclude: [], drop: [] };
const input = ["--include", "198.51.100.0/24", "--exclude", "none", "--drop", "none"];
const execute = ["--execute", "--confirm", "internal network"];
beforeEach(() => {
  vi.stubEnv("SYNTHETIC_TOKEN", "synthetic-secret");
  vi.stubEnv("VECTRA_AXI_READ_ONLY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(auditPath, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function harness(options: {
  kind?: "qux" | "rux"; state?: () => unknown;
  exportKind?: "syslog" | "kafka";
  writes?: { allowWrites: boolean; operations: string[] }; status?: number; timeout?: boolean; readStatus?: number;
} = {}) {
  const kind = options.kind ?? "qux";
  writeFileSync(configPath, JSON.stringify({ profiles: { lab: {
    kind, origin: "https://fixture.invalid", apiVersion: kind === "qux" ? "2.5" : "3.4",
    ...(kind === "qux" ? { auth: "token", tokenEnv: "SYNTHETIC_TOKEN" }
      : { auth: "oauth", clientId: "synthetic-client", secretEnv: "SYNTHETIC_TOKEN" }),
    writes: options.writes ?? { allowWrites: true, operations: [options.exportKind ? `qux.setting.${options.exportKind}.set` : operation] },
  } } }));
  const redactor = new SecretRedactor();
  const loaded = loadConfig(configPath, redactor);
  const profile = selectProfile(loaded.config, "lab");
  const seen: { method: string; url: string; body?: string }[] = [];
  const transport: RawTransport = async (request) => {
    seen.push({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) });
    if (request.method === "GET") return {
      status: options.readStatus ?? 200, bodyText: JSON.stringify(options.state ? options.state() : options.exportKind ? {} : empty),
    };
    if (options.timeout) throw new Error("synthetic timeout");
    return { status: options.status ?? 200, bodyText: "{}" };
  };
  const session = createSession({ profile, configPath, redactor, transport });
  const coordinator = createMutationCoordinator({ profile, configPath, redactor, transport, auditPath });
  return {
    seen, read: () => runInternalNetworkRead(session),
    run: (args: string[] = input, stdin?: () => string) => options.exportKind
      ? runExportSettingSet(session, coordinator,
        new Map(parseInvocation(["setting", options.exportKind, "set", ...args]).flags), options.exportKind, stdin)
      : runInternalNetworkSet(session, coordinator,
        new Map(parseInvocation(["setting", "internal-network", "set", ...args]).flags)),
  };
}
const journal = () => readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

it("reads the reviewed QUX settings route", async () => {
  const { read, seen } = harness();
  expect((await read()).output).toEqual({ profile: "lab", include: [], exclude: [], drop: [] });
  expect(seen).toEqual([{ method: "GET", url: "https://fixture.invalid/api/v2.5/settings/internal_network" }]);
});

it("previews the high-risk before/after diff then replaces all lists once", async () => {
  const { run, seen } = harness();
  expect((await run()).output).toMatchObject({
    before: { include: [], exclude: [], drop: [] }, after: desired,
    warning: "High risk: changes what is monitored or dropped across the appliance.",
  });
  expect(seen.every((call) => call.method === "GET")).toBe(true);
  expect((await run([...input, ...execute])).failed).toBe(false);
  expect(seen.filter((call) => call.method === "POST")).toEqual([
    { method: "POST", url: "https://fixture.invalid/api/v2.5/settings/internal_network", body: JSON.stringify(desired) },
  ]);
  expect(seen.filter((call) => call.method === "GET")).toHaveLength(3);
  expect(journal().map((line) => [line.kind, line.outcome])).toEqual([["intent", undefined], ["outcome", "SUCCESS"]]);
  expect(readFileSync(auditPath, "utf8")).not.toMatch(/include|exclude|drop|198\.51|payload|synthetic-secret/);
});

it("normalizes IPv6 and ignores duplicate entries and list ordering for no-op", async () => {
  const { run, seen } = harness({ state: () => ({ ...empty,
    included_subnets: ["2001:db8::/32", "198.51.100.0/24"],
  }) });
  const args = ["--include", "198.51.100.0/24,2001:0db8::/32,198.51.100.0/24", "--exclude", "none", "--drop", "none"];
  expect((await run(args)).output).toMatchObject({ state: expect.stringContaining("no-op") });
  expect((await run([...args, ...execute])).output).toMatchObject({ state: expect.stringContaining("no-op") });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it("sends nonempty exclude and drop lists", async () => {
  const { run, seen } = harness();
  await run(["--include", "none", "--exclude", "192.0.2.0/24", "--drop", "203.0.113.0/24", ...execute]);
  expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ include: [], exclude: ["192.0.2.0/24"], drop: ["203.0.113.0/24"] });
});

it.each([
  ["0.0.0.0/0", "0.0.0.0/0"], ["198.51.100.7/32", "198.51.100.7/32"],
  ["::/0", "::/0"], ["2001:0DB8::7/128", "2001:db8::7/128"],
  ["2001:db8:0:0:0:0:0:0/32", "2001:db8::/32"],
])("previews valid boundary CIDR %s", async (value, normalized) => {
  const { run, seen } = harness();
  expect((await run(["--include", value, "--exclude", "none", "--drop", "none"])).output)
    .toMatchObject({ after: { include: [normalized] } });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it.each(["198.51.100.1/24", "198.51.100.0/33", "198.51.100.0", "999.1.1.0/24", "2001:db8::1/32", "2001:db8::/129", "fe80::%eth0/64", "198.51.100.0/-1", "198.51.100.0/24,", "none,198.51.100.0/24"])("refuses invalid CIDR %s before any request", async (value) => {
  const { run, seen } = harness();
  await expect(run(["--include", value, "--exclude", "none", "--drop", "none", ...execute])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it("requires every desired-state list", async () => {
  const { run, seen } = harness();
  await expect(run(["--include", "198.51.100.0/24"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(seen).toEqual([]);
});

it("refuses RUX reads and writes before any request", async () => {
  const { read, run, seen } = harness({ kind: "rux" });
  await expect(read()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  await expect(run()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  expect(seen).toEqual([]);
});

it.each([
  [{ allowWrites: false, operations: [operation] }, "WRITES_DISABLED"],
  [{ allowWrites: true, operations: ["qux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
] as const)("refuses disallowed profile writes %j", async (writes, code) => {
  const { run, seen } = harness({ writes: { ...writes, operations: [...writes.operations] } });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code });
  expect(seen).toEqual([]);
});

it("lets forced read-only override opt-in", async () => {
  vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
  const { run, seen } = harness();
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(seen).toEqual([]);
});

it.each([
  [["--execute"], "CONFIRM_REQUIRED"],
  [["--execute", "--confirm", "other network"], "CONFIRM_MISMATCH"],
  [["--execute", "--dry-run"], "VALIDATION_ERROR"],
] as const)("refuses execution flags %j", async (args, code) => {
  const { run, seen } = harness();
  await expect(run([...input, ...args])).rejects.toMatchObject({ code });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it.each([null, {}, { ...empty, dropped_subnets: "203.0.113.0/24" }, { ...empty, included_subnets: ["invalid"] }])("refuses malformed settings %j", async (state) => {
  const { run, seen } = harness({ state: () => state });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it("refuses a denied settings read without sending", async () => {
  const { run, seen } = harness({ readStatus: 403 });
  await expect(run([...input, ...execute])).rejects.toBeDefined();
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
});

it("refuses a concurrent settings change", async () => {
  let reads = 0;
  const { run, seen } = harness({ state: () => ++reads === 1 ? empty : { ...empty, dropped_subnets: ["203.0.113.0/24"] } });
  await expect(run([...input, ...execute])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(seen.filter((call) => call.method === "POST")).toEqual([]);
  expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
});

it.each([
  [403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"],
] as const)("journals failure or ambiguity without replay %s %s", async (status, timeout, outcome) => {
  const { run, seen } = harness({ status, timeout });
  expect((await run([...input, ...execute])).failed).toBe(true);
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(journal().at(-1)).toMatchObject({ outcome });
});

describe.each(["syslog", "kafka"] as const)("%s export settings", (exportKind) => {
  const payload = { enabled: true, [`${exportKind}_servers`]: [{
    cef: "cef", proto: "udp", server: "192.0.2.10", bootstrap_servers: "export.example.com:9092",
    port: 514, types: ["host", "detection"], v2: true,
    filters: { triaged_detections: { enabled: false }, detection_categories: { enabled: false, values: [] } },
  }],
    tls: { client_private_key: "synthetic-key", certificate: "synthetic-cert" },
    sasl: { password: "synthetic-password", auth_token: "synthetic-token" } };
  const filePath = join(scratch, `${exportKind}.json`);
  const args = ["--config-file", filePath];
  const send = [...args, "--execute", "--confirm", `${exportKind} export`];
  beforeEach(() => writeFileSync(filePath, JSON.stringify(payload)));

  it("previews a redacted diff and sends the full document once", async () => {
    const { run, seen } = harness({ exportKind, state: () => ({ ...payload, enabled: false }) });
    const preview = await run(args);
    expect(preview.output).toMatchObject({ before: { enabled: false }, after: { enabled: true },
      warning: expect.stringContaining("data egress") });
    expect(JSON.stringify(preview)).not.toMatch(/synthetic-(key|cert|password|token)/);
    expect(seen.every((call) => call.method === "GET")).toBe(true);
    expect((await run(send)).failed).toBe(false);
    expect(seen.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", url: `https://fixture.invalid/api/v2.5/settings/${exportKind}_config`, body: JSON.stringify(payload) },
    ]);
    expect(journal().map((line) => [line.kind, line.outcome, line.effect])).toEqual([
      ["intent", undefined, "disruptive"], ["outcome", "SUCCESS", "disruptive"],
    ]);
    expect(readFileSync(auditPath, "utf8")).not.toMatch(/payload|synthetic-|export.example|password|certificate/);
  });

  it("reads stdin and recognizes unchanged documents regardless of key order", async () => {
    const { run, seen } = harness({ exportKind, state: () => ({ ...payload, tls: { certificate: "synthetic-cert", client_private_key: "synthetic-key" } }) });
    expect((await run(["--config-file", "-", "--execute"], () => JSON.stringify(payload))).output)
      .toMatchObject({ state: expect.stringContaining("no-op") });
    expect(seen.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("detects a secret-only change despite identical redacted previews", async () => {
    const { run, seen } = harness({ exportKind, state: () => ({ ...payload, sasl: { ...payload.sasl, password: "previous-password" } }) });
    await run(send);
    expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("refuses a concurrent secret-only change", async () => {
    let reads = 0;
    const { run, seen } = harness({ exportKind, state: () => ({ enabled: false, password: ++reads === 1 ? "first-password" : "second-password" }) });
    await expect(run(send)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(seen.filter((call) => call.method === "POST")).toEqual([]);
    expect(journal().at(-1)).toMatchObject({ outcome: "NOT_SENT" });
  });

  it.each([
    ["placeholder in value", { ...payload, sasl: { ...payload.sasl, password: "***redacted***" } }],
    ["placeholder in key", { ...payload, "***redacted***-key": "value" }],
  ])("refuses %s without HTTP", async (_, doc) => {
    writeFileSync(filePath, JSON.stringify(doc));
    const { run, seen } = harness({ exportKind, state: () => payload });
    await expect(run(send)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(seen).toEqual([]);
    expect(existsSync(auditPath)).toBe(false);
  });

  it("redacts passphrase and JAAS secrets in previews while preserving the POST document", async () => {
    const secretPayload = { ...payload,
      tls: { ...payload.tls, passphrase: "synthetic-passphrase" },
      sasl: { ...payload.sasl, "sasl.jaas.config": 'org.apache.kafka.common.security.plain.PlainLoginModule required password="synthetic-jaas-password";' } };
    writeFileSync(filePath, JSON.stringify(secretPayload));
    const previewHarness = harness({ exportKind, state: () => ({ ...secretPayload, enabled: false }) });
    const preview = await previewHarness.run(args);
    expect(JSON.stringify(preview)).not.toMatch(/synthetic-passphrase|synthetic-jaas-password/);
    const sendHarness = harness({ exportKind, state: () => ({ ...secretPayload, enabled: false }) });
    expect((await sendHarness.run(send)).failed).toBe(false);
    const posts = sendHarness.seen.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body!)).toEqual(secretPayload);
  });

  it.each(["null", "[]", "bad JSON", '"text"'])("refuses malformed input %s without HTTP", async (body) => {
    const { run, seen } = harness({ exportKind });
    await expect(run(["--config-file", "-"], () => body)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(seen).toEqual([]);
  });

  it("refuses RUX without HTTP", async () => {
    const { run, seen } = harness({ exportKind, kind: "rux" });
    await expect(run(send)).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(seen).toEqual([]);
  });

  it.each([
    [{ allowWrites: false, operations: ["qux.host.tag.set"] }, "WRITES_DISABLED"],
    [{ allowWrites: true, operations: ["qux.host.tag.set"] }, "OPERATION_NOT_WRITABLE"],
  ])("refuses profile policy %j", async (writes, code) => {
    const { run, seen } = harness({ exportKind, writes });
    await expect(run(send)).rejects.toMatchObject({ code });
    expect(seen).toEqual([]);
  });

  it("honors forced read-only", async () => {
    vi.stubEnv("VECTRA_AXI_READ_ONLY", "1");
    const { run, seen } = harness({ exportKind });
    await expect(run(send)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(seen).toEqual([]);
  });

  it.each([
    [["--execute"], "CONFIRM_REQUIRED"],
    [["--execute", "--confirm", "other export"], "CONFIRM_MISMATCH"],
  ])("refuses confirmation flags %j", async (flags, code) => {
    const { run, seen } = harness({ exportKind });
    await expect(run([...args, ...flags])).rejects.toMatchObject({ code });
    expect(seen.filter((call) => call.method === "POST")).toEqual([]);
  });

  it.each([null, []])("refuses malformed reads %j", async (body) => {
    const { run, seen } = harness({ exportKind, state: () => body });
    await expect(run(send)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(seen.filter((call) => call.method === "POST")).toEqual([]);
  });

  it.each([[403, false, "FAILED"], [200, true, "OUTCOME_UNKNOWN"]] as const)("journals %s %s without replay", async (status, timeout, outcome) => {
    const { run, seen } = harness({ exportKind, status, timeout });
    expect((await run(send)).failed).toBe(true);
    expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(journal().at(-1)).toMatchObject({ outcome });
    expect(readFileSync(auditPath, "utf8")).not.toMatch(/payload|synthetic-|export.example/);
  });
});
