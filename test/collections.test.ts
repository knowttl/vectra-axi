import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { collect, DEFAULT_COLLECTION_LIMIT, resume, type Clock } from "../src/collections.js";
import { loadConfig, selectProfile } from "../src/profiles.js";
import { SecretRedactor } from "../src/redact.js";
import { createSession, parseRetryAfter, type RawTransport, type Session } from "../src/session.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".collections-test-"));
const path = join(scratch, "config.json");
const tokenProfile = {
  kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "SENTINEL_TOKEN",
};
const token = "fake-token-SENTINEL";

beforeEach(() => {
  vi.stubEnv("SENTINEL_TOKEN", token);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(path, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function session(transport: RawTransport, profile: Record<string, unknown> = { ...tokenProfile }): Session {
  writeFileSync(path, JSON.stringify({ profiles: { lab: profile } }));
  const loaded = loadConfig(path, new SecretRedactor());
  return createSession({ profile: selectProfile(loaded.config, "lab"), configPath: loaded.path,
    redactor: new SecretRedactor(), transport });
}

const ids = (count: number, start = 1): unknown[] => Array.from({ length: count }, (_, index) => ({ id: start + index }));
const page = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200, bodyText: JSON.stringify({ results: rows, ...extra }),
});
const nextPage = "https://fixture.invalid/api/v2.5/detections?min_id=9";

// Manual clock: no timers, no sleeps. Tests flush microtasks, then advance.
function fakeClock() {
  let now = 1_000_000;
  const waits: { at: number; resolve: () => void }[] = [];
  const started: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      started.push(ms);
      const onAbort = (): void => {
        waits.splice(waits.indexOf(wait), 1);
        reject(new Error("aborted"));
      };
      const wait = { at: now + ms, resolve: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      } };
      waits.push(wait);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  };
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    for (const wait of [...waits].filter((wait) => wait.at <= now)) {
      waits.splice(waits.indexOf(wait), 1);
      wait.resolve();
    }
  };
  const flush = async (rounds = 50): Promise<void> => {
    for (let index = 0; index < rounds; index++) await Promise.resolve();
  };
  return { clock, advance, flush, started, pending: () => waits.length };
}

it("returns rows with a known total when the page carries a count", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(page(ids(2), { count: 2 }));
  const result = await collect(session(transport), "qux.detection.list");
  expect(result).toEqual({ rows: ids(2), total: 2, complete: true });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("reports an unknown total when the page carries remaining_count instead of count", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(page(ids(2), { remaining_count: 40 }));
  const result = await collect(session(transport), "qux.detection.list");
  expect(result).toEqual({ rows: ids(2), total: null, complete: true });
});

it("caps the default read at 100 rows with a continuation", async () => {
  expect(DEFAULT_COLLECTION_LIMIT).toBe(100);
  const transport = vi.fn<RawTransport>().mockResolvedValue(page(ids(150), { count: 150, next: nextPage }));
  const result = await collect(session(transport), "qux.detection.list");
  expect(result.rows).toHaveLength(100);
  expect(result).toMatchObject({ total: 150, complete: true });
  expect(result.cursor).toBeDefined();
  expect(transport).toHaveBeenCalledTimes(1);
});

it("preserves unreturned rows when the limit ends inside a page", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(page(ids(5), { count: 5 }));
  const owned = session(transport);
  const first = await collect(owned, "qux.detection.list", { limit: 2 });
  expect(first.rows).toEqual(ids(2));
  expect(first).toMatchObject({ total: 5, complete: true });
  expect(first.cursor).toBeDefined();
  const second = await resume(owned, "qux.detection.list", first.cursor!);
  expect(second).toEqual({ rows: ids(3, 3), total: 5, complete: true });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1]![0].url).toBe("https://fixture.invalid/api/v2.5/detections");
});

it("skips an empty page that carries a continuation", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page([], { next: nextPage }))
    .mockResolvedValueOnce(page(ids(2), { count: 2 }));
  const result = await collect(session(transport), "qux.detection.list");
  expect(result).toEqual({ rows: ids(2), total: 2, complete: true });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1]![0].url).toBe(nextPage);
});

it("keeps validated rows when a later page is malformed", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(2), { count: 4, next: nextPage }))
    .mockResolvedValueOnce({ status: 200, bodyText: JSON.stringify({ results: "nope" }) });
  const result = await collect(session(transport), "qux.detection.list");
  expect(result.rows).toEqual(ids(2));
  expect(result).toMatchObject({ total: 4, complete: false });
  expect(result.error).toMatchObject({ code: "RESPONSE_INVALID" });
  expect(result.cursor).toBeDefined();
});

it("keeps validated rows when a later page fails", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(2), { count: 4, next: nextPage }))
    .mockResolvedValueOnce({ status: 500, bodyText: "boom" });
  const result = await collect(session(transport), "qux.detection.list");
  expect(result.rows).toEqual(ids(2));
  expect(result).toMatchObject({ total: 4, complete: false });
  expect(result.error).toMatchObject({ code: "REQUEST_FAILED" });
  expect(result.cursor).toBeDefined();
  expect(transport).toHaveBeenCalledTimes(2);
});

it("stops on a repeated continuation without refetching it", async () => {
  const loop = "https://fixture.invalid/api/v2.5/detections?min_id=5";
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(2), { next: loop }))
    .mockResolvedValueOnce(page(ids(2, 3), { next: loop }));
  const result = await collect(session(transport), "qux.detection.list");
  expect(result.rows).toEqual(ids(4));
  expect(result).toMatchObject({ complete: false });
  expect(result.error).toMatchObject({ code: "CONTINUATION_REPEATED" });
  expect(transport).toHaveBeenCalledTimes(2);
});

it("stops a multi-page cycle across page-boundary resumes", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(100), { next: nextPage }))
    .mockResolvedValueOnce(page(ids(100, 101), { next: "https://fixture.invalid/api/v2.5/detections" }))
    .mockResolvedValueOnce(page(ids(100, 101), { next: "https://fixture.invalid/api/v2.5/detections" }));
  const owned = session(transport);
  const first = await collect(owned, "qux.detection.list");
  expect(first).toMatchObject({ rows: ids(100), complete: true, cursor: expect.any(String) });
  const second = await resume(owned, "qux.detection.list", first.cursor!);
  expect(second).toMatchObject({ rows: ids(100, 101), complete: false,
    error: { code: "CONTINUATION_REPEATED" } });
  const third = await resume(owned, "qux.detection.list", second.cursor!);
  expect(third).toMatchObject({ rows: [], complete: false, error: { code: "CONTINUATION_REPEATED" } });
  expect(transport).toHaveBeenCalledTimes(3);
  expect(transport.mock.calls[2]![0].url).toBe(nextPage);
});

it("keeps cycle history across within-page resumes without rejecting the pending page", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(2), { next: nextPage }))
    .mockResolvedValueOnce(page(ids(2), { next: nextPage }))
    .mockResolvedValueOnce(page(ids(2, 3), { next: "https://fixture.invalid/api/v2.5/detections" }));
  const owned = session(transport);
  const first = await collect(owned, "qux.detection.list", { limit: 1 });
  expect(first).toMatchObject({ rows: ids(1), complete: true });
  const second = await resume(owned, "qux.detection.list", first.cursor!, { limit: 1 });
  expect(second).toMatchObject({ rows: ids(1, 2), complete: true });
  const third = await resume(owned, "qux.detection.list", second.cursor!);
  expect(third).toMatchObject({ rows: ids(2, 3), complete: false, error: { code: "CONTINUATION_REPEATED" } });
  expect(transport).toHaveBeenCalledTimes(3);
});

it("keeps cycle history when resuming after a failed page", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(2), { next: nextPage }))
    .mockResolvedValueOnce({ status: 500, bodyText: "failed" })
    .mockResolvedValueOnce(page(ids(2, 3), { next: "https://fixture.invalid/api/v2.5/detections" }));
  const owned = session(transport);
  const first = await collect(owned, "qux.detection.list");
  expect(first).toMatchObject({ rows: ids(2), complete: false, error: { code: "REQUEST_FAILED" } });
  const second = await resume(owned, "qux.detection.list", first.cursor!);
  expect(second).toMatchObject({ rows: ids(2, 3), complete: false, error: { code: "CONTINUATION_REPEATED" } });
  expect(transport).toHaveBeenCalledTimes(3);
});

it("returns an explicit partial on first-page access denial", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status: 403, bodyText: "{}" });
  const result = await collect(session(transport), "qux.detection.list");
  expect(result).toEqual({
    rows: [], total: null, complete: false,
    cursor: expect.any(String), error: expect.objectContaining({ code: "ACCESS_DENIED" }),
  });
});

it("retries a rate-limited page after its Retry-After wait", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 429, retryAfter: "5", bodyText: "slow down" })
    .mockResolvedValueOnce(page(ids(2), { count: 2 }));
  const { clock, advance, flush, started } = fakeClock();
  const pending = collect(session(transport), "qux.detection.list", { clock });
  await flush();
  expect(started).toEqual([60_000, 5000]);
  await advance(5000);
  expect(await pending).toEqual({ rows: ids(2), total: 2, complete: true });
  expect(transport).toHaveBeenCalledTimes(2);
});

it("retries with backoff when Retry-After is unusable", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 503, retryAfter: "not-a-date", bodyText: "busy" })
    .mockResolvedValueOnce(page(ids(1), { count: 1 }));
  const { clock, advance, flush, started } = fakeClock();
  const pending = collect(session(transport), "qux.detection.list", { clock });
  await flush();
  expect(started).toEqual([60_000, 500]);
  await advance(500);
  expect(await pending).toEqual({ rows: ids(1), total: 1, complete: true });
});

it("honors an HTTP-date Retry-After through the fake clock", async () => {
  const at = new Date(1_000_000 + 2000).toUTCString();
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 429, retryAfter: at, bodyText: "slow down" })
    .mockResolvedValueOnce(page(ids(1), { count: 1 }));
  const { clock, advance, flush, started } = fakeClock();
  const pending = collect(session(transport), "qux.detection.list", { clock });
  await flush();
  expect(started).toEqual([60_000, 2000]);
  await advance(2000);
  expect(await pending).toEqual({ rows: ids(1), total: 1, complete: true });
});

it("reports when a Retry-After delay exceeds the remaining deadline", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce({ status: 429, retryAfter: "30", bodyText: "slow down" });
  const { clock, flush, started } = fakeClock();
  const pending = collect(session(transport), "qux.detection.list", { clock, policy: { deadlineMs: 1000 } });
  await flush();
  const result = await pending;
  expect(result).toMatchObject({ rows: [], complete: false });
  expect(result.error).toMatchObject({ code: "DEADLINE_EXCEEDED" });
  expect(String(result.error?.message)).toContain("exceeds the remaining");
  expect(started).toEqual([1000]);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("surfaces the last failure after bounded transient retries", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status: 503, bodyText: "busy" });
  const { clock, advance, flush, started } = fakeClock();
  const pending = collect(session(transport), "qux.detection.list", { clock });
  await flush();
  await advance(500);
  await flush();
  await advance(1000);
  const result = await pending;
  expect(result).toMatchObject({ complete: false });
  expect(result.error).toMatchObject({ code: "REQUEST_FAILED" });
  expect(started).toEqual([60_000, 500, 59_500, 1000, 58_500]);
  expect(transport).toHaveBeenCalledTimes(3);
});

it("cancels while waiting for Retry-After and keeps validated rows", async () => {
  const controller = new AbortController();
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(1), { count: 3, next: nextPage }))
    .mockResolvedValueOnce({ status: 429, retryAfter: "30", bodyText: "slow down" });
  const { clock, flush } = fakeClock();
  const pending = collect(session(transport), "qux.detection.list", { clock, signal: controller.signal });
  await flush();
  controller.abort();
  const result = await pending;
  expect(result.rows).toEqual(ids(1));
  expect(result).toMatchObject({ total: 3, complete: false });
  expect(result.error).toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(result.cursor).toBeDefined();
  expect(transport).toHaveBeenCalledTimes(2);
});

it("stops at the byte budget without consuming the breaching page", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(page(ids(10), { count: 10 }));
  const result = await collect(session(transport), "qux.detection.list", { policy: { maxBytes: 50 } });
  expect(result).toMatchObject({ rows: [], complete: false });
  expect(result.error).toMatchObject({ code: "BYTE_BUDGET_EXCEEDED" });
  expect(result.cursor).toBeDefined();
});

it.each([
  ["cancel", (controller: AbortController, _advance: (ms: number) => Promise<void>) => controller.abort(), "REQUEST_CANCELLED"],
  ["deadline", (_controller: AbortController, advance: (ms: number) => Promise<void>) => advance(1000), "DEADLINE_EXCEEDED"],
] as const)("stops an in-flight read on %s before accepting late rows", async (_stop, stopRead, code) => {
  const controller = new AbortController();
  let respond!: (response: Awaited<ReturnType<RawTransport>>) => void;
  const transport = vi.fn<RawTransport>(() => new Promise((resolve) => { respond = resolve; }));
  const { clock, advance, flush, pending: waits } = fakeClock();
  const pending = collect(session(transport), "qux.detection.list", {
    clock, signal: controller.signal, policy: { deadlineMs: 1000 },
  });
  await flush();
  await stopRead(controller, advance);
  const result = await pending;
  expect(result).toMatchObject({ rows: [], complete: false,
    error: { code } });
  expect(waits()).toBe(0);
  respond(page(ids(2)));
  await flush();
  expect(result.rows).toEqual([]);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("rejects a successful response whose arrival exceeds the deadline", async () => {
  const { clock, advance } = fakeClock();
  const transport = vi.fn<RawTransport>(async () => {
    await advance(2000);
    return page(ids(2));
  });
  const result = await collect(session(transport), "qux.detection.list", {
    clock, policy: { deadlineMs: 1000 },
  });
  expect(result).toMatchObject({ rows: [], complete: false, error: { code: "DEADLINE_EXCEEDED" } });
});

it.each([1, 5])("resumes after a denied continuation without replaying rows at limit %i", async (limit) => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(1), { next: "https://collector.invalid/api/v2.5/detections" }))
    .mockResolvedValueOnce(page(ids(1), { next: nextPage }))
    .mockResolvedValueOnce(page(ids(1, 2)));
  const owned = session(transport);
  const first = await collect(owned, "qux.detection.list", { limit });
  expect(first).toMatchObject({ rows: ids(1), complete: false, error: { code: "DESTINATION_DENIED" } });
  const second = await resume(owned, "qux.detection.list", first.cursor!);
  expect(second).toEqual({ rows: ids(1, 2), total: null, complete: true });
});

it.each([
  [9, "9", 2], [9, "9", 100], [true, "true", 2], ["9", "9", 2],
] as const)("detects wire-equivalent repeated continuations for %s (%s) at limit %i", async (minId, wire, limit) => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(page(ids(2), {
    next: `https://fixture.invalid/api/v2.5/detections?min_id=${wire}`,
  }));
  const result = await collect(session(transport), "qux.detection.list", {
    query: { min_id: minId }, limit,
  });
  expect(result).toMatchObject({ rows: ids(2), complete: false, error: { code: "CONTINUATION_REPEATED" } });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("releases the real Retry-After timer when cancelled", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const transport = vi.fn<RawTransport>().mockResolvedValue({ status: 429, retryAfter: "30", bodyText: "busy" });
  const pending = collect(session(transport), "qux.detection.list", { signal: controller.signal });
  await fakeClock().flush();
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  expect(await pending).toMatchObject({ complete: false, error: { code: "REQUEST_CANCELLED" } });
  expect(vi.getTimerCount()).toBe(0);
});

it("stops at the request budget and resumes the pending page", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(2), { count: 4, next: nextPage }))
    .mockResolvedValueOnce(page(ids(2, 3)));
  const owned = session(transport);
  const result = await collect(owned, "qux.detection.list", { policy: { maxRequests: 1 } });
  expect(result.rows).toEqual(ids(2));
  expect(result).toMatchObject({ total: 4, complete: false });
  expect(result.error).toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
  const resumed = await resume(owned, "qux.detection.list", result.cursor!, { policy: { maxRequests: 5 } });
  expect(resumed).toEqual({ rows: ids(2, 3), total: 4, complete: true });
});

it("refuses a cross-origin continuation without fetching it", async () => {
  const transport = vi.fn<RawTransport>()
    .mockResolvedValueOnce(page(ids(1), {
      count: 2, next: "https://collector.invalid/api/v2.5/detections?min_id=9",
    }));
  const result = await collect(session(transport), "qux.detection.list");
  expect(result.rows).toEqual(ids(1));
  expect(result).toMatchObject({ complete: false });
  expect(result.error).toMatchObject({ code: "DESTINATION_DENIED" });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(transport.mock.calls)).not.toContain("collector.invalid");
});

it("requests page_size only where the operation declares it", async () => {
  const detections = vi.fn<RawTransport>().mockResolvedValue(page([]));
  await collect(session(detections), "qux.detection.list");
  expect(detections.mock.calls[0]![0].url).toBe("https://fixture.invalid/api/v2.5/detections");
  const members = vi.fn<RawTransport>().mockResolvedValue(page([]));
  await collect(session(members), "qux.group.member.list", { pathParams: { id: 7 } });
  expect(members.mock.calls[0]![0].url).toBe("https://fixture.invalid/api/v2.5/groups/7/members?page_size=100");
  const sized = vi.fn<RawTransport>().mockResolvedValue(page([]));
  await collect(session(sized), "qux.group.member.list", { pathParams: { id: 7 }, query: { page_size: 25 } });
  expect(sized.mock.calls[0]![0].url).toBe("https://fixture.invalid/api/v2.5/groups/7/members?page_size=25");
});

it("rejects a non-collection operation before any HTTP call", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(collect(session(transport), "qux.health.list")).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("does not use collection paging"),
  });
  expect(transport).not.toHaveBeenCalled();
});

it("rejects an unknown operation without resolving a credential", async () => {
  const transport = vi.fn<RawTransport>();
  await expect(collect(session(transport), "qux.detection.destroy")).rejects.toMatchObject({
    code: "OPERATION_UNKNOWN",
  });
  expect(transport).not.toHaveBeenCalled();
});

it("rejects caller usage errors before any HTTP call", async () => {
  const transport = vi.fn<RawTransport>();
  const owned = session(transport);
  await expect(collect(owned, "qux.detection.list", { query: { unknown: "x" } }))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(collect(owned, "qux.detection.list", { limit: 0 })).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  });
  expect(transport).not.toHaveBeenCalled();
});

it("rejects a cursor resumed under a changed query context", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(page(ids(5), { count: 5 }));
  const owned = session(transport);
  const first = await collect(owned, "qux.detection.list", { query: { state: "active" }, limit: 2 });
  expect(first.cursor).toBeDefined();
  await expect(resume(owned, "qux.detection.list", first.cursor!, { query: { state: "closed" } }))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("query context") });
  await expect(resume(owned, "qux.host.list", first.cursor!))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(resume(owned, "qux.detection.list", "not-a-cursor"))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("rejects a cursor resumed under a different profile", async () => {
  const transport = vi.fn<RawTransport>().mockResolvedValue(page(ids(5), { count: 5 }));
  const first = await collect(session(transport), "qux.detection.list", { limit: 2 });
  const other = session(transport, { ...tokenProfile, origin: "https://other.invalid" });
  await expect(resume(other, "qux.detection.list", first.cursor!)).rejects.toMatchObject({
    code: "VALIDATION_ERROR", message: expect.stringContaining("different profile"),
  });
});

it.each([
  ["delay seconds", "5", 1_000_000, 5000],
  ["zero delay", "0", 1_000_000, 0],
  ["padded seconds", "  30 ", 1_000_000, 30_000],
  ["future HTTP date", new Date(1_002_000).toUTCString(), 1_000_000, 2000],
  ["past HTTP date", new Date(999_000).toUTCString(), 1_000_000, 0],
  ["garbage", "soon", 1_000_000, undefined],
  ["absent header", undefined, 1_000_000, undefined],
  ["unsafe integer", "99999999999999999999", 1_000_000, undefined],
])("parses Retry-After %s", (_name, header, nowMs, waitMs) => {
  expect(parseRetryAfter(header as string | undefined, nowMs as number)).toBe(waitMs);
});
