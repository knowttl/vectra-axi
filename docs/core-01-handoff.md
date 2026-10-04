# CORE-01 handoff

See the [implementation plan](implementation-plan.md#core-01-handoff-and-acceptance) for prerequisite, scope and offline acceptance, and [session and investigation slices](implementation-plan.md#session-and-investigation-slices) for deferred work.
See [README.md](../README.md) for shipped session behavior and [design.md](design.md#architecture-and-module-depth) for the session contract.
The relevant capability records are the `qux.*` read operations and `qux.oauth.exchange` in the [inventory](../inventory/capabilities.json), which own routes, effects and permission constraints.

The [session implementation](../src/session.ts) exposes the integration interface below.
`createSession({ profile, configPath, redactor, transport })` returns `{ profile, request, resolveContinuation }`: a secret-free profile snapshot, an operation-scoped request and a continuation validator.
`request(operation, { pathParams, query, signal })` returns `{ status, body }`, with the decoded JSON body typed as `unknown` for later domain decoding and an optional `AbortSignal` forwarded through credential exchange and transport.
`resolveContinuation(operation, next, { pathParams })` returns a validated URL.
Supply the original path parameters for parameterized operations; omit the options for routes without parameters.
Pass `nodeTransport()` as the production `transport`; tests inject a `RawTransport` fake.
AUTH-02's `TokenTransport` accepts an optional `signal`; its sole implementation lives in the session.

The [collection reader](core-02-handoff.md) uses this interface for continuation handling.
See the [implementation plan](implementation-plan.md#session-and-investigation-slices) for CORE-02 and READ-01 responsibilities and [design.md](design.md#architecture-and-module-depth) for interface constraints.
