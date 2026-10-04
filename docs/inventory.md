# Capability inventory contract (INV-01)

The machine-readable catalogue is [inventory/capabilities.json](../inventory/capabilities.json).
Its executable schema and inferred TypeScript types are [src/inventory/schema.ts](../src/inventory/schema.ts).
CLI-01 builds on this format; INV-01 implements no commands, adapters or endpoint dispatch.
Validate the complete file using `inventorySchema.parse(value)` before consuming it.
The schema rejects unknown keys, incomplete records, duplicate IDs, unresolved source references and unsafe effect/disposition combinations.

## Record format

`schemaVersion: 1` identifies this contract; incompatible changes require a version change and updated consumers.
`reviewedOn` records the evidence review date, not a promise of current appliance compatibility.
`sources` pins a URL, revision, review date and SHA-256 where a downloadable snapshot exists.
The QUX guide entry refers to the attached October-2025 PDF; its hash is for the PDF bytes, not the changing guide landing page.
No upstream document is vendored: only route metadata, small field/query inventories and independently written constraints are committed.

Each `operations` record describes one deployment-specific operation or one type-qualified facade binding.
Stable `id` values join grammar, transport policy, fixtures and generated capability documentation as their owning slices land.
They must not be reused for a different operation.

| Field | Meaning |
|---|---|
| `command` | Group/subgroup/verb leaf without executable name or flags; disposition records delivery state; `null` for internal auth exchanges and excluded secret exports. |
| `slice` | Owning implementation slice; `excluded` means no implementation is authorized. |
| `deployment`, `apiVersion` | Exact QUX/2.5 or RUX/3.4 binding; versions are strings, never decimals or floating latest. |
| `minimumRelease` | Established appliance prerequisite, or `null` when no base-route minimum was established; never means every release is supported. |
| `constraints` | Authentication, release-dependent fields, selectors and generation-specific semantics that cannot be inferred from a route. |
| `method`, `path`, `effect` | Exact method and resource path template, plus read, auth-exchange, credential-export, write or disruptive classification. |
| `query` | Conservative subset of evidenced upstream query names for the initial journey; not a CLI flag list or an exhaustive upstream parameter inventory. |
| `fields` | Conservative subset of evidenced response fields useful to callers; not an upstream projection allowlist or a decoder. |
| `paging` | `none` for a single response, `collection` for count/results/next, `checkpoint` for returned event checkpoints, or `date-window` for QUX audits. |
| `permissions`, `licence` | Established prerequisites or explicit gaps in evidence; unknown entitlement is never assumed unrestricted access. |
| `evidence` | Source ID plus page, method/path or symbol locator supporting the record. |
| `disposition`, `rationale` | Delivery state and reason; never a runtime authorization grant. |
| `fixtureCases` | Required synthetic acceptance scenarios for the owning slice, not claims that endpoint fixtures already exist. |

`query: []` and `fields: []` mean no initial subset has been pinned, not that the endpoint accepts no parameters or returns no fields.
Later slices must recheck supported query values, projection fields, response shapes, budgets and release gates before enabling a leaf.
Nontrivial transformations and future decoders belong in ordinary code, not inventory expressions.
The inventory records evidence; the [strict executable catalogue](../src/catalogue.ts) is the sole owner of shipped grammar/help/support claims.

## Dispositions and exclusions

| Disposition | Meaning |
|---|---|
| `planned` | Accepted future scope, with no runtime support yet. |
| `unreviewed` | Family discovered, but exact operations and security semantics still need review. |
| `blocked` | Deliberately refused, including credential exports even when they use GET. |
| `named` | Implemented and tested named operation. |
| `reviewed-raw` | Future explicitly approved raw-read operation through the same policy. |
| `unavailable` | Evidence establishes that a requested capability is absent for this binding. |
| `deprecated` | Previously supported contract deliberately retired with documented guidance. |

The [capability records](../inventory/capabilities.json) own each operation's delivery state; see [README.md](../README.md) for shipped commands.
Neither an upstream GET nor a downloaded schema enables an endpoint.
The QUX sensor registration token and AWS connector credential reads are `blocked` and cannot be exposed through later raw-read access.
OAuth exchanges are separate effects; a token POST does not authorize business POSTs.
Unknown routes remain outside the catalogue; see [README.md](../README.md) for the session's shipped authorization policy.

`deferredFamilies` intentionally records only deployment/version, evidence, disposition and reason.
It does not invent routes, command leaves, permission mappings or effects for a long tail that has not been reviewed.
The AD directory endpoint is deferred separately from initial group/member reads.
Future note/tag/assignment and other mutations are family-level `planned` entries until exact operations are separately selected and the mutation coordinator exists.
No QUX detection checkpoint feed, lockdown execution, v3.5 preview, unrestricted passthrough or cross-instance identity translation is promised.
The number of records measures this inventory only; no API-wide denominator or completeness percentage is asserted.

## Evidence and verification

The RUX v3.4 specification hash still matches the design snapshot on 2026-10-03.
RUX parameter names were checked directly against the published schema rather than copied from QUX.
The QUX PDF and pinned VAT implementation provide differently shaped checks of authentication, notes/tags, entity routes and health checks.
Where the guide does not enumerate the account tagging selector, the record explicitly cites VAT and requires revalidation in READ-03.
RUX tag tables are singular (`host`, `account`, `detection`, `entity`), while note resource selectors are plural.
RUX user records use `name`, and entity response records expose `urgency_score` alongside `importance`.
The PDF revision history establishes OAuth in appliance 9.1, group members in 9.2, embedded-note truncation in 9.3, health events in 9.4 and AD groups in 9.6.
The separately updated guide change log adds detection EDR context in 9.8.
Individual QUX health checks require the view-health permission; denials must never appear as healthy empty results.

The inventory's `az-tooling` source pins the tooling reference separately from the older design research reference.
See [README.md](../README.md) for development requirements and commands, [the CI workflow](../.github/workflows/ci.yml) for the validation matrix and [.no-mistakes.yaml](../.no-mistakes.yaml) for gate commands.
The [shared network guard](../test/network-guard.ts) owns automated network denial for Vitest and packaged CLI subprocesses.
