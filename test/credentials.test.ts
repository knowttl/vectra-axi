import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { authStatus, resolveSecret } from "../src/auth.js";
import { configPath, loadConfig, profileSchema, selectProfile } from "../src/profiles.js";
import { privateFiles, toolDirectory } from "../src/private-file.js";
import { SecretRedactor } from "../src/redact.js";
import { readOnlyForced, resolveWriteLogPath } from "../src/writes.js";
import { oauthCredentials, type OAuthProfile } from "../src/oauth.js";
import { doctorTargets, runDoctor } from "../src/doctor.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".credentials-test-"));
const profile = { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token" };
let sequence = 0;
const path = () => join(scratch, `${sequence++}`);
function configure(fields: Record<string, unknown> = {}) {
  const file = path();
  privateFiles().write(file, JSON.stringify({ version: 1, profiles: { lab: { ...profile, ...fields } } }));
  return loadConfig(file);
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it("uses absolute XDG directories and ignores relative overrides", () => {
  expect(toolDirectory("config", { XDG_CONFIG_HOME: scratch }, "linux", "/fake-home")).toBe(join(scratch, "vectra-axi"));
  expect(toolDirectory("state", { XDG_STATE_HOME: "relative" }, "linux", "/fake-home")).toBe("/fake-home/.local/state/vectra-axi");
});

it("uses Windows roaming config and local state while ignoring XDG", () => {
  const env = { APPDATA: "/roaming", LOCALAPPDATA: "/local", XDG_CONFIG_HOME: "/ignored", XDG_STATE_HOME: "/ignored" };
  expect(toolDirectory("config", env, "win32", "/home")).toBe("/roaming/vectra-axi");
  expect(toolDirectory("state", env, "win32", "/home")).toBe("/local/vectra-axi");
});

it("reports the exact legacy move without reading its contents", () => {
  const home = path();
  mkdirSync(join(home, ".vectra-axi"), { recursive: true });
  writeFileSync(join(home, ".vectra-axi", "config.json"), "not valid JSON");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
  vi.stubEnv("VECTRA_AXI_CONFIG", undefined);
  expect(() => loadConfig()).toThrow(expect.objectContaining({ code: "CONFIG_MOVED", suggestions: [expect.stringContaining(configPath())] }));
  privateFiles().write(configPath(), JSON.stringify({ version: 1, profiles: {} }));
  expect(loadConfig().config.profiles).toEqual({});
  expect(() => loadConfig(join(home, ".vectra-axi", "config.json"))).toThrow(expect.objectContaining({ code: "CONFIG_MOVED" }));
});

it("requires moving a legacy journal before using the new default", () => {
  const home = path();
  mkdirSync(join(home, ".vectra-axi"), { recursive: true });
  writeFileSync(join(home, ".vectra-axi", "writes.log"), "legacy journal is not read");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const env = { XDG_STATE_HOME: join(home, "state") };
  expect(() => resolveWriteLogPath(env)).toThrow(expect.objectContaining({ code: "CONFIG_MOVED" }));
  const journal = join(home, "state", "vectra-axi", "writes.log");
  privateFiles().write(journal, "");
  expect(resolveWriteLogPath(env)).toBe(journal);
});

it("resolves a private file, strips BOM and trailing whitespace, and registers encoded forms", () => {
  const file = path();
  privateFiles().write(file, '\uFEFFfake/"secret\r\n  ');
  chmodSync(file, 0o400);
  const selected = selectProfile(configure({ token: { file } }).config);
  const redactor = new SecretRedactor();
  expect(resolveSecret(selected, redactor)).toBe('fake/"secret');
  expect(redactor.text(encodeURIComponent('fake/"secret'))).toBe("***redacted***");
  expect(authStatus(selected, redactor)).toMatchObject({ profile: "lab", secrets: { token: { file } }, status: "available" });
});

it("reports unavailable credentials with the selected profile and reference", () => {
  vi.stubEnv("UNSET_FIXTURE_SECRET", undefined);
  const selected = selectProfile(configure({ token: { env: "UNSET_FIXTURE_SECRET" } }).config);
  expect(authStatus(selected, new SecretRedactor())).toMatchObject({ profile: "lab", origin: "https://fixture.invalid",
    secrets: { token: { env: "UNSET_FIXTURE_SECRET" } }, status: "unavailable", code: "AUTH_REQUIRED" });
});

it.each(["bad env", "1INVALID", "NAME;command"])("rejects invalid SecretRef env %s on load", (env) => {
  expect(() => configure({ token: { env } })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it.each([{ file: "relative" }, { env: "VALID", file: "/absolute" }, { stored: false }, "inline-secret"])("rejects invalid SecretRef %j without its value", (token) => {
  expect(() => configure({ token })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID", message: expect.not.stringContaining("inline-secret") }));
});

it("accepts drive paths and rejects UNC and device SecretRefs on Windows", () => {
  vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
  expect(profileSchema.safeParse({ ...profile, token: { file: "C:\\private\\token.txt" } }).success).toBe(true);
  expect(profileSchema.safeParse({ ...profile, token: { file: "\\\\server\\share\\token" } }).success).toBe(false);
  expect(profileSchema.safeParse({ ...profile, token: { file: "\\\\?\\C:\\private\\token" } }).success).toBe(false);
});

it("defaults the missing secret reference and does not support stored credentials", () => {
  vi.stubEnv("VECTRA_AXI_TOKEN", "default-fake-token");
  expect(resolveSecret(selectProfile(configure().config, "lab"), new SecretRedactor())).toBe("default-fake-token");
  expect(() => resolveSecret(selectProfile(configure({ token: { stored: true } }).config, "lab"), new SecretRedactor()))
    .toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
});

it("resolves OAuth clientSecret refs and redacts Basic authentication and minted tokens", async () => {
  vi.stubEnv("VECTRA_AXI_CLIENT_SECRET", "fake-oauth-secret");
  const loaded = configure({ auth: "oauth", clientId: "fake-client" });
  const selected = selectProfile(loaded.config, "lab") as OAuthProfile;
  const redactor = new SecretRedactor();
  const basic = Buffer.from("fake-client:fake-oauth-secret").toString("base64");
  const transport = vi.fn().mockResolvedValue({ status: 200, body: { access_token: "fake-minted-token", token_type: "Bearer", expires_in: 600 } });
  const credential = await oauthCredentials(selected, loaded.path, redactor, transport)();
  expect(credential.header).toBe("Bearer fake-minted-token");
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Basic ${basic}` }) }));
  expect(redactor.text(`${basic} fake-oauth-secret fake-minted-token`)).toBe("***redacted*** ***redacted*** ***redacted***");
});

it("selects a complete env profile ahead of the file default, while explicit selection stays bound", () => {
  vi.stubEnv("VECTRA_AXI_KIND", "qux");
  vi.stubEnv("VECTRA_AXI_ORIGIN", "https://env.invalid");
  vi.stubEnv("VECTRA_AXI_API_VERSION", "2.5");
  vi.stubEnv("VECTRA_AXI_AUTH", "token");
  vi.stubEnv("VECTRA_AXI_TOKEN", "env-fake-token");
  const config = configure({ token: { env: "OTHER_TOKEN" } }).config;
  expect(selectProfile(config)).toMatchObject({ name: "env", source: "env-profile", origin: "https://env.invalid" });
  expect(selectProfile(config, "lab")).toMatchObject({ name: "lab", origin: "https://fixture.invalid" });
});

it("rejects a partial env profile instead of using a file profile", () => {
  vi.stubEnv("VECTRA_AXI_ORIGIN", "https://env.invalid");
  const config = configure().config;
  expect(() => selectProfile(config)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  expect(selectProfile(config, "lab").name).toBe("lab");
});

it("checks the env profile with doctor and keeps follow-up commands usable without a file", async () => {
  vi.stubEnv("VECTRA_AXI_KIND", "qux");
  vi.stubEnv("VECTRA_AXI_ORIGIN", "https://env.invalid");
  vi.stubEnv("VECTRA_AXI_API_VERSION", "2.5");
  vi.stubEnv("VECTRA_AXI_AUTH", "token");
  vi.stubEnv("VECTRA_AXI_TOKEN", "env-fake-token");
  const loaded = { path: path(), config: { profiles: {} } };
  const transport = vi.fn().mockResolvedValue({ status: 200, bodyText: '{"results":[],"count":0}' });
  const result = await runDoctor({ loaded, names: doctorTargets(loaded.config), redactor: new SecretRedactor(), transport });
  expect(result.failed).toBe(false);
  expect(result.output.help).toEqual(["Run `vectra-axi detection list` to start an investigation"]);
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url: "https://env.invalid/api/v2.5/detections" }));
});

it("doctor ignores partial env fields when a file profile is explicitly selected", async () => {
  vi.stubEnv("VECTRA_AXI_ORIGIN", "https://unused.invalid");
  vi.stubEnv("FIXTURE_TOKEN", "fake-file-profile-token");
  const loaded = configure({ token: { env: "FIXTURE_TOKEN" } });
  const transport = vi.fn().mockResolvedValue({ status: 200, bodyText: '{"results":[],"count":0}' });
  const result = await runDoctor({ loaded, names: doctorTargets(loaded.config, "lab"), profileFlag: "lab", redactor: new SecretRedactor(), transport });
  expect(result.failed).toBe(false);
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url: "https://fixture.invalid/api/v2.5/detections" }));
});

it.each([0o620, 0o602])("rejects writable config mode %s before parsing", (mode) => {
  const file = path();
  writeFileSync(file, "not JSON", { mode });
  chmodSync(file, mode);
  expect(() => loadConfig(file)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
});

it("checks ownership, links, and secret read permissions", () => {
  const file = path();
  privateFiles().write(file, "fake-secret");
  expect(() => privateFiles({ uid: statSync(file).uid + 1 }).read(file)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  const link = path();
  symlinkSync(file, link);
  expect(() => privateFiles().read(link)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  chmodSync(file, 0o644);
  expect(privateFiles().read(file)).toBe("fake-secret");
  expect(() => privateFiles().read(file, true)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
});

it("writes atomically and repairs existing directory permissions", () => {
  const directory = path();
  mkdirSync(directory, { mode: 0o755 });
  const file = join(directory, "secret");
  privateFiles().write(file, "first");
  privateFiles().write(file, "second");
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toBe("second");
  expect(readdirSync(directory)).toEqual(["secret"]);
});

it("cleans up an unsuccessful atomic write without replacing the original", () => {
  const file = path();
  privateFiles().write(file, "original");
  const before = readdirSync(scratch);
  expect(() => privateFiles({ rename: () => { throw new Error("rename failed"); } }).write(file, "replacement")).toThrow("rename failed");
  expect(readFileSync(file, "utf8")).toBe("original");
  expect(readdirSync(scratch)).toEqual(before);
});

it("uses Windows ACL checks rather than Unix modes and verifies ACL only on request", () => {
  const file = path();
  writeFileSync(file, "fake", { mode: 0o666 });
  chmodSync(file, 0o666);
  const acl = vi.fn();
  const files = privateFiles({ platform: "win32", acl });
  expect(files.read(file, true)).toBe("fake");
  expect(acl).toHaveBeenLastCalledWith(file, "check", false);
  files.read(file, true, true);
  expect(acl).toHaveBeenLastCalledWith(file, "verify", false);
  const denied = privateFiles({ platform: "win32", acl: () => { throw new Error("reparse or ACL failure"); } });
  expect(() => denied.read(file)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
});

it("protects Windows directories and temp files on every write and retries transient rename failures", () => {
  const file = join(path(), "journal");
  const acl = vi.fn();
  const wait = vi.fn();
  const rename = vi.fn().mockImplementationOnce(() => { throw Object.assign(new Error(), { code: "EPERM" }); }).mockImplementation(renameSync);
  const files = privateFiles({ platform: "win32", acl, rename, wait });
  files.write(file, "first");
  files.write(file, "second");
  expect(acl.mock.calls.filter(([, action, directory]) => action === "restrict" && directory)).toHaveLength(2);
  expect(acl.mock.calls.filter(([, action, directory]) => action === "restrict" && !directory)).toHaveLength(2);
  expect(wait).toHaveBeenCalledWith(25);
  expect(readFileSync(file, "utf8")).toBe("second");
});

it("removes Windows temporary files when applying the DACL fails", () => {
  const directory = path();
  const file = join(directory, "secret");
  const files = privateFiles({ platform: "win32", acl: (_path, _action, isDirectory) => { if (!isDirectory) throw new Error("ACL failure"); } });
  expect(() => files.write(file, "fake")).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  expect(existsSync(file)).toBe(false);
  expect(readdirSync(directory)).toEqual([]);
});

it("bounds Windows rename retries and cleans up after the final failure", () => {
  const directory = path();
  const wait = vi.fn();
  const rename = vi.fn(() => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
  expect(() => privateFiles({ platform: "win32", acl: vi.fn(), rename, wait }).write(join(directory, "secret"), "fake"))
    .toThrow("busy");
  expect(wait.mock.calls.map(([ms]) => ms)).toEqual([25, 50, 100, 200, 400]);
  expect(readdirSync(directory)).toEqual([]);
});

it.each(["true", "TRUE", "1"])("forces read-only for %s", (value) => {
  expect(readOnlyForced({ VECTRA_AXI_READ_ONLY: value })).toBe(true);
});
it.each(["", "yes", "2"])("rejects invalid read-only boolean %j", (value) => {
  expect(() => readOnlyForced({ VECTRA_AXI_READ_ONLY: value })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it("redacts unknown service credentials by key and recognized value patterns", () => {
  const redactor = new SecretRedactor();
  expect(redactor.payload({ access_token: "unknown", text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature AccountKey=fake; https://blob.invalid/?sv=1&sig=fake", key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----" }))
    .toEqual({ access_token: "***redacted***", text: "***redacted*** AccountKey=***redacted***; https://blob.invalid/?sv=1&sig=***redacted***", key: "***redacted***" });
});
