# vectra-axi implementation slices

Status: planning baseline following the selected TypeScript, read-only-first and existing-SDK direction.
Repository: `knowttl/vectra-axi`; base: `main`.
Implementation is not authorized by this plan alone.
Use fresh implementation crews only after the separate build instruction.
The requested implementation model is GPT-6.1 Sol at medium effort.
This design session does not spawn those crews or switch its own model.

A dependency means its public contract is merged and usable.
Every slice uses synthetic fixtures and denies external network by default.
No slice's automated acceptance requires a real Vectra instance, credentials, sign-in or production data.
Recheck cited upstream contracts when implementing; record deployment/API/appliance-release prerequisites.

| ID | Deliverable | Depends on | Independent acceptance |
|---|---|---|---|
| INV-01 | Pin QUX/RUX capability inventory and sources | Approved plan | Every initial operation has version/release, route/effect, permissions/licence notes, source and disposition; no invented completeness percentage. |
| CLI-01 | TypeScript package shell, strict catalogue, leaf help and fast version | INV-01 schema | Unknown flags/combinations fail before HTTP; no-args/setup state, TOON and exit contracts; no network for version/help. |
| AUTH-01 | Profiles, QUX token authentication, verified TLS/private CA | CLI-01 | Explicit origin/version/kind, secret references, ambiguous-profile errors, no UI-login reuse, sentinel redaction. |
| AUTH-02 | QUX OAuth client credentials | AUTH-01 | Exact versioned token route, returned expiry, reacquisition without refresh-token assumption, bounded error behavior. |
| CORE-01 | Deep QUX session and fixture HTTP adapter | AUTH-02 | Known read/auth operations only; validate path/origin/redirect before credentials; credentials cannot escape through next links. |
| CORE-02 | Collections, bounded retries, cancellation and partial results | CORE-01 | Limit inside page preserves rows; known/unknown counts; repeated cursor, malformed page, rate-limit/deadline behavior with fake clock. |
| READ-01 | Detection list/show and first packaged investigation journey | CORE-02 | Filtering/fields/state/detail semantics, truncation/full, explicit empty and access errors, no external network. |
| READ-02 | Hosts/accounts/type-qualified entity reads | READ-01 | Same numeric IDs remain distinct, QUX type required, score labels truthful, unsupported filters rejected. |
| READ-03 | Detection/host/account notes and tags | READ-02 | Versioned note/tag shapes, text limits/full output, no write request possible. |
| READ-04 | Assignments, outcomes and users | READ-02 | Assignment versus resolution semantics, paginated data and denied/empty distinction. |
| READ-05 | Groups/members and triage rules | READ-02 | Group kinds preserved, paged membership, release-dependent AD group support and mutation refusal. |
| READ-06 | Audit windows | CORE-02 | Inclusive UTC day semantics, required bounded dates, response-byte cap and truthful partial/error behavior. |
| READ-07 | Health/checks and QUX health events | CORE-02 | Release-gated events, returned checkpoints, cached/fresh semantics as documented, no synthetic availability. |
| READ-08 | Lockdown status | READ-02 | Host/account status routes, product/permission limits, no unverified lockdown mutation. |
| PACK-01 | Read release, doctor, generated docs and installable skill | READ-01 through READ-08 | Offline packaged journeys, safe context/discovery, generated-doc freshness, explicit setup only. |
| RUX-01 | RUX v3.4 OAuth and base session adapter | PACK-01 | Unversioned token route, expiry/refresh handling, same session contracts and unchanged QUX output. |
| RUX-02 | RUX detections/entities/context reads | RUX-01 | Explicit urgency/importance versus QUX scores; RUX IDs/profile independent of QUX; supported query differences. |
| RUX-03 | RUX detection/scoring/audit events | RUX-02 | Exact checkpoint advancement, mid-page continuation, no invented total, cancellation and repeated-checkpoint protection. |
| RUX-04 | RUX notes/tags and assignments/context | RUX-02, READ-03, READ-04 | Version-specific entity/table selectors, note shapes and assignment semantics; split note/tag and assignment changes. |
| RUX-05 | RUX groups/members and triage rules | RUX-02, READ-05 | Group-kind and filter mappings, permissions and paged memberships; no QUX wire assumptions. |
| RUX-06 | RUX health and lockdown status | RUX-01, READ-07, READ-08 | Subscription-sensitive shapes, generation-specific routes and unsupported-check guidance. |
| API-01 | Optional reviewed raw-read surface | PACK-01 and explicit scope choice | Allowlisted operation/query/field policy, no arbitrary destination/header/method or sensitive-route bypass. |
| WRITE-00 | Mutation coordinator, fixture-only enablement | PACK-01 | Forced read-only, hand opt-in, original configured scope, preview/execute/confirm, durable intent/outcome, no ambiguous replay. |
| WRITE-01 | One selected note/tag/assignment mutation family | WRITE-00, corresponding reads | File/stdin payloads, desired-state/no-op semantics, target and permission tests; choose exact operation before dispatch. |
| WRITE-N | Remaining separately approved mutation families | WRITE-00, corresponding reads | One reviewed family per change; concurrency evidence, unknown outcome, audit failure and disruptive-confirmation cases. |

PACK-01 is a useful SOC read release, not full Vectra API coverage.
RUX-03, RUX-04 and WRITE-N contain multiple related operations and must be split into concrete family-sized changes before assignment when they do not fit a single reviewable contract.
RUX implementation follows the user's cloud-migration needs; later writes may proceed after the QUX read release without requiring cloud migration first.
Lockdown execution, v3.5 preview support, full API coverage, cross-instance data migration and automatic identity/score conversion are not authorized features.

Each handoff includes the slice ID, prerequisite commits, exact inventory rows, grammar, API/release/auth constraints, required sources and acceptance outcomes.
The operation catalogue is the single source for grammar, help and capability documentation.
Use the session's existing seams; do not introduce a parallel HTTP or fixture system to implement a new endpoint.
When a real product choice is discovered, raise it before deciding it.
Use the repository validation/shipping gate for every authorized change, preserving user constraints in its intent.

See [design.md](design.md) for source evidence, architecture, paging, profile, output and write-policy contracts.

## Commissioning sequence

Use one isolated feature branch and one narrowly scoped handoff per slice.
The next crew receives merged prerequisite contracts, not another crew's in-progress private interface.
Do not make every phase one umbrella task or commission the entire catalogue as a single change.

| Phase | Slices | Review checkpoint |
|---|---|---|
| 0: executable contract | INV-01, CLI-01 | Inventory, grammar and output conventions agree; no runtime support claims beyond implemented leaves. |
| 1: first investigation | AUTH-01, AUTH-02, CORE-01, CORE-02, READ-01 | Packaged CLI lists a synthetic detection, shows it, resumes safely and refuses all business writes. |
| 2: useful QUX release | READ-02 through READ-08, PACK-01 | A complete synthetic on-prem investigation can inspect entities, notes/tags, assignment, rules/groups, audit, health and lockdown status. |
| 3: cloud adoption | RUX-01 through RUX-06 | Explicit cloud profile passes the shared contracts; QUX output stays stable and generation-specific semantics remain visible. |
| 4: controlled changes | WRITE-00, then selected WRITE-01/WRITE-N | Each enabled mutation has independently verified policy, preview, confirmation, outcome and audit behavior. |
| 5: deliberate expansion | Optional API-01 and separately selected long-tail families | The capability map records exact named/raw/blocked/planned dispositions; there is no unrestricted passthrough. |

Phase 1 is sequential because each step establishes a contract used by the next.
After READ-02 and CORE-02 merge, phases within the remaining QUX read tranche may be commissioned independently if their files and public contracts do not conflict.
Phase 3 and the mutation coordinator may follow PACK-01 independently, subject to firstmate's dispatch and the user's priorities.
No worker edits the common session's public interface unilaterally while another commissioned slice relies on it.
A change to that interface gets a small prerequisite change and updated handoffs.

## Phase 0: turn design knowledge into one executable catalogue

INV-01 inventories only the agreed domains first and records the long tail as explicitly planned or unreviewed.
Each record needs operation ID, command leaf, deployment/API/release constraints, method/path, effect, supported filters/fields, paging kind, evidence, permissions/licence notes and expected fixture cases.
The inventory does not auto-enable an endpoint merely because it exists in a downloaded specification.
Credential-export routes are blocked even if they use GET.
Adopt the published schema as evidence; do not commit proprietary bulk documentation or assume full code generation is valid.

CLI-01 extends the Node/TypeScript and Vitest tooling introduced by INV-01 with the command shell and existing AXI SDK, reusing the network-denying test harness.
See [README.md](../README.md) for development commands.
The command catalogue should drive strict leaf parsing, concise help and capability documentation rather than separate lists drifting apart.
Start with unconfigured home/setup state and implemented commands only.
Specify accepted global flags, mutually exclusive flags and unknown-input behavior once, then let individual leaves declare their own parameters.
Use a leaf version module and defer the command graph so `-v`, `-V` and `--version` remain fast and credential-free.

Completion evidence is a packaged invocation with closed stdin and a clean synthetic home directory, showing version/help, a missing-profile error and an unknown-flag error with the documented stdout/stderr/exit behavior.
Do not add endpoint dispatch stubs that claim support before an adapter exists.

## Phase 1: prove the session with one real user journey

AUTH-01/02 establish the profile schema and actual credential lifecycle behind the session's implementation.
Reject mixed token/OAuth fields and unsupported generation/auth combinations at configuration load.
An OAuth token POST is an explicitly named credential exchange and never grants permission for an arbitrary business POST.
Token expiry, failed credentials, denied access and TLS trust errors have distinct actionable codes.
Known secret values are scrubbed from errors as well as ordinary results, debug output and later audit metadata.

CORE-01 owns URL construction, operation authorization, credential attachment and response validation in one path.
Redirects cannot move credential-bearing requests to another origin; continuation links are validated again rather than trusted because the first page was safe.
Tests must observe that a denied destination receives no credential or HTTP call, including a fixture credential that could otherwise write.
Do not expose a raw authenticated fetch object to command handlers.

CORE-02 exposes bounded result windows rather than leaking backend page mechanics to callers.
Its contract covers a limit ending within a page, an empty page with continuation, malformed data, a repeated continuation, a later-page failure and cancellation while waiting for Retry-After.
Default normal list output is 100, with endpoint-specific page sizes and request/byte/deadline ceilings defined alongside the operation.
The cursor preserves any unreturned rows or offset and validates the original query context before resuming.
Read retry policy and clock behavior are exercised with fake time.

READ-01 connects the catalogue and session to detection list/show.
Use documented server-side state/filter/field mappings, clear truncation metadata and explicit empty results.
One packaged E2E journey lists a synthetic detection, follows the suggested show command with the same profile, reads full detail and resumes a capped list without losing a row.
This journey establishes the CLI integration convention for later slices; do not duplicate it for every endpoint.

## Phase 2: finish the on-prem SOC read release

READ-02 adds host/account lookup and a type-qualified entity facade.
Reject mixed QUX entity listing rather than constructing an artificial merged ranking.
Fixture cases deliberately give a host and account the same numeric ID and different threat/certainty values.
Detail relationships retain the resource kind needed for the next command.

READ-03 retrieves notes and tags through their actual versioned routes.
Handle an embedded truncated note summary separately from the full notes resource; do not imply `--full` can recover content the upstream response never returned.
READ-04 exposes assignments, outcomes and users as distinct resources and preserves unresolved versus resolved semantics.
READ-05 preserves group types, retrieves paged members and reads triage rules without treating rule existence as evidence that a detection is benign.

READ-06 uses bounded inclusive UTC date windows for QUX audit requests, checks the response-byte ceiling and never starts from the API's unbounded date defaults.
If a window is too large, suggest a smaller date range rather than silently truncating and claiming completion.
READ-07 differentiates health snapshots from checkpoint events and checks release-specific support.
READ-08 reports account/host lockdown status without inventing a manual lockdown action.
For these operational reads, permission or licence denial is an error/disposition, not an empty healthy result.

PACK-01 assembles the first useful release, with installation instructions, explicit setup, doctor, generated help/skill and coverage records.
Doctor performs only documented bounded reads when explicitly invoked; it never tries passwords, signs in interactively or enables writes.
Its offline acceptance covers configuration errors and synthetic connectivity/auth/access failures.
Release notes must call this the supported QUX SOC read surface, not full Vectra coverage.

## Phase 3: adopt RUX without making callers relearn the tool

RUX-01 adds the separate unversioned OAuth token exchange and the v3.4 profile contract.
RUX-02 maps existing caller operations to the documented RUX routes and preserves urgency/importance as distinct fields.
Cloud IDs remain scoped to their cloud profile; no implicit on-prem identity translation is part of a show command.

Split RUX-03 into detection events and entity-scoring/audit events if the response or filter mappings require separate review.
Each feed uses its returned checkpoint and tests a non-advancing checkpoint, inclusive boundary behavior, remaining-count interpretation and an output limit inside an upstream batch.
Never infer the next event ID from the number of returned events.
RUX audit date convenience flags expand to the documented timestamp contract, while lower-level supported time filters remain explicit.

RUX-04/05/06 migrate the remaining named read families through the session interface, with new fixtures rather than assuming QUX response compatibility.
Run unchanged QUX contract cases alongside each RUX change.
v3.5 support requires its own version-diff assessment after the preview contract becomes suitable; it is not a hidden fallback for missing 3.4 fields.

## Phase 4: add writes as a new capability, one family at a time

WRITE-00 is entirely fixture-driven until named mutation families are enabled.
It implements forced read-only, hand-edited opt-in, immutable original origin/operation scope, current-state preview, execute/confirmation requirements and audit intent/outcome.
The transport independently rejects a mutation without coordinator authorization.
Read flags, environment profile overrides and later raw-read access cannot widen the configured write scope.

The first named write must be selected from note, tag or assignment operations before its crew is commissioned.
This is a later product choice rather than a blocker for the read release or this design.
Define whether the command is desired-state or action-shaped and document no-op behavior accordingly.
Do not make additive note creation falsely idempotent by dropping repeated intended notes.
Tests cover changed current state, denied target, missing/mismatched confirmation, failure to write audit intent and a server-accepted mutation followed by a client timeout.

Further writes require exact upstream concurrency evidence, effect classification and the same coordinator.
Closing/reopening detections, resolving assignments and changing triage rules must remain distinct operations.
If safe concurrency is unavailable for a high-impact operation, document the limitation and keep that operation disabled until its policy is deliberately resolved.
Do not promise rollback for actions without a reliable inverse.

## Per-slice handoff template

Every fresh GPT-6.1 Sol medium-effort crew receives:

1. The slice ID, exact goal, prerequisite commits and owning branch/base.
2. The relevant accepted design paragraphs and operation catalogue records.
3. Exact command leaves, flags, output shape and supported deployment/API/release/auth modes.
4. Named files/modules expected to change, with any shared-interface changes isolated first.
5. Source URLs/snapshots and the specific permission/licence constraints to revalidate.
6. Observable acceptance cases, existing fixture conventions and external-network denial.
7. Explicit exclusions, including real instances, unapproved mutations and unrelated cleanup.
8. The repository's validation/delivery instructions and the required evidence on completion.

Before declaring a phase complete, compare delivered catalogue records with its agreed inventory and list every unsupported or deferred operation explicitly.
Documentation and fixtures must describe what actually shipped, while future phases remain marked planned.
Commissioning a slice is not permission to broaden it to adjacent API families.
