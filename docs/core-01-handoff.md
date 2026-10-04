# CORE-01 handoff

See the [implementation plan](implementation-plan.md#session-and-investigation-slices) for prerequisite, scope, deferred slices and offline acceptance.
See [README.md](../README.md) for shipped session behavior and [design.md](design.md#architecture-and-module-depth) for the session contract.
The relevant capability records are the `qux.*` read operations and `qux.oauth.exchange` in the [inventory](../inventory/capabilities.json), which own routes, effects and permission constraints.

The [session](../src/session.ts) is the only authenticated path command handlers receive.
`createSession({ profile, configPath, redactor, transport })` returns `{ profile, request, resolveContinuation }`: a secret-free profile snapshot, an operation-scoped request and a continuation validator.
No transport, fetch handle or credential material is exposed on that object.
`request(operation, { pathParams, query })` authorizes the operation against the inventory (known QUX reads only), builds the URL from the record's route template and allowlisted query keys, validates the destination, then resolves the credential (personal token or the named OAuth exchange over the same adapter) and sends one GET.
Same-origin HTTPS redirects under the profile's version prefix are re-validated and followed up to 3 hops; anything outside the origin reports `DESTINATION_DENIED` before a credential is sent or a further call is made.
Resource responses map 401/403 through the AUTH-01 failure classifier, report unmapped statuses as `REQUEST_FAILED` without retry, and require valid JSON (`RESPONSE_INVALID`).
`resolveContinuation(operation, next)` validates a next link's destination without fetching it.
`nodeTransport()` is the production adapter (verified TLS, 30s deadline, 8MB body ceiling, manual redirect handling); tests inject fakes and deny external network.
AUTH-02's `TokenTransport` type is unchanged, but its sole implementation now lives in the session, so there is one HTTP path, not two.

CORE-02 owns paging, bounded retries, cancellation and partial results on top of this contract: call `resolveContinuation` before following any server-returned link, and keep every follow-up request inside `request` so authorization and credential rules cannot be bypassed.
Collections must preserve unreturned rows, detect repeated links and enforce request/byte/deadline budgets.
READ-01 connects the first command leaves to `request` and establishes the CLI integration convention.
Do not widen the authorized operation set, expose the transport, or add a parallel HTTP or fixture system.
