# vectra-axi design

Planning baseline prepared on 2026-10-03.
This document describes intended behavior, not implemented commands.
TypeScript, a read-only first release, and existing AXI SDK reuse were selected during the design review.
Implementation requires a separate build instruction.

## Purpose and scope

Provide an agent-friendly CLI for Vectra investigations, starting with an on-prem Quadrant UX (QUX) instance and preserving familiar commands when a future Respond UX (RUX) deployment is adopted.
Map both generations now, implement QUX first, and add RUX through the same caller-facing interface later.
The first release covers the SOC read journeys in the [implementation plan](implementation-plan.md).
Gated business mutations are a later phase.
This is not a commitment to implement every endpoint in Vectra's APIs.

The user's current interactive login is integrated with Active Directory, and API credentials are also available.
The appliance release, API version, and API credential type have not been confirmed.
Interactive LAN authentication must not be mistaken for an API authentication contract.
No design validation or automated test connects to a real Vectra instance.

## Accepted decisions

| Decision | Choice and consequence |
|---|---|
| Language | TypeScript, using direct HTTPS and the existing AXI SDK, consistent with az-axi and the approved mg-axi plan. |
| Launch behavior | Read-only first, including when the upstream credential has write permissions. |
| Shared code | Reuse the existing SDK and conventions now; extract new common behavior only when real callers justify it. |
| Deployment | QUX/on-prem first; RUX/cloud adapter later, with explicit profile selection. |
| Writes | Later named operations, hand-enabled profiles, previews, execution/confirmation gates and audit records. |

TypeScript is a contextual maintenance choice rather than a claim that Python is less capable.
VAT offers substantial Python endpoint coverage and upstream protocol maintenance.
It remains a pinned research reference; the CLI does not invoke Python or depend on VAT at runtime.
Both languages would need runtime decoding, safe credentials, paging, AXI output and policy enforcement.

## Evidence and API contracts

Research snapshots:

- [vectra_api_tools](https://github.com/vectranetworks/vectra_api_tools/tree/c76fd0c5d42e74b199e47dc42923582c2b1dbee7), commit `c76fd0c5d42e74b199e47dc42923582c2b1dbee7`.
- [az-axi](https://github.com/knowttl/az-axi/tree/7d31138eb82e0fc6adec867e7690be6cf87725b6), verified latest origin/main at `7d31138eb82e0fc6adec867e7690be6cf87725b6` on the research date.
- [QUX v2.5 guide](https://docs.vectra.ai/configuration/access/api-qux/v25-api-guide-qux), its attached 173-page October-2025-named PDF, and the separately updated release change log.
- [RUX specification](https://apidocs.vectra.ai/vectraai-rest-api.yaml), SHA-256 `ee93e15a22d5041d1764c6e942ffc7bc359e52feff8cec79a8a6036e89b1a0f3` on the research date.

CLI-01 additionally uses [az-axi at `a7c1ca4bb605f3835d1717dde553f349a81b646f`](https://github.com/knowttl/az-axi/tree/a7c1ca4bb605f3835d1717dde553f349a81b646f) for catalogue-first validation, SDK output and refusal of implicit update.
The SDK dependency version is pinned in [package.json](../package.json).

AUTH-01 additionally uses the [official QUX personal-token guide](https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-token-auth) and the `Token` scheme in [pinned VAT vectra.py](https://github.com/vectranetworks/vectra_api_tools/blob/c76fd0c5d42e74b199e47dc42923582c2b1dbee7/modules/vectra.py#L235).
[az-axi at d02a9739](https://github.com/knowttl/az-axi/tree/d02a9739a50f35a2a69c340e4f8cbe724856fbdf) supplies profile precedence and SDK output/error-boundary conventions.
Its automatic local config discovery and implicit UI authentication are excluded by the Vectra profile contract below.

Recheck upstream contracts before implementing a slice.
The public RUX document identifies v3.4 as stable and v3.5 as preview.
[Preview guidance](https://apidocs.vectra.ai/api-v3-5-preview) warns of potentially incompatible filtering, errors and response tiers.
Do not silently adopt preview behavior or a floating latest API version.

| Deployment | Resource prefix | Credential exchange |
|---|---|---|
| QUX v2.5 personal token | `/api/v2.5` | Send `Authorization: Token …`. |
| QUX v2.5 OAuth | `/api/v2.5` | Basic client authentication on `POST /api/v2.5/oauth2/token`, form `grant_type=client_credentials`; Bearer on resources. |
| RUX v3.4 OAuth | `/api/v3.4` | Basic client authentication on `POST /oauth2/token`; Bearer on resources; returned expiry/refresh fields govern token lifecycle. |

The [official QUX OAuth guide](https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-oauth2) confirms personal tokens remain supported and recommends OAuth where possible.
QUX refresh tokens are not supported by that documented contract.
AUTH-02 rechecked that guide on 2026-10-03 for Bearer use and client-credentials reacquisition.
The [pinned VAT implementation](https://github.com/vectranetworks/vectra_api_tools/blob/c76fd0c5d42e74b199e47dc42923582c2b1dbee7/modules/vectra.py) corroborates the versioned QUX route, Basic client authentication, form grant and returned expiry in `_get_token` and `_check_token`.
Its retry, redirect and disabled-verification behavior are not adopted.
AUTH-02 also consulted `knowttl/az-axi` on `main` for profile precedence, credential expiry/cache and SDK error conventions; no UI-auth reuse or global credential cache is adopted.
Use returned expiries rather than hardcoded example lifetimes.
API version values are strings, so a future `2.10` cannot collapse into `2.1`.
QUX release changes can retain API v2.5: health events arrived in appliance 9.4, AD groups in 9.6, and detection EDR context in 9.8.
Capabilities therefore record deployment, API version and any appliance-release prerequisite.

## Capability map

Routes below omit the resource prefixes above.
These are research findings and planned coverage, not executable support claims.
Roles, licences and appliance releases can further restrict availability.

| Domain | QUX v2.5 | RUX v3.4 | Delivery |
|---|---|---|---|
| Detections | `/detections`, detail | `/detections`, detail | First investigation slice. |
| Hosts/accounts/entities | `/hosts`, `/accounts`; type-qualified entity facade | `/hosts`, `/accounts`, `/entities` | First read release; RUX entities appear in v3.1, host routes in v3.3. |
| Scores | Current threat/certainty | Entity urgency/importance and `/events/entity_scoring` | Current scores with entity reads; RUX history later. |
| Notes/tags | Object note routes and `/tagging` | Version-specific entity/detection routes | First read release; mutation families later. |
| Assignments/outcomes/users | `/assignments`, `/assignment_outcomes`, `/users` | Same resource families | First read release, preserving resolution semantics. |
| Groups/rules | `/groups`, members, `/rules` | Same families with version-specific schemas | First read release after investigation reads. |
| Lockdown status | `/lockdown/account`, `/lockdown/host` | `/lockdown?type=…` | Status only; execution requires a separately established public contract. |
| Audit | `/audits?start=…&end=…` | `/events/audits?from=…` | Date-window versus checkpoint handling. |
| Health | `/health`, individual checks, release-dependent `/events/health` | Health/check/connector/EDR and event routes | First read release for supported QUX operations; RUX later. |
| Detection events | Matching checkpoint feed not established in inspected QUX guide | `/events/detections` | RUX phase. |
| Long tail | Search, campaigns, network stats, proxies, Match, feeds, settings | Investigations, connectors, notifications, Match, feeds, SAML | Inventoried; separately scoped later work. |

QUX PDF pp7-8 provide the endpoint overview; pp58-59 describe audit windows and p75 health checkpoints.
VAT [vectra.py](https://github.com/vectranetworks/vectra_api_tools/blob/c76fd0c5d42e74b199e47dc42923582c2b1dbee7/modules/vectra.py) and [platform.py](https://github.com/vectranetworks/vectra_api_tools/blob/c76fd0c5d42e74b199e47dc42923582c2b1dbee7/modules/platform.py) show historical version differences, note/assignment support and entity/event mappings.
The RUX specification contains `/detections` at line 4282, `/entities` at 5093, audit at 5244, scoring events at 5406 and lockdown at 7104 in the pinned download.

## Architecture and module depth

The execution path is strict command catalogue -> Vectra session -> selected generation adapter -> HTTPS.
Validated results return through safe projection/redaction -> AXI TOON output.
The mutation coordinator uses a separate authorized sender in `src/session.ts`, sharing the read session's credential and HTTP transport seams.

As domain slices land, the session will expose caller-shaped operations such as `listDetections(query, window)`, `getDetection(id)` and `listEntities(kind, query, window)`.
CORE-01 supplies the operation-scoped foundation described in the [session interface](core-01-handoff.md), and CORE-02 supplies the [collection interface](core-02-handoff.md).
See [README.md](../README.md) for shipped domain reads.
The session and collection reader own profile/version resolution, capability checks, origin enforcement, credential lifecycle, retries, response validation and pagination.
Deleting this module would distribute those responsibilities across commands, so it earns its interface through depth and locality.
Do not add a trivial wrapper class per endpoint or expose arbitrary route/payload execution as the domain interface.

QUX and RUX differences establish a real seam.
The network seam has real HTTP and synthetic-fixture adapters from the first implemented slice.
Do not build a speculative inheritance hierarchy for future API versions.
Group related operations in domain files inside the session, splitting only where a piece stands on its own.

One typed operation catalogue owns leaf grammar, flags, effect, supported deployment/version/release, method/route bindings, query mapping, response decoder, compact fields, permission/licence notes and fixture/source references.
Generate help and coverage from those declarations.
Use ordinary code for nontrivial transformations rather than an expanding configuration language.
Coverage distinguishes named support, reviewed raw support, planned, blocked, unavailable and deprecated operations.

## Profiles and authentication

A profile contains deployment kind, exact HTTPS origin, API version string, known appliance release when available, authentication mode, secret references, optional private CA bundle and a separately hand-edited write policy.
Token mode requires a token environment reference; OAuth mode requires client ID and a secret environment reference.
Reject mixed or incomplete authentication modes.
Do not take secret values in argv or emit them in profile output.
Use a user configuration file or explicitly selected config; do not automatically trust repository-local credential configuration.

Profile precedence is explicit flag, environment, configured default, then the sole configured profile.
An ambiguous or missing profile produces actionable setup guidance.
Do not guess the deployment from hostnames or silently reuse interactive browser login.
Cache credentials in memory for the invocation initially; a persistent credential vault is outside launch scope.
TLS verification is mandatory; private CA support handles on-prem trust without disabling verification.
Validate origins, paths, redirects and continuation destinations before sending credentials.

When migrating to cloud, create a distinct RUX profile and rediscover cloud object IDs.
The grammar remains familiar, while origins, credentials, capabilities and score models remain explicit.
The CLI does not migrate data or assume identity equivalence between instances.

## CLI and output contract

Use az-style group/subgroup/verb paths with Vectra domain nouns.
The az-axi grammar scout is a direction for consistency, not evidence that every canonical path already exists in its runtime.
Examples below are proposed commands:

```text
vectra-axi detection list --profile lab --state active --limit 100
vectra-axi detection show --profile lab --id 42 --full
vectra-axi host list --profile lab --threat-gte 70
vectra-axi account show --profile lab --id 19
vectra-axi entity list --profile lab --type host
vectra-axi detection note list --profile lab --id 42
vectra-axi group member list --profile lab --id 8
vectra-axi triage rule show --profile lab --id 7
vectra-axi audit list --profile lab --start-date 2026-10-01 --end-date 2026-10-02
vectra-axi lockdown list --profile lab --type account
```

Use list/show/create/update/delete where semantically appropriate, named selectors and kebab-case flags.
QUX `entity list` requires a type rather than manufacturing a global order from independently paginated hosts and accounts.
IDs are always interpreted with resource kind and profile; host 42 and account 42 are different objects.
Do not equate threat/certainty with urgency or replace unsupported, denied, missing and null values with zero.
Unsupported filters fail explicitly instead of silently becoming client-side scans.
Audit date flags define inclusive UTC calendar days; RUX maps them to its timestamp filters.

Keep JSON internally and encode [TOON](https://toonformat.dev/reference/spec) at stdout.
Lists use 3-4 useful fields where practical, total counts when known, returned count, completeness and continuation.
Detail text is previewed with full-length metadata and `--full` guidance only when truncated.
Explicit empty results distinguish success from failure.
Suggestions preserve the selected profile and use placeholders for runtime IDs.
Reject unknown flags and invalid combinations before credentials or HTTP.
No interactive prompts are required.
Exit 0 means success/no-op, 1 runtime failure, and 2 usage failure; structured errors use stdout, diagnostics use stderr.
This follows AXI's exit semantics even though current az-axi maps some runtime auth/access failures to exit 2.
Bare version flags bypass heavy imports and network.
No-args shows compact local context or clear setup state without HTTP; see [README.md](../README.md#release) for the explicit doctor check.
Generate a static installable skill from discovery metadata; session integration requires explicit setup and introduces no ordinary-command installation side effects.

## Collections, events and bounded reads

Default normal list output to 100 records, with an opaque continuation cursor.
The session handles collection count/results/next separately from event checkpoints and date-window audit responses.
Bind cursors to profile identity, origin, version, operation, filters, ordering and any within-page offset.
Preserve unreturned rows when output limits split a backend page.
Follow returned event checkpoints; never calculate a new checkpoint from page size.
Detect repeated cursors and enforce response-byte/request/deadline budgets.
Unknown totals remain unknown; remaining_count is not a stable total.
Partial failures retain validated results with `complete:false`, an actionable error and nonzero exit status.
Mutable collections do not promise snapshot isolation.

QUX detection/account page sizes can reach 5000, but that maximum is not the CLI default.
RUX detection-event batches default to 500 and cap at 1000 in the pinned contract.
QUX unbounded audits can reach 200 MB; require a date range and byte ceiling instead of pretending they use RUX checkpoints.
Initially page sequentially and avoid count-derived parallel fanout.

No universal numeric REST request rate limit was verified.
Do not confuse Match alert-generation limits with API request throttling.
The RUX investigation-creation limit of five requests/minute/user is endpoint-specific.
For reads, honor valid Retry-After within a bounded cancellable deadline and retry only reviewed transient conditions.
Explain when a delay exceeds the budget.
Do not automatically replay ambiguous mutations.

## Later mutation coordinator

See [README.md](../README.md) for the shipped operation surface.
Reviewed raw reads use the same operation catalogue and session and cannot bypass sensitive-route or write policy.

WRITE-00 implements the coordinator in `src/writes.ts`; WRITE-01 binds desired-state tag replaces in `src/tags.ts`, WRITE-02 binds action-shaped note appends in `src/note-add.ts`, WRITE-03 binds desired-state assignment changes in `src/assignment-set.ts` and WRITE-05 binds bulk tag set/delete fan-out in `src/tags-bulk.ts` to it.
See [README.md](../README.md) for shipped write behavior and [the implementation plan](implementation-plan.md#phase-4-add-writes-as-a-new-capability-one-family-at-a-time) for selected and future write slices.
The coordinator keeps its original policy private and exposes a frozen scope snapshot, including the operation allowlist.
Its sender independently consumes a single-use authorization bound to that sender, method and URL; authorization issuance is private to the coordinator.

The coordinator enforces this order:

1. Validate the named operation and exact target.
2. Apply forced read-only, hand-enabled profile, immutable configured origin and allowed-operation scope.
3. Read state and produce a local desired-state/action preview containing redacted serialized current state and proposed payload.
4. Require `--execute`; `--dry-run` is mutually exclusive with execution.
5. Require exact target confirmation for disruptive operations or definitions with `requiresConfirmation: true`, and apply the approval hook when supplied; future named mutation skills must require human approval of the reviewed action.
6. Record durable redacted intent, re-read, execute once and record the outcome.

Verified already-desired state is an exit-0 no-op.
Use conditional writes only where the exact endpoint supports them; a re-read alone is not atomic protection.
After an ambiguous timeout, report `OUTCOME_UNKNOWN` with audit ID and read-back guidance rather than replaying or claiming nothing changed.
Failure to record intent blocks the send; failure to record outcome after send must report possible remote success.
The audit contains metadata, not raw secrets, headers or note bodies, and is not represented as tamper-proof.
The journal defaults to `~/.vectra-axi/writes.log`, with a nonblank `VECTRA_AXI_WRITE_LOG` override or an explicit internal `auditPath`.
Intent reservation reads the durable journal under an exclusive lock and refuses any previously reserved intent ID, including across coordinator recreation, with `ALREADY_EXECUTED` and manual reconciliation guidance.
Intent records are flushed with `fsync` before sending a mutation, and outcome records before reporting completion on every platform.
On platforms other than Windows, first creation also flushes the journal directory and any newly created parent directories.
On Windows, first use creates the journal directory and flushes the empty journal file before reserving any mutation intent.
Node cannot open directory handles for `fsync` on Windows, so directory entries cannot be durably flushed there; a machine failure can still lose newly created journal paths despite file flushing.
A malformed journal or remaining lock blocks intent recording; reconcile a remaining lock manually before removing it.
Named text mutations use file/stdin inputs, as the WRITE-02 note append does.
There is no assumed server-side dry-run capability.

See the [implementation plan](implementation-plan.md#phase-4-add-writes-as-a-new-capability-one-family-at-a-time) for remaining mutation families and their selection requirements.
Close/open, groups and triage rules require explicit semantic and concurrency analysis.
Lockdown execution is unpromised until an exact public mutation contract is established.
[az-axi gates](https://github.com/knowttl/az-axi/blob/7d31138eb82e0fc6adec867e7690be6cf87725b6/src/lib/gates.ts#L68), [client enforcement](https://github.com/knowttl/az-axi/blob/7d31138eb82e0fc6adec867e7690be6cf87725b6/src/lib/client.ts#L106) and [audit serialization](https://github.com/knowttl/az-axi/blob/7d31138eb82e0fc6adec867e7690be6cf87725b6/src/lib/writeLog.ts#L67) are conventions to adapt, not a ready-made Vectra policy implementation.

## Change recipe and tests

For a new endpoint, pin evidence and classify its effect, add its domain declaration/mapping, use existing session policy, add synthetic contract fixtures, then regenerate help/coverage.
For a new version, diff route/query/field/auth/paging/error contracts, reuse unchanged mappings, add only evidenced differences, and run the same session contracts against every supported version.
Do not enable a version before its contract tests pass or silently change existing profiles.

Use Vitest conventions consistent with az-axi once the shell is built.
Deny external network in automated tests and use synthetic .invalid origins and credentials.
Inject only genuine seams such as HTTP, clock and randomness.
Test session outcomes rather than private helpers; reserve packaged CLI E2E tests for critical journeys lower levels miss.
Important cases include same numeric host/account IDs, cross-origin redirects/next links, credential sentinels in errors, expiry, malformed responses, denied versus empty data, oversized audits, repeated checkpoints, mid-page caps, partial failures and mutation acceptance followed by timeout.
Use fake time, no sleeps, and repeated runs for async/clock/I/O cases.
VAT's instance-backed tests are research evidence, not the test setup to reuse.

The published RUX schema mixes Swagger 2.0 and newer constructs, so full code generation requires validation before adoption.
Fixture validation cannot prove compatibility with an unknown appliance release.
Confirm deployment facts before promising support for a live configuration, without making a live call part of this design or automated acceptance.
