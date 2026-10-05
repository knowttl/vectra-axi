# vectra-axi
Agent-ergonomic CLI for Vectra AI, read-only by default

See the write usage below for shipped QUX mutations through the separate mutation coordinator; unlisted Vectra resource operations remain planned or blocked.
The INV-01 capability inventory, CLI-01 local command shell, AUTH-01 profiles/token/TLS primitives, AUTH-02 OAuth credential lifecycle, CORE-01 QUX session with fixture HTTP adapter, CORE-02 bounded collection reader with retries, cancellation and partial results, READ-01 detection list/show leaves, READ-02 host/account/type-qualified entity leaves, READ-03 detection/host/account note and tag leaves, READ-04 assignment/outcome/user leaves, READ-05 group/member/triage-rule leaves, READ-06 bounded audit-window leaf, READ-07 health-snapshot and health-event leaves, READ-08 host/account lockdown status leaf, PACK-01 read-release packaging, doctor and generated documentation, WRITE-00 mutation coordinator, WRITE-01 gated detection/host/account tag replaces, WRITE-05 gated detection/host/account bulk tag set/delete, WRITE-02 gated detection/host/account note appends, WRITE-03 gated host/account assignment sets, the RUX-01 cloud OAuth/session adapter (unversioned token exchange, v3.4 profile contract and exchange-only doctor check), the RUX-02 cloud detection, host, account and type-qualified entity reads (urgency/importance apart from QUX scores), the RUX-04 cloud detection/host/account note and tag reads (version-specific entity/table selectors and note shapes), the RUX-05 cloud group, member and triage-rule reads (native per-kind member identity), the RUX-03 cloud detection-event reads (exact checkpoint advancement with mid-batch cursors), the RUX-03 cloud entity-scoring-event reads (exact checkpoint advancement with mid-batch cursors over the required type selector), the RUX-03 cloud audit-event reads (exact checkpoint advancement with mid-batch cursors and whole-day date expansion), the RUX-04b cloud assignment, outcome and user reads (native name identity) and the RUX-06 cloud health and lockdown status reads (subscription-sensitive shapes over the v3.4 routes, including connector/EDR and network-brain ping health checks; later RUX slices still pending) are implemented.
`detection list`, `detection show`, `host list`, `host show`, `account list`, `account show`, `entity list`, `entity show`, `detection note list`, `detection tag list`, `host note list`, `host tag list`, `account note list`, `account tag list`, `group list`, `group show`, `group member list`, `triage rule list`, `triage rule show`, `assignment list`, `assignment outcome list`, `assignment outcome show`, `user list`, `user show`, `health list`, `health show`, `health event list` and `lockdown list` call the session on either generation; `detection event list` reads RUX v3.4 detection events and `entity scoring list` reads RUX v3.4 entity scoring events on a cloud profile, each reporting `OPERATION_UNKNOWN` on an on-prem profile; `audit list` calls the session on either generation, reading QUX date-windowed audits on an on-prem profile and RUX audit events on a cloud profile.
The CLI uses TypeScript, with on-prem QUX reads and cloud RUX detection, host, account, entity, note, tag, group, member, triage-rule, assignment, outcome, user, health, lockdown, detection-event, entity-scoring and audit-event reads, plus the reviewed `api get` raw-read leaf over allowlisted GET operations on either generation.

- [Design and source evidence](docs/design.md)
- [Implementation slices and offline acceptance](docs/implementation-plan.md)
- [Inventory format, dispositions and verification](docs/inventory.md)

Development requires Node 22.12 or later and pnpm 10.34.6 through Corepack.
Run `corepack pnpm install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false`, then `corepack pnpm run build`, `corepack pnpm test` and `corepack pnpm run lint`.
Tests deny external network and require no Vectra credentials.

Run `node bin/vectra-axi.js` after building for the local home view.
`home` and `setup` are local, read-only status views; `setup` installs nothing.
See [Release](#release) for the explicit `doctor` check.
Run `node bin/vectra-axi.js --help` or `node bin/vectra-axi.js setup --help` for catalogue-generated help and examples.
Bare `-v`, `-V` and `--version` print only the package version without loading the command graph.
Every local leaf accepts `--help` or `--profile <name>` (also `--profile=<name>`); these flags are mutually exclusive.
Profile selection follows `--profile`, `VECTRA_AXI_PROFILE`, configured `defaultProfile`, then the sole configured profile.
Without profiles or a selection, local views show unconfigured state successfully.
Selecting a profile when none are configured reports `PROFILE_REQUIRED`; unknown selections among configured profiles report `PROFILE_NOT_FOUND`, and multiple profiles without a selection report `PROFILE_AMBIGUOUS` except for `doctor` (see [Release](#release)).
Unknown commands, flags, positional arguments, repeated flags and version combinations fail before profile or network work.
The SDK's implicit `update` command is refused.

Structured data, help and errors use TOON on stdout; stderr is reserved for diagnostics.
Exit codes are 0 for success, 1 for runtime failure (including a missing profile), and 2 for usage failure.
There are no prompts or ordinary-command installation side effects.
Home, setup, help and version remain offline; doctor, detection, entity, note, tag, assignment, outcome, user, group, member, triage rule, audit, health, lockdown, detection event, entity scoring and reviewed raw (`api get`) reads make authenticated HTTP requests.
`corepack pnpm pack --out vectra-axi.tgz` packages the built entrypoint, runtime modules, inventory and installable skill.
See [CLI-01 acceptance](docs/implementation-plan.md#phase-0-turn-design-knowledge-into-one-executable-catalogue) for packaged verification.

Profiles live in `~/.vectra-axi/config.json`, or a file explicitly selected with `--config <path>` or `VECTRA_AXI_CONFIG`.
`--config` takes precedence over `VECTRA_AXI_CONFIG`; every leaf also accepts `--config=<path>`.
An absent default config means unconfigured state; unreadable or malformed files, including an absent explicitly selected file, report `CONFIG_INVALID`.
Help and bare version flags do not read configuration.
Repository-local configuration is never discovered automatically.
`setup` shows a synthetic example and the selected config path; hand-edit the file to configure a profile.
There is no credential prompt, config writer or browser login reuse.

```json
{
  "defaultProfile": "lab",
  "profiles": {
    "lab": {
      "kind": "qux",
      "origin": "https://fixture.invalid",
      "apiVersion": "2.5",
      "applianceRelease": "9.4",
      "auth": "token",
      "tokenEnv": "VECTRA_LAB_TOKEN",
      "caBundle": "private-ca.pem"
    }
  }
}
```

`applianceRelease` is optional for QUX profiles; `caBundle` is optional for both generations.
An optional hand-edited `writes` object requires a boolean `allowWrites` and a nonempty `operations` array of nonempty operation names; unknown fields are rejected.
Absent `writes` or `allowWrites: false` disables coordinator mutations; `VECTRA_AXI_READ_ONLY=1` overrides any opt-in.
This policy permits execution only of implemented operations in the configured scope; listing an operation does not implement it.
See the write usage below for the operation names to hand-enable for tag replacement, bulk tag changes, note append and assignment changes.
See the [mutation architecture](docs/design.md#later-mutation-coordinator) for the internal coordinator contract.
Verification: WRITE-00 was verified locally (build, lint and the full offline test suite) under the GitHub billing-outage posture with hosted Actions disabled; per-head results are recorded on the pull request.
Profile names and `defaultProfile` must be nonempty identifiers without surrounding whitespace; selections match exactly without trimming.
`defaultProfile`, when present, must name an existing profile.
The origin must be an exact HTTPS origin without credentials, path, query, fragment or trailing slash.
QUX v2.5 supports personal-token and OAuth client-credentials profiles; RUX v3.4 supports OAuth client-credentials profiles only, with no token mode or appliance release.
Unknown fields, cross-generation version or auth combinations, mixed authentication fields, inline secrets, UI-login settings and TLS bypass settings fail at configuration load, including in unselected profiles.
Set the environment variable named by `tokenEnv` outside the CLI; never pass a secret in argv or the config file.
Token resolution provides `Authorization: Token …` to the session and does not infer a personal token's expiry.
Unset, empty or whitespace-only token values report `AUTH_REQUIRED`; other whitespace-containing tokens report `AUTH_FAILED`.
Credential material remains in invocation memory; there is no persistent credential cache.
Private CA paths resolve relative to the config file and extend system trust while retaining certificate and hostname verification.
Local status views describe configuration without reading tokens or CA material for authentication.
The session in `src/session.ts` owns URL construction, operation authorization, credential attachment and response validation in one path; command handlers receive no raw authenticated fetch object.
They show profile name/source, kind, origin, API version, optional appliance release, authentication mode, configured trust mode and configured write operations (or `disabled` when opt-in is absent or forced read-only is active), without claiming connectivity, credential validity or appliance compatibility.
Known referenced secret values are scrubbed from output and from error metadata before SDK formatting.
Session failures distinguish `AUTH_REQUIRED`, `AUTH_EXPIRED` (explicit expiry evidence), `AUTH_FAILED` (HTTP 401), `ACCESS_DENIED` (HTTP 403) and `TLS_TRUST_ERROR` (CA loading or known certificate verification errors); all are runtime failures with exit 1.
Only known read operations matching the profile's generation from the capability inventory are authorized; unknown, blocked, credential-export and other-generation operations report `OPERATION_UNKNOWN` or `OPERATION_BLOCKED` before any credential is resolved or HTTP call is made.
The session itself does not retry: unmapped failure statuses report `REQUEST_FAILED`, malformed success bodies report `RESPONSE_INVALID`, unreachable origins report `TRANSPORT_FAILED`, and any destination outside the profile's HTTPS origin and version prefix - including cross-origin redirects and continuation links - reports `DESTINATION_DENIED` with no credential sent.
Same-origin redirects and continuation links must retain the operation's bound pathname, allowing only a single trailing slash difference, and declared query keys.
Redirects are followed up to 3 hops; continuation links are validated and fetched by the bounded collection reader in `src/collections.ts`, which keeps every page inside the session's same-operation authorization.
The production adapter verifies TLS, applies a 30-second deadline per HTTP request and limits each response body to 8 MiB, reporting `BYTE_BUDGET_EXCEEDED` when that limit is exceeded.
Write policy configuration and enforcement live in the mutation coordinator in `src/writes.ts`; see the write usage below for supported business mutations.
See [AUTH-01 handoff](docs/auth-01-handoff.md) for integration constraints and offline acceptance links.

The internal collection reader defaults to a 100-row window; a successful bounded window returns `complete: true` and may still carry a cursor for more rows.
Collection pages require a `results` array; `count` may be absent, null or a non-negative integer, and `next` may be absent, null or a nonempty URL string.
The first usable `count` is retained across pages and resumes; otherwise `total` is `null`, and `remaining_count` never supplies a stable total.
Malformed pages report `RESPONSE_INVALID`; empty pages with a continuation are skipped.
A limit inside a page preserves its unreturned offset in an opaque cursor; resumption refetches that page, so mutable collections do not provide snapshot isolation.
Cursor format v2 binds profile identity, origin, API version, operation, query/path context, pending page, offset, remaining window and last known total, and preserves visited-page history across resumes.
Repeated continuations, including multi-page cycles across resumes, report `CONTINUATION_REPEATED` before following the repeated link.
Resumption requires the original query and path context and rejects incompatible cursors with `VALIDATION_ERROR`.

Each collection invocation defaults to 10 session requests including retries, 8 MiB of cumulative reserialized decoded page bodies, a 60-second deadline and 3 attempts per page.
The default requested `page_size` is 100 where the operation declares that query key; a caller-supplied value is retained, and other routes consume server-sized pages.
These are shared defaults with per-call policy overrides, not evidenced endpoint-specific ceilings.
Only HTTP 429, 502, 503 and 504 are retried, honoring valid Retry-After integer delay-seconds or HTTP-date values; past dates mean zero delay.
Absent or unusable headers use doubling backoff from 500ms capped at 10 seconds.
A delay beyond the remaining deadline reports `DEADLINE_EXCEEDED` with both delays; request and byte ceilings report `REQUEST_BUDGET_EXCEEDED` and `BYTE_BUDGET_EXCEEDED`.
Cancellation reports `REQUEST_CANCELLED`; cancellation and deadline expiry abort pending production requests, including OAuth exchanges, prevent later redirect/resource sends and release retry/deadline timers.
Runtime failures retain validated rows with `complete: false`, an error and a cursor at the pending page, including failures before any rows are returned.
Caller usage errors throw before HTTP; checkpoint and date-window operations are rejected rather than decoded as collections.
See the [CORE-02 handoff](docs/core-02-handoff.md) for the integration interface and the [implementation plan](docs/implementation-plan.md#session-and-investigation-slices) for acceptance and later slices.

`detection list --profile <name>` reads QUX v2.5 or RUX v3.4 detections through the session and the bounded collection reader.
Filter flags map one-to-one to the recorded server-side query keys: `--state`, `--detection-type`, `--detection-category`, `--host-id`, `--tags`, `--certainty-gte`, `--threat-gte`, `--ordering`, `--min-id` and `--max-id`.
Filtering is server-side; numeric filter shapes are validated locally, while unsupported server-side values surface as read errors rather than silent client-side scans.
Values beginning with a dash use inline syntax, such as `--ordering=-id`.
List rows project the recorded field subset `id`, `detection_type`, `state`, `threat` and `certainty`; `--fields` selects a comma-separated subset and rejects unknown fields before any HTTP call.
`--limit` sets the row window (default 100); a capped window returns a cursor, and resuming with `--cursor` repeats the original filters because the cursor binds its query context.
Successful output carries the profile, a known-or-null total, a shown count, the rows, completeness and follow-up help, including a `detection show` suggestion for the first row.
An empty window succeeds with an explicit `0 detections found ...` message; a partial window keeps its validated rows with `complete: false`, an inline error and a cursor, and exits 1.
`detection show --profile <name> --id <id>` reads one detection's recorded detail fields.
Detection IDs must be positive integers; nullable fields retain null, omitted fields stay omitted, and malformed fields report `RESPONSE_INVALID`.
Long descriptions are previewed with their total length and a `--full` hint; `--full` prints the complete returned text but cannot restore content the response omits.
Both leaves validate flag values before loading configuration or selecting a profile, and reject unknown commands and combinations before credential or HTTP work.
Missing profiles fail before HTTP; API access denials report `ACCESS_DENIED` with exit 1, never an empty success.

`host list`, `host show`, `account list` and `account show` read QUX v2.5 or RUX v3.4 hosts and accounts through the same session and bounded collection reader.
List filter flags map to the recorded server-side query keys: `--threat-gte`, `--certainty-gte`, `--tags`, `--min-id` and `--max-id`.
Filtering is server-side; score filters keep their display names at the CLI while the wire uses `t_score_gte`/`c_score_gte` on both generations.
List rows project the recorded field subset `id`, `name`, `state`, `threat` and `certainty`; threat and certainty retain their labels and keep null instead of zero on both generations.
`entity list --type <host|account>` and `entity show --type <host|account> --id <id>` require `--type` on both generations, never a merged ranking.
On QUX the facade selects the matching host/account route, accepts score and tag filters, and projects `id`, `name`, `threat` and `certainty`.
On RUX it selects the `/api/v3.4/entities` route with the type selector, accepts the tag filter, and projects `id`, `name`, `type`, `urgency_score` and `importance` in lists.
RUX entity show returns `id`, `name`, `urgency_score` and `importance` with profile and the requested type.
Urgency and importance remain distinct from threat/certainty; the RUX entity facade refuses `--threat-gte` and `--certainty-gte` with `VALIDATION_ERROR` before credential or HTTP work.
Use `host list` or `account list` on the cloud profile for threat/certainty filters.
Both generations' entity facade refuses min/max ID flags and `state` projections before HTTP; only QUX facade continuation links may carry `min_id` and `max_id`.
All three list leaves accept `--fields`, `--limit` (default 100) and `--cursor`; resuming requires the same filters and entity type.
Empty lists explicitly report zero hosts or accounts; partial reads retain validated rows, an error and a cursor, and exit 1.
All three show leaves require a positive integer `--id`; null fields stay null, omitted fields stay omitted, and malformed fields report `RESPONSE_INVALID`.
Host/account show and QUX entity show return their corresponding list field subset with profile and type.
These leaves validate flag shapes before configuration or profile selection, then check generation-specific entity fields and filters before credential or HTTP work.
Host 7 and account 7 are different objects, and every show output retains its resource kind for the next command.
See the write usage below for supported business mutations.

`<kind> note list --profile <name> --id <id>` reads full notes through the dedicated versioned notes resource for detections, hosts and accounts on either generation: QUX v2.5 on an on-prem profile or RUX v3.4 on a cloud profile.
Note/tag leaves require a positive integer owner `--id`, validated before configuration or profile selection.
Note responses are bare lists of entries with a positive integer note `id` and optional nullable `note` text; tag responses carry a `tags` array of strings.
The v3.4 note entries may carry author/timestamp metadata and the v3.4 tagging bodies status/tag metadata; both generations project the recorded `id`/`note` and `tags` shapes, so cloud output matches the on-prem shape with the cloud profile retained.
Malformed responses report `RESPONSE_INVALID`; note text retains null and omitted values.
Long note text is previewed at 1200 characters with its total length and a `--full` hint; `--full` prints the complete returned text but cannot restore content the upstream response never returned.
`<kind> tag list --profile <name> --id <id>` reads the complete tag set through the versioned tagging route in one body on either generation.
The [capability records](inventory/capabilities.json) own the exact generation-specific note routes and tagging selectors.
Empty reads explicitly report zero notes or tags for their owner; denied reads report `ACCESS_DENIED`, never an empty success.
Detection, host, account and QUX type-qualified entity show leaves surface embedded note summaries under `note_summary` with a pointer to the matching note list leaf, never as full notes; RUX entity show projects only the entity fields documented above.
Only `detection show` accepts `--full`, which expands returned descriptions, not embedded note summaries.
`<kind> note add --profile <name> --id <id> --note <text>` appends one note through the WRITE-00 gate pipeline: the profile must hand-enable `qux.<kind>.note.add` in its `writes` scope, the dry run previews the exact note to be appended, and `--execute --confirm '<kind> <id>'` sends a POST.
Omitting `--execute` previews only; explicit `--dry-run` cannot be combined with `--execute`.
Each successful execution appends one note; repeated identical notes each send, and there is no no-op or conflict comparison.
The notes resource is read for the preview and again before sending; a failed read blocks the append, while concurrent additions do not block it.
Choose exactly one of `--note` (inline text) or `--note-file` (a file path, `-` for stdin); file content is appended exactly as read and empty or whitespace-only notes are rejected.
No upstream note length limit is evidenced, so none is enforced; note edits and deletes have no leaf.
Intent and outcome are journaled as metadata only, never the note text; server rejections return an error with the audit id and exit 1, and ambiguous timeouts report the audit id with read-back guidance instead of replaying.
`<kind> tag set --profile <name> --id <id> --tags a,b` replaces the owner's tag set with exactly the desired tags through the WRITE-00 gate pipeline: the profile must hand-enable `qux.<kind>.tag.set` in its `writes` scope, the dry run previews added and removed tags, and `--execute --confirm '<kind> <id>'` sends a PATCH only when the diff is non-empty (an already-matching set is an exit-0 no-op).
Omitting `--execute` previews only; explicit `--dry-run` cannot be combined with `--execute`.
The pre-send re-read refuses changed tags with `VERSION_CONFLICT`, unless they already equal the desired set, which is a no-op.
This is a non-atomic comparison of tag contents, not an ETag or server-side version check; a change after the re-read can still be overwritten.
Desired tags come from `--tags` (comma-separated, at least one) or `--tags-file` (one tag per line, `-` for stdin); an empty file or empty stdin clears all tags.
Choose exactly one input; tags are trimmed, blank entries dropped and duplicates collapsed in first-seen order.
Intent and outcome are journaled durably; server rejections return an error with the audit id and exit 1, and ambiguous timeouts report the audit id with read-back guidance instead of replaying.
`<kind> tag bulk-set --profile <name> --ids 7,8 --tags a,b` unions the named tags onto each explicit target's set, and `<kind> tag bulk-delete --profile <name> --ids 7,8 --tags a,b` subtracts them, through the WRITE-00 gate pipeline: the profile must hand-enable `qux.<kind>.tag.bulk-set` or `qux.<kind>.tag.bulk-delete` in its `writes` scope (the single-target `tag set` scope does not cover bulk), the dry run previews the per-target added and removed diffs, and `--execute --confirm '<n> targets: <kind> <id>, ...'` sends one PATCH per target only for targets whose set would change (already-steady targets are exit-0 no-ops that send nothing).
Targets come from `--ids` (comma-separated) or `--ids-file` (one ID per line, `-` for stdin), at most 100 per run in ascending order with duplicates collapsed; query-selected targets are never accepted.
Choose exactly one target input and exactly one tag input: `--tags` (comma-separated) or `--tags-file` (one tag per line, `-` for stdin); tags are trimmed, blank entries dropped and duplicates collapsed in first-seen order.
For one target, confirmation is `1 target: <kind> <id>`; for example, two hosts require `--confirm '2 targets: host 7, host 8'`.
No vendor bulk tagging route is evidenced, so bulk runs sequence per-target full-replace PATCHes through the QUX tagging route and refuse RUX profiles outright.
Both actions reject empty tag input; deleting all existing named tags leaves a target empty.
A denied or malformed preview read aborts the run before anything is sent.
Every confirmed target is read again at its execution turn, including targets unchanged in the preview; targets still requiring a PATCH are also re-read immediately before sending.
Either re-read refuses a moved target with `VERSION_CONFLICT` unless it already equals the previewed desired set, which is a no-op.
This is a non-atomic comparison of tag contents, not an ETag or server-side version check; a change after the re-read can still be overwritten.
One moved, rejected or timed-out target is reported for that target and the confirmed rest continue; the report lists every target's `applied`, `noop` (unchanged), `failed`, `unknown` or `refused` outcome and exits 1 unless all reported targets applied or were already steady.
Applied, failed and unknown results include an audit id; no-op and refused results do not.
Omitting `--execute` previews only; explicit `--dry-run` cannot be combined with `--execute`.
Per-target intent and outcome are journaled durably as metadata only; server rejections return an error with the audit id and exit 1, and ambiguous timeouts report the audit id with read-back guidance instead of replaying.

`assignment set --host <id> --user <id>` assigns a QUX host or account to an exact user through the WRITE-00 gate pipeline: the profile must hand-enable the matching `qux.<host|account>.assignment.<create|reassign|unassign>` operations in its `writes` scope, the dry run previews assign, reassign (from user X to user Y) or unassign, and `--execute --confirm '<host|account> <id>'` sends only when the desired state differs (an already-matching assignment is an exit-0 no-op).
Exactly one of `--host <id>` or `--account <id>` selects the entity and exactly one of `--user <id>` or `--unassign` selects the desired state; detections have no assignment route (they inherit their entity assignment) and resolving stays a separate operation with no leaf.
The current open assignment is read through the entity-filtered unresolved assignment list, and the target user is validated through `user show` before preview and before send; unknown users are refused and nothing is sent.
Every returned assignment row must include `assigned_to` (explicit null or a user object), the selected kind's identity field and a valid host or account identity; malformed rows report `RESPONSE_INVALID` before any mutation.
An empty open-assignment list or an explicitly null assignee establishes an unassigned state; an omitted assignee never does.
Reassignment changes the analyst, never the entity; resolved history never selects a target and duplicate open assignments are refused rather than guessed.
The [capability records](inventory/capabilities.json) own the exact assignment mutation routes, payload fields and upstream evidence.
The pre-send re-read refuses a moved assignment with `VERSION_CONFLICT`, unless it already equals the desired state, which is a no-op.
This is a non-atomic comparison of assignment contents, not an ETag or server-side version check; a change after the re-read can still overwrite.
Omitting `--execute` previews only; explicit `--dry-run` cannot be combined with `--execute`.
Intent and outcome are journaled durably; server rejections return an error with the audit id and exit 1, and ambiguous timeouts report the audit id with read-back guidance instead of replaying.

`assignment list`, `assignment outcome list`, `assignment outcome show`, `user list` and `user show` read QUX v2.5 or RUX v3.4 assignments, outcomes and users through the same session and bounded collection reader.
Assignments and outcomes are distinct resources: an assignment row carries its target `host_id` or `account_id` plus a CLI-derived `status` of `unresolved` when `date_resolved` is null and `resolved` when it is set, never a missing or zero outcome.
Assignment list filters map `--account`, `--host` and `--assignee` to `accounts`, `hosts` and `assignees`; `--resolution`, `--resolved true|false` and `--created-after` map to `resolution`, `resolved` and `created_after` on both generations.
Account, host, assignee and resolution filters require non-negative integers; creation timestamps pass through to the server as nonempty values.
Assignment rows project `id`, `host_id`, `account_id`, `date_resolved` and the derived `status`; a missing `date_resolved` reports `RESPONSE_INVALID` rather than implying resolution.
Outcome rows project `id`, `title`, `category` and `builtin` on both generations; user rows project `id` and `username` on QUX and `id` and `name` on RUX, and cloud IDs stay scoped to their cloud profile.
On QUX, user list accepts a server-side `--username` filter; on RUX that filter is refused explicitly with no silent mapping, and `--fields` accepts `id,username` on QUX and `id,name` on RUX.
All three list leaves accept `--fields`, `--limit` (default 100) and `--cursor`; the session allowlist additionally accepts `page` and `page_size` in server-returned continuation links.
Empty windows succeed with an explicit zero message; permission or licence denial reports `ACCESS_DENIED` with exit 1, never an empty healthy result.
Both show leaves require a positive integer `--id` and return their corresponding list field subset with the profile; outcome 3 and user 3 are different objects on different routes.
There is no resolve or outcome-mutation leaf: resolving stays refused by the read-only session, while host/account assignment changes go through the gated `assignment set` leaf above.

`group list`, `group show`, `group member list --id <id>`, `triage rule list` and `triage rule show` read QUX v2.5 or RUX v3.4 groups, members and triage rules through the same session and bounded collection reader.
Group `type` values pass through verbatim with no client-side kind allowlist on either generation, so host, account, IP and domain kinds survive list and show exactly as returned.
On QUX, AD groups require appliance release 9.6 or later and regex groups require 9.0; the member route requires 9.2.
Group list accepts server-side `--name` and `--type` filters and projects `id`, `name` and `type` on both generations.
Group show also returns validated `description`, `importance`, `last_modified_by` and `ad_group_dn` fields when present; QUX adds `last_modified_timestamp` and `is_ad_group`, while RUX keeps its native `last_modified` timestamp and `member_count` instead.
Membership always comes from the dedicated paged member route, never from embedded detail members, so `--include-members` stays rejected as an unknown flag; member windows stay scoped to their group ID with `--name`, `--ordering` and `--is-key-asset true|false` filters, and groups are never merged into one ranking.
RUX group list and show explicitly send `include_members=false`.
Member rows project `id` and `name` on QUX; on RUX each row keeps its native per-kind identity (host `id`/`name`, account `uid`, IP `ip`, domain `domain`), and `--fields` accepts `id,name,uid,ip,domain`.
Member output identifies the owner group ID on both generations; QUX rejects RUX-only projection fields.
Rule list accepts server-side `--contains` and `--ordering` filters and projects `id`, `enabled` and `triage_category` on both generations.
Rule show also returns validated `description`, `source_conditions`, `additional_conditions`, `detection` and `is_whitelist` fields when present on both generations; RUX condition value entries may additionally carry a `url`.
Both condition trees validate recursive `AND`/`OR` child arrays and `ANY_OF`/`NONE_OF` leaves with string `field` and `label`, plus `values` and `groups` arrays of string-or-number `value` and string `label` pairs; malformed nested nodes or unknown condition keys report `RESPONSE_INVALID`.
Rules describe triage automation only: rule output carries no verdict, and a matching rule is never evidence a detection is benign.
All three list leaves accept `--fields`, `--limit` (default 100) and `--cursor`; both show leaves require a positive integer `--id`.
Resuming requires the same filters and, for membership, the same group ID; partial reads retain validated rows, an error and a cursor when available, and exit 1.
Optional nullable detail fields retain null, absent fields stay omitted, and malformed fields report `RESPONSE_INVALID`.
Empty windows succeed with an explicit zero message; permission or licence denial reports `ACCESS_DENIED` with exit 1, never an empty healthy result.
There is no group, member or rule mutation leaf: group and triage rule changes stay deferred families refused by the read-only session.

`audit list --profile <name> --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD>` reads QUX v2.5 audits in one bounded window through the session, never the collection reader: audits are date-windowed single responses with no pages to resume.
Supplied date shapes are validated before profile selection; on QUX, both dates are required and their ordering is validated after profile selection, before HTTP, so omitting either fails instead of starting from the API's unbounded defaults.
The wire carries the ISO calendar days unchanged as `start`/`end`, which the server applies as an inclusive UTC window.
Rows project the recorded subset `user`, `role`, `vectra_timestamp`, `result` and `message`; null fields stay null, malformed bodies report `RESPONSE_INVALID`, and denial reports `ACCESS_DENIED` with exit 1, never an empty success.
Audit windows use the same 8 MiB ceiling for the reserialized decoded body; exceeding either byte check reports `BYTE_BUDGET_EXCEEDED` with a smaller-range suggestion and exit 1.
Failed windows return no partial rows or cursor; the CLI never truncates an oversized window and claims completion.
Empty windows succeed with an explicit zero message.
On a RUX v3.4 cloud profile the same leaf reads one `events/audits` batch per call through the session, never the collection reader: `--from` starts at a returned checkpoint, server-side `--event-timestamp-gte` and `--event-timestamp-lte` bounds pass through for the server to apply inclusively, and `--limit` (default 100) is an output window only, never the upstream batch limit.
`--start-date`/`--end-date` expand to whole-day timestamp bounds (`00:00:00Z` to `23:59:59.999999Z` on the respective days); the pair must come together and cannot combine with explicit timestamp filters.
Output returns the batch's integer `next_checkpoint` as `checkpoint` (including zero) and `remaining_count` as returned, never as a stable total; a `--limit` inside a batch returns an opaque `--cursor` that replays the same checkpoint and skips returned rows.
Resume with the same profile and filters, without `--from`; the cursor preserves the window size across successive resumes unless an explicit `--limit` replaces it.
The cursor binds the batch's ordered event contents; changed rows on replay fail with `RESPONSE_INVALID` before applying the saved offset, with guidance to reissue the read without `--cursor`.
Drain the batch with `--cursor` before using `--from <checkpoint>` to continue past it.
A batch that returns rows without advancing past the requested checkpoint fails with `CONTINUATION_REPEATED`, retaining only the requested window after the saved offset and counting those retained rows, instead of handing back a resumption loop.
Empty batches succeed with an explicit zero; denial reports `ACCESS_DENIED` with exit 1, never an empty success.
The RUX-only feed flags (`--from`, `--limit`, `--cursor`, `--event-timestamp-gte`, `--event-timestamp-lte`) fail on an on-prem profile with `VALIDATION_ERROR` and generation guidance before any HTTP.
There is no audit-event mutation: the session authorizes read GETs only.

`health list` and `health show --check <cpu|disk|network|memory|power|sensors|system|hostid|connectivity|trafficdrop>` read QUX v2.5 health snapshots through the session, never the collection reader: snapshots are single versioned bodies with no pages to resume.
The check selector is validated before profile selection; unsupported checks fail explicitly instead of returning a neighboring check.
`--fresh` sends `cache=false` for a live check, otherwise the query omits `cache` and the upstream cached default (with `updated_at`) applies; `--no-vlans` sends `vlans=false` to omit VLAN detail.
Output reports `cached` from the request flags and passes the returned body through untouched: sections vary with enabled products/subscriptions, so no availability is synthesized and no fixed schema is projected.
On a RUX v3.4 cloud profile the same snapshot leaves read the v3.4 health routes: `health list` reads `/api/v3.4/health/` and `health show` reads `/api/v3.4/health/{check_type}/` for the same ten checks.
Cloud snapshot output carries a subscription-variance help note because v3.4 responses vary with Network, AWS and M365 subscriptions; QUX snapshot output is unchanged.
On a cloud profile `health show` also accepts five RUX-only selectors on their own fixed routes: `--check external-connectors` reads `/api/v3.4/health/external_connectors/` with server-side `--connector-type`, `--data-type` and `--live` filters, and `--check edr` reads `/api/v3.4/health/edr/` with `--edr-type`, `--data-type` and `--live`.
The corresponding `--check external-connectors-details` and `--check edr-details` routes accept their respective type filter and `--live`, while `--check network-brain-ping` takes no query parameters.
All five selectors reject `--fresh` and `--no-vlans`; mismatched filters and `--data-type` on details routes also fail before profile selection or HTTP.
These selectors refuse QUX profiles with generation guidance; their bodies pass through untouched with the subscription-variance note and no cached/fresh claim.
`health event list` reads one QUX `events/health` batch per call through the session: `--from` starts at a returned checkpoint, server-side `--ordering`, `--status`, `--health-check-name`, `--entity-type` and `--entity-name` filters pass through, and `--limit` (default 100) is an output window only, never the upstream batch limit.
The event feed requires appliance release 9.4 or later when the profile declares one; without a declared release the read proceeds and the server decides.
Output returns the batch's `next_checkpoint` as `checkpoint` and `remaining_count` as returned, never as a stable total; a `--limit` inside a batch returns an opaque `--cursor` that replays the same checkpoint and skips returned rows.
Resume with the same profile and filters, without `--from`; the cursor preserves the window size across successive resumes unless an explicit `--limit` replaces it.
The cursor binds the batch's ordered event contents; changed rows or ordering on replay fail with `RESPONSE_INVALID` before applying the saved offset, with guidance to reissue the read without `--cursor`.
Drain the batch with `--cursor` before using `--from <checkpoint>` to continue past it.
A batch that returns rows without advancing past the requested checkpoint fails with `CONTINUATION_REPEATED`, retaining only the requested window after the saved offset and counting those retained rows, instead of handing back a resumption loop.
Empty batches succeed with an explicit zero; denial reports `ACCESS_DENIED` with exit 1, never an empty healthy result.
On a cloud profile `health event list` reads `/api/v3.4/events/health/` with the same flags: integer `next_checkpoint` values normalize to their decimal form, and `--from` must contain only decimal digits on RUX; a non-numeric checkpoint fails before HTTP.
No appliance-release gate applies to cloud profiles, which carry no declared release.
A cursor binds its generation's operation: a QUX cursor never resumes a cloud read and vice versa.
No health or configuration mutation exists: the session authorizes read GETs only.

`detection event list --profile <name>` reads one RUX v3.4 `events/detections` batch per call on a cloud profile through the session, never the collection reader: `--from` starts at a returned checkpoint, server-side `--event-timestamp-gte` and `--event-timestamp-lte` bounds pass through for the server to apply inclusively, and `--limit` (default 100) is an output window only, never the upstream batch limit.
Output returns the batch's integer `next_checkpoint` as `checkpoint` (including zero) and `remaining_count` as returned, never as a stable total; a `--limit` inside a batch returns an opaque `--cursor` that replays the same checkpoint and skips returned rows.
`--from` requires an integer checkpoint; equivalent forms such as `0001` and `1` identify the same checkpoint.
Resume with the same profile and filters, without `--from`; the cursor preserves the window size across successive resumes unless an explicit `--limit` replaces it.
The cursor binds the batch's ordered event contents; changed rows on replay fail with `RESPONSE_INVALID` before applying the saved offset, with guidance to reissue the read without `--cursor`.
Drain the batch with `--cursor` before using `--from <checkpoint>` to continue past it.
A batch that returns rows without advancing past the requested checkpoint fails with `CONTINUATION_REPEATED`, retaining only the requested window after the saved offset and counting those retained rows, instead of handing back a resumption loop.
Empty batches succeed with an explicit zero; denial reports `ACCESS_DENIED` with exit 1, never an empty success; an on-prem profile reports `OPERATION_UNKNOWN` before any credential or HTTP work.
There is no detection-event mutation: the session authorizes read GETs only.
`entity scoring list --profile <name> --type <host|account>` reads one RUX v3.4 `events/entity_scoring` batch per call on a cloud profile through the session, never the collection reader: `--type` is required and selects the scored kind, `--from` starts at a returned checkpoint, server-side `--event-timestamp-gte` and `--event-timestamp-lte` bounds pass through for the server to apply inclusively, and `--limit` (default 100) is an output window only, never the upstream batch limit.
Output returns the batch's integer `next_checkpoint` as `checkpoint` (including zero) and `remaining_count` as returned, never as a stable total; a `--limit` inside a batch returns an opaque `--cursor` that replays the same checkpoint and skips returned rows.
`--from` requires an integer checkpoint; equivalent forms such as `0001` and `1` identify the same checkpoint.
Resume with the same profile and filters, without `--from`; the cursor preserves the window size across successive resumes unless an explicit `--limit` replaces it.
The cursor binds the batch's ordered event contents and its own operation, so a detection-event cursor never resumes a scoring read; changed rows on replay fail with `RESPONSE_INVALID` before applying the saved offset, with guidance to reissue the read without `--cursor`.
Drain the batch with `--cursor` before using `--from <checkpoint>` to continue past it.
A batch that returns rows without advancing past the requested checkpoint fails with `CONTINUATION_REPEATED`, retaining only the requested window after the saved offset and counting those retained rows, instead of handing back a resumption loop.
Scores pass through untouched with no conversion.
Empty batches succeed with an explicit zero; denial reports `ACCESS_DENIED` with exit 1, never an empty success; an on-prem profile reports `OPERATION_UNKNOWN` before any credential or HTTP work.
There is no entity-scoring mutation: the session authorizes read GETs only.

`lockdown list --profile <name> --type <host|account>` reads QUX lockdown status in one unpaged response through the session, never the collection reader: each kind has its own status route with no query parameters, and `--type` is required to select it.
On a RUX v3.4 cloud profile `lockdown list` reads the single `/api/v3.4/lockdown/` endpoint with its `type` selector, including the RUX-only `traffic` value.
Cloud rows carry `entity_id` and `type`, with optional `id`, `entity_name`, `locked_by`, `lock_event_timestamp` and `unlock_event_timestamp`; unrecorded fields are stripped, nulls stay null, and output carries a subscription-variance help note because v3.4 responses vary with Network, AWS and M365 subscriptions.
`--type traffic` on a QUX profile fails before HTTP with guidance to use a cloud profile; QUX host and account routes and output are unchanged.
QUX host rows carry `host_id` and account rows carry `account_id`, each with optional `lock_date`, `locked_by` and `unlock_date` metadata; null fields stay null, unrecorded fields are stripped, and malformed bodies report `RESPONSE_INVALID` on either generation.
Status only: no lockdown execution leaf exists, and the session authorizes read GETs only.
QUX host status requires the configured Microsoft Defender ATP Lockdown integration and account status requires the configured AD Lockdown capability; the selected kind's prerequisite is repeated in the output help.
Empty status succeeds with an explicit zero message; permission or licence denial reports `ACCESS_DENIED` with exit 1, never an empty healthy result.

`api get --profile <name> --operation <id>` reads one allowlisted GET operation by inventory ID through the session, never a parallel HTTP path: `--operation` is required and must name a reviewed collection or single-response read, `--path` binds the route template variables and `--query` passes only the operation's recorded server-side keys, both as `name=value` pairs joined with `&`.
Quote pairs containing shell metacharacters and percent-encode reserved characters inside values, for example `--query 'name=R%26D'` for `R&D`.
Values are percent-decoded once before the session encodes them for transport; use `%25` for a literal percent sign, and `+` remains a literal plus.
The destination stays the configured profile's instance: there is no URL or host argument, no custom header and no other method.
Raw reads require a nonempty recorded field policy and return only those fields; `--fields` narrows that projection.
The `fields` and `exclude_fields` query selectors also accept only recorded field names.
Collection operations return a bounded window (`--limit`, default 100) with an opaque `--cursor` that resumes with the same operation and filters; single responses return in one body.
Both share the named output contracts: explicit zero results, retained partial rows with `complete:false` and exit 1, redaction, and the 1200-character truncation preview with a `--full` escape.
Unknown, unreviewed, blocked sensitive-route and write operations fail before any credential or HTTP work, as do generation mismatches; checkpoint and date-window feeds are refused with guidance to their named leaves.
See [coverage](docs/coverage.md) for the per-route raw disposition; there is no unrestricted passthrough.

For OAuth, replace `auth` and `tokenEnv` with `"auth": "oauth"`, `"clientId": "synthetic-client"` and `"secretEnv": "VECTRA_LAB_SECRET"`.
Set the variable named by `secretEnv` outside the CLI.
Client IDs must be nonempty without whitespace or the Basic-auth colon delimiter.
QUX OAuth requires appliance release 9.1 or later.
For QUX, the internal credential provider requests Basic client authentication on the named `POST /api/v2.5/oauth2/token` exchange with form `grant_type=client_credentials`.
It caches Bearer credentials in invocation memory until the returned numeric `expires_in`, measured conservatively from exchange start.
At expiry QUX reacquires using client credentials; it never uses a returned refresh token or assumes a fixed lifetime.
Successful responses require a nonempty access token containing only ASCII letters, digits, `-`, `.`, `_`, `~`, `+` or `/`, optionally followed by trailing `=` padding, a case-insensitive Bearer `token_type`, and finite numeric `expires_in` yielding a safe integer expiry in epoch milliseconds.
Unsuitable access tokens are rejected before caching; a failed reacquisition cannot return the expired credential.
Missing secrets report `AUTH_REQUIRED`, rejected client credentials report `AUTH_FAILED`, denied access reports `ACCESS_DENIED`, and certificate errors report `TLS_TRUST_ERROR`.
Already-expired returned credentials report `AUTH_EXPIRED`; malformed successful responses report `AUTH_RESPONSE_INVALID`; other status or transport failures report `AUTH_EXCHANGE_FAILED`.
An exchange failure triggers no automatic retry or business request.
Remote response bodies and raw transport errors are discarded from exchange errors.
The provider registers the client secret, encoded Basic credential and returned access/refresh token strings with the existing redactor, including rejected responses.
Malformed Unicode remains redacted in raw and JSON-escaped forms; an unused malformed refresh token does not prevent authentication.
The named OAuth exchange runs over the same session adapter and destination checks as resource requests and never follows redirects.
A RUX v3.4 cloud profile uses `"kind": "rux"` with `"apiVersion": "3.4"` and OAuth credentials; its token exchange is the unversioned `POST /oauth2/token` route with Basic client authentication and Bearer resource use, and cloud IDs stay scoped to their cloud profile.
At access-token expiry, RUX spends an available refresh token once using form `grant_type=refresh_token` on the same route; optional numeric `refresh_expires_in` bounds its lifetime from exchange start.
An expired refresh token or refresh rejection (HTTP 400, 401 or 403) causes a fresh client-credentials exchange; transport and service failures do not trigger automatic retries.
Returned rotated refresh tokens can renew subsequent credentials, but a previously spent token is never reused, even if returned again.
All credential material stays in invocation memory, is registered for redaction, and is never written to persistent storage or exposed in command results.
See the [shipped behavior above](#vectra-axi) for supported RUX resource reads and the [implementation plan](docs/implementation-plan.md#phase-3-adopt-rux-without-making-callers-relearn-the-tool) for remaining cloud slices.
See [Release](#release) for the current RUX doctor check.
See [AUTH-02 handoff](docs/auth-02-handoff.md) for the credential seam, [CORE-01 handoff](docs/core-01-handoff.md) for the session interface, [CORE-02 handoff](docs/core-02-handoff.md) for bounded collections and [CORE-01 acceptance](docs/implementation-plan.md#core-01-handoff-and-acceptance) for fixture evidence.

## Release

See the [shipped behavior above](#vectra-axi) and the generated [coverage record](docs/coverage.md) for supported operations, per-operation dispositions and coverage limits.
Install from npm with `npm install --global @knowttl/vectra-axi`.
For a local build, install its tarball with `npm install --global ./vectra-axi.tgz` after `corepack pnpm pack --out vectra-axi.tgz`, or run `node bin/vectra-axi.js` from a built checkout.
The package is configured for public npm publication as `@knowttl/vectra-axi`.
The `.github/workflows/release-please.yml` workflow manages release PRs on `main` and builds, checks and publishes newly created releases with provenance using npm trusted publishing from the public repository.
Publication is skipped when the release version already exists on npm.
Version `0.1.0` is bootstrap-published on npm, and release-please continues from that version.
Before commissioning automatic publication, enable the repository's "Allow GitHub Actions to create and approve pull requests" setting and complete npm trusted publisher configuration.
Setup is explicit only: hand-edit `~/.vectra-axi/config.json` (see `vectra-axi setup`), set the referenced secret variables outside the CLI, then run `vectra-axi doctor`.
Doctor selects a profile using the precedence above; only when multiple profiles have no explicit, environment or default selection does it check every configured profile.
Without any configured profiles it reports `PROFILE_REQUIRED` before HTTP.
`doctor` performs one bounded `detection list --limit 1` window per selected QUX profile and reports configuration, connectivity, authentication and access failures with a nonzero exit status when any profile fails.
The window uses the normal bounded collection retries and budgets; OAuth profiles may also perform their named credential exchange.
RUX profiles keep the exchange-only check: `doctor` checks each selected RUX profile with its named OAuth exchange alone; resource reads use the leaves documented above.
Success and recovery commands preserve the checked config path and profile, using shell quoting and inline `--profile=<name>` syntax.
It never tries passwords, signs in interactively or enables writes.
The static skill at `skills/vectra-axi/SKILL.md` is installed only by explicit setup (`npx skills add knowttl/vectra-axi --skill vectra-axi`); no ordinary command installs hooks, plugins or configuration.
The command table in `skills/vectra-axi/SKILL.md` and all of `docs/coverage.md` are generated from the executable catalogue and capability inventory; the skill's surrounding guidance is maintained manually.
After `corepack pnpm run build`, regenerate these projections with `corepack pnpm run docs:generate` and verify freshness with `corepack pnpm run docs:check` (also enforced by the test suite).
