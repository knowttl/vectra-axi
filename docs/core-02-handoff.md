# CORE-02 handoff

See the [implementation plan](implementation-plan.md#session-and-investigation-slices) for scope and the CORE-02 acceptance row, and [design.md](design.md#collections-events-and-bounded-reads) for the paging contract.
See [README.md](../README.md) for shipped collection behavior.
Prerequisite is CORE-01 merged as `c25b194` (PR https://github.com/knowttl/vectra-axi/pull/6); branch from latest `origin/main`.

The [collection reader](../src/collections.ts) exposes the integration interface below.
`collect(session, operation, { query, pathParams, limit, signal, clock, policy })` returns `{ rows, total, complete, cursor?, error? }`: validated rows, a known-or-unknown total, completeness and an opaque cursor.
`resume(session, operation, cursor, args)` continues from a cursor after validating the original query context.
Use the [session interface](core-01-handoff.md) for requests and continuation validation; there is no raw fetch handle.
`RawTransport` responses carry an optional `retryAfter` string captured by `nodeTransport`.
The exported `failedRead` helper retrieves status/header metadata from `REQUEST_FAILED` errors without changing their message, code or redaction; `parseRetryAfter` interprets the header against the reader's injected clock.
Injected clocks implement `now()` and `sleep(ms, signal?)`; cancellable sleeps must release pending work when the signal aborts.

The [implementation plan](implementation-plan.md#session-and-investigation-slices) owns acceptance and deferred slice scope.
