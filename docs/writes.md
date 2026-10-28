# Write reference

[Write gates](#gated-writes) · [Operation scopes](#write-scopes) · [Feeds, Match and triage rules](#feeds-match-and-triage-rules)

## Gated writes

**Writes are disabled until a profile explicitly enables the matching operation.**
Even previews require that scope and may read current state over the network.
Omitting `--execute` previews without sending a mutation.
`--dry-run` is explicit preview mode and cannot be combined with `--execute`.
Execution requires both `--execute` and an exact `--confirm` target.
RUX `notification destination list` and `show --id <id>` redact webhook URLs and tokens.
`notification destination create|edit --config-file <path|->` takes JSON with `destination_type`, `title`, optional `enabled`, and `config` containing `destination_params.url` and optional `event_rules`.
Edit fully replaces the destination, so supply the original URL and tokens rather than redacted read output.
Documents containing `***redacted***` are rejected before any preview.
These are high risk egress operations; `delete --id <id>` stops event delivery.
Allowlist `rux.notification-destination.create`, `.edit` or `.delete` and confirm `new notification destination` for create or `notification destination <id>` for edit/delete.
The pre-send re-read detects changes, including secret-only changes, but does not provide atomic concurrency protection.
Group member add/remove/set previews the full member diff; groups drive triage rules and importance.
Use `--id <id>` with either `--members <comma-separated-list>` or `--members-file <path|->` containing a JSON array.
An empty JSON array with set clears membership.
Membership replacement refuses regex and AD groups.
Enable `<generation>.group.member.set` for these commands and confirm `group <id>`; changed membership before sending is refused.
Group create/edit/delete requires allowlisted `<generation>.group.<action>` operations.
Create requires `--type host|account|ip|domain --name --description --importance` and exactly one of `--members`, `--regex` or `--ad-group-dn`; confirm `new group`.
QUX regex creation requires release 9.0 and AD creation requires 9.6 when the profile release is known.
Edit accepts `--id` and one or more of `--name`, `--description` and `--importance`.
Edit and delete confirm `group <id>` and refuse changed metadata before sending; this re-read is not atomic protection.
Delete is disruptive because it orphans triage rule references.
`VECTRA_AXI_READ_ONLY=1` overrides every profile's write opt-in.

These examples preview only, after the matching operations are enabled:

```sh
vectra-axi detection tag set --profile onprem --id 42 --tags reviewed,investigating
vectra-axi host tag bulk-set --profile onprem --ids 7,8 --tags reviewed
vectra-axi detection note add --profile onprem --id 42 --note 'Investigation started'
vectra-axi detection note edit --profile cloud --id 42 --note-id 7 --note 'Investigation updated'
vectra-axi detection note delete --profile cloud --id 42 --note-id 7
vectra-axi assignment set --profile onprem --host 7 --user 3
vectra-axi assignment outcome create --profile onprem --title 'Example outcome' --category internal
vectra-axi detection close --profile onprem --id 42 --reason benign
vectra-axi detection open --profile cloud --ids 41,42
vectra-axi detection fixed set --profile onprem --ids 41,42 --value true
vectra-axi detection triage set --profile cloud --ids 41 --category synthetic-triage
vectra-axi detection triage clear --profile cloud --ids 41
vectra-axi host key-asset set --profile onprem --id 7 --value true
```

For single-target tag changes, note appends, and assignments, confirmation is the kind and ID, for example `--execute --confirm 'detection 42'`.
Note edit/delete requires the note ID too, for example `--execute --confirm 'detection 42 note 7'`.
Bulk confirmation names the complete normalized target set, for example `--execute --confirm '2 targets: host 7, host 8'`.

- `tag set` replaces the complete tag set; an empty `--tags-file` clears it.
- `tag bulk-set` adds named tags and `tag bulk-delete` removes named tags from at most 100 explicit targets.
  Bulk tag operations run per target and may partially succeed; inspect every reported outcome.
- `note add` appends every time, including repeated identical text.
  Note commands accept `--note` or `--note-file`; use `-` for stdin.
- RUX `note bulk-add --ids 7,8 --note <text>` appends one note to at most 100 explicit targets with one native request.
  It confirms the complete target count and set and appends again on every execution.
- `note edit` replaces text and `note delete` removes a note.
  Their previews truncate long text; inspect `note list --full` before confirming.
- `assignment set` requires one of `--host` or `--account`, plus one of `--user` or `--unassign`.
- `assignment resolve` requires one of `--host` or `--account` and an existing `--outcome` ID.
  Preview warns that there is no unresolve; optional `--detections` requires exactly one of `--mark-fixed` or `--triage-as`.
- `detection fixed set` marks or unmarks legacy fixed state with `--value true|false` and exactly one of `--id` or `--ids`, capped at 100 explicit detections.
  QUX uses the bulk route even for a single ID; RUX uses single or bulk routes.
  Marking fixed zeroes detection scores; detection close supersedes it on release 9.3+.
  Preview and pre-send reads skip targets already in the desired state.
- `detection close` and `detection open` accept exactly one of `--id` or `--ids`, capped at 100 explicit detections.
  Close requires `--reason remediated|benign`; reopening restores scoring.
  Single-target confirmation is `detection <id>`; bulk confirmation names the complete normalized set.
  Both support QUX release 9.3 or later and RUX v3.4, re-read detection state before sending, and skip an already desired state.
- `host close` and `account close` require `--id` and `--reason remediated|benign`, with confirmation such as `--confirm 'host 7'`.
  These disruptive operations close every active detection on the entity and have no single inverse.
  The preview counts active detections by reading at most 100 entries from the entity's `detection_set`; larger sets are refused.
  A changed active detection set on the pre-send re-read is refused; this check is not atomic with the mutation.
  QUX requires release 9.3 or later when `applianceRelease` is declared; undeclared releases are left to the server.
- `assignment outcome create` requires `--title` and `--category benign_true_positive|malicious_true_positive|false_positive|internal`, confirmed with `new assignment outcome`.
  `assignment outcome edit` requires `--id` and at least one of `--title` or `--category`; delete requires `--id`.
  Edit and delete confirm `assignment outcome <id>` and refuse builtin outcomes on both reads.
  Equal edits send nothing; changed state between reads is refused.
- `host key-asset set` requires `--id` and `--value true|false`, with confirmation `host <id>`.
  QUX and RUX re-read `key_asset` before sending and skip an already desired state.
- `detection triage set` requires `--ids` and a nonempty `--category`; `detection triage clear` requires `--ids`.
  Triage suppresses scoring; clearing removes that suppression.
  Both accept at most 100 explicit detections and confirm the complete normalized target set.
  They re-read triage state before sending and refuse changes, without inferring an already desired label.
  QUX support is VAT-only evidence; the QUX PDF does not document this per-detection route.

Tag replacement, note edit/delete, and assignment changes re-read before sending and refuse conflicting state with `VERSION_CONFLICT`.
These comparisons are not atomic server-side version checks; concurrent changes after the re-read can still be overwritten or removed.
- `proxy list` and `proxy show --id <id>` read proxy settings on QUX and RUX.
  `proxy create --address 192.0.2.10 --consider true` confirms `new proxy 192.0.2.10`.
  `proxy edit --id <id>` accepts `--address` and/or `--consider true|false`; `proxy delete --id <id>` is RUX only.
  Edit and delete confirm `proxy <id>` and require a user-defined proxy.
  Proxy settings affect detection attribution.
  Creates read the full list; edits and deletes re-read the proxy before sending and refuse concurrent changes.
  This check is not atomic; PATCH may change the proxy ID, so read the list after an ambiguous outcome.

Mutation intent and outcome are recorded durably as redacted metadata, without note text.
If a timeout leaves the outcome unknown, use the audit ID and read-back guidance before taking another action; never replay an ambiguous mutation.

## Write scopes

Add a `writes` object inside the selected profile to opt into specific implemented operations, for example:

```json
"writes": {
  "allowWrites": true,
  "operations": ["qux.detection.tag.set"]
}
```

| Operation pattern | Supported scope |
| --- | --- |
| `<generation>.group.create`, `.edit`, `.delete` | Group metadata on QUX or RUX |
| `<generation>.group.member.set` | Group member add/remove/set on QUX or RUX |
| `<generation>.<kind>.tag.set` | Replace tags on QUX or RUX |
| `<generation>.<kind>.tag.bulk-set`, `<generation>.<kind>.tag.bulk-delete` | Bulk tag changes on QUX or RUX |
| `<generation>.<kind>.note.add` | Append notes on QUX or RUX |
| `rux.<kind>.note.bulk-add` | Append a note to up to 100 explicit RUX targets with one native request |
| `<generation>.<kind>.note.edit`, `<generation>.<kind>.note.delete` | Edit/delete notes on QUX or RUX |
| `<generation>.<kind>.assignment.create`, `.reassign`, `.unassign` | Assignments for hosts/accounts on QUX or RUX |
| `<generation>.<kind>.assignment.resolve` | Resolve open assignments for hosts/accounts on QUX or RUX |
| `<generation>.assignment-outcome.create`, `.edit`, `.delete` | Custom assignment outcomes on QUX or RUX |
| `<generation>.proxy.create`, `.edit`; `rux.proxy.delete` | User-defined proxies; settings affect detection attribution |
| `qux.setting.internal-network.set` | High risk: replaces all monitoring and drop lists; changes what is monitored or dropped |
| `qux.setting.syslog.set`, `qux.setting.kafka.set` | Disruptive: replaces detection export configuration and redirects data egress |
| `rux.notification-destination.create`, `.edit`, `.delete` | High risk: redirects event data to external endpoints or stops delivery; RUX only |
| `<generation>.threat-feed.create`, `.edit`, `.delete`, `.file.set`, `.file.delete` | Threat intelligence feeds; affect matching and detection scoring |
| `<generation>.match.enablement.set` | Disruptive: changing Match enablement causes a reboot; licence required to enable |
| `<generation>.match.ruleset.upload`, `.delete`, `.assignment.set`, `.assignment.delete` | Match rulesets and device assignments; licence required for upload and assignment creation |
| `<generation>.detection.close`, `<generation>.detection.open` (including `-bulk` variants) | Close/reopen detections on QUX (release 9.3+) or RUX |
| `<generation>.detection.fixed.set` | Mark/unmark legacy fixed state on QUX or RUX |
| `<generation>.host.key-asset.set` | Set host key-asset state on QUX or RUX |
| `<generation>.detection.triage.set`, `.clear` | Set/clear per-detection triage suppression on QUX or RUX |
| `<generation>.triage-rule.create`, `.edit`, `.delete` | Create/replace/delete org-wide triage rules on QUX or RUX |
| `<generation>.host.close`, `<generation>.account.close` | Close hosts/accounts with all active detections on QUX (release 9.3+) or RUX |

QUX `setting syslog set --config-file <path|->` and `setting kafka set --config-file <path|->` accept full JSON documents with real secrets restored.
Start from the complete preview structure, never from redacted preview output or the projected `api get` subset, which omits keys the POST would then drop.
Documents containing `***redacted***` are rejected before any preview.
These endpoints configure servers already created through the UI.
They preview redacted before/after documents, skip unchanged documents, and re-read before sending to detect concurrent changes.
The re-read is not atomic concurrency protection.
Execution requires the exact confirmation target `syslog export` or `kafka export`, alongside the existing profile opt-in and operation allowlist.
RUX is unsupported.

Replace `<kind>` with `detection`, `host`, or `account`, except assignments, which support only `host` and `account`, and detection close/open/fixed set, which support only `detection`.
Replace `<generation>` with `qux` or `rux`.
Assignment suffixes each require the full operation name, such as `qux.host.assignment.reassign`.
An absent scope or `allowWrites: false` disables writes; `operations` must be a nonempty array.
Listing an operation does not implement or authorize an unsupported route.

## Feeds, Match and triage rules

Triage-rule create, full replacement and delete use the gated write policy on QUX and RUX.
These high-risk rules affect org-wide automation and can suppress future detections.
Use `threat-feed list` or `threat-feed show --id <id>` to review feed metadata without printing STIX contents.
Create previews with `threat-feed create --name neutral-feed --category cnc --certainty High --indicator-type Watchlist --duration 7` and confirms `new threat feed neutral-feed`.
Edit accepts `--id` plus any of the create fields; existing default fields are preserved.
`threat-feed file set --id <id> --file <stix>` uploads or replaces a file; `threat-feed file delete --id <id>` removes the file; `threat-feed delete --id <id>` removes the feed.
All existing-feed writes confirm `threat feed <id>` and re-read metadata before sending; this check is not atomic.
Writes remain off until a hand-edited profile allowlists the exact operation, default to preview, and require `--execute --confirm` to send.

Use `match enablement show --device SYNTH0001`, `match ruleset show --uuid <uuid>` and `match assignment list` to read Match state.
`match enablement set --device SYNTH0001 --value true` previews a disruptive change and warns that changing state causes a reboot.
Enabling requires a valid Match licence; a previously enabled device can be disabled after licence expiry.
Enablement confirms `match device SYNTH0001`; unchanged state is a no-op.
`match ruleset upload --file <path>` uses the bounded multipart sender, capped at 5000000 bytes, and confirms `new match ruleset`.
The RUX multipart `/vectra-match/rules/` route is deprecated; the documented successor is the staged `/rules/upload/` flow, not implemented by this CLI.
`match ruleset delete --uuid <uuid>` confirms `match ruleset <uuid>`.
`match assignment set|delete --device SYNTH0001 --uuid <uuid>` adds or removes one ruleset on one device and confirms `match assignment SYNTH0001 ruleset <uuid>`.
Match writes re-read before sending, without atomic concurrency protection; upload previews and journals contain only file metadata, never file bytes.
`VECTRA_AXI_READ_ONLY=1` overrides that opt-in.
Uploads accept regular file paths only, never stdin, and refuse files over 5,000,000 bytes before any request.
The sender verifies the file digest again before sending; preview and journal record only the name, size and SHA-256 digest, never file bytes or paths.
Read back after an unknown outcome; never replay it.

Use `triage rule create --rule-file rule.json`, `triage rule edit --id 7 --rule-file rule.json` or `triage rule delete --id 7` to preview.
`--rule-file -` reads JSON from stdin.
The complete document requires `description`, `detection_category`, `triage_category`, `detection`, `is_whitelist`, `source_conditions` and `additional_conditions`.
Conditions are null or `{"OR":[{"AND":[{"ANY_OF":{"field":"host","label":"Host","values":[{"value":7,"label":"Example host"}],"groups":[]}}]}]}`; `NONE_OF` is also supported.
Edit previews full before/after documents; delete previews the full rule.
Execution needs an allowlisted `{qux,rux}.triage-rule.{create,edit,delete}` operation and exact `--execute --confirm 'new triage rule'` or `--confirm 'triage rule 7'`.
Edit and delete refuse changed rules before sending; the client-side re-read is not atomic.
There is no lockdown execution command.
QUX lockdown status requires the corresponding Microsoft Defender ATP or AD Lockdown integration.
RUX health and lockdown responses vary with subscriptions; empty or denied results do not establish that a deployment is healthy.
Triage rules describe automation and do not establish that a detection is benign.

