# CORE-02 handoff

See the [implementation plan](implementation-plan.md#session-and-investigation-slices) for scope and the CORE-02 acceptance row, and [design.md](design.md#collections-events-and-bounded-reads) for the paging contract.
See [README.md](../README.md) for shipped collection behavior.
Prerequisite is CORE-01 merged as `c25b194` (PR https://github.com/knowttl/vectra-axi/pull/6); branch from latest `origin/main`.

The [collection reader](../src/collections.ts) exposes the integration interface below.
`collect(session, operation, { query, pathParams, limit, signal, clock, policy })` returns `{ rows, total, complete, cursor?, error? }`: validated rows, a known-or-unknown total, completeness and an opaque cursor.
`resume(session, operation, cursor, args)` continues from a cursor after validating the original query context.
The default limit is 100 (`DEFAULT_COLLECTION_LIMIT`).
No command leaf calls the reader yet; READ-01 owns detection list/show.

Every page goes through the session's same-operation authorization: the reader validates each server-returned link with `resolveContinuation`, then re-requests through `request` with the validated link's query.
There is no second HTTP path and no raw fetch handle.
`page_size` is requested only where the operation's query allowlist declares it, and a caller-supplied value is never overridden.

Policy is one default (`pageSize 100`, `maxRequests 10`, `maxBytes 8 MiB`, `deadlineMs 60s`, `maxAttempts 3`, `baseDelayMs 500ms`, `maxDelayMs 10s`) with a per-call override seam for tests and later slices.
No reviewed per-endpoint ceiling evidence exists, so none is invented; endpoint deviations land in that default when evidenced.
QUX detection/host/account pages can reach 5000 rows upstream, but those routes accept no `page_size`, so whole pages are consumed.

Collection pages decode as `{ results: [], count?, next? }`.
`count` is the known total; `remaining_count` is never treated as a stable total, so its presence alone leaves the total unknown.
Malformed pages report `RESPONSE_INVALID`.
A limit ending inside a page issues a cursor with a within-page offset, and resuming refetches that page through the session; no row is lost or duplicated.
Empty pages with a continuation are skipped.
Repeated continuations report `CONTINUATION_REPEATED` without refetching.
Later-page runtime failures return validated rows with `complete: false`, the original error and a cursor at the pending page; caller usage errors still throw before any HTTP call.
The cursor binds profile identity, origin, version, operation, query/path context, pending page, offset, remaining limit and last known total.

Reads retry only reviewed transient statuses (429, 502, 503, 504), following the az-axi convention of honoring Retry-After delay-seconds or HTTP-date form, with doubling backoff when the header is absent or unusable.
Waits run on the injected clock against the deadline and are cancellable; a Retry-After beyond the remaining budget reports `DEADLINE_EXCEEDED` naming both delays, and cancellation reports `REQUEST_CANCELLED` with rows retained.

The session change is limited to what retries need: `RawTransport` responses carry an optional `retryAfter` string captured by `nodeTransport`, and the exported `parseRetryAfter`/`failedRead` helpers classify `REQUEST_FAILED` errors without touching their message, code or redaction.
Checkpoint and date-window feeds are rejected with `VALIDATION_ERROR`, not misread as collections; their slices reuse this module's clock, retry and cancellation shape.

The [collection acceptance suite](../test/collections.test.ts) covers every acceptance case through a real session with synthetic fixtures, a fake `RawTransport` and a manual fake clock (no sleeps), under the [external-network guard](../test/network-guard.ts).
`test/cli.test.ts` fails at its `npm pack` step in this environment on clean `origin/main` too; it is unrelated to this slice.
Detection list/show remains READ-01; RUX, audit windows, health events and writes are excluded.
