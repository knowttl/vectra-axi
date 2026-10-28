# Compact investigation guide

Start here with an already configured profile; use help only to recover from a failed command or inspect an unfamiliar leaf.
Examples use synthetic profile names and IDs: replace `lab` (QUX) or `cloud` (RUX) and IDs with the reviewed case context.
Commands assume a global install; without one, replace `vectra-axi` with `npx -y @knowttl/vectra-axi`.
Set `VECTRA_AXI_READ_ONLY=1` in the investigation environment to force read-only behavior.

## Start with the host's detections

When the host ID is known, request timing, source and target details for the whole host in one invocation:

```sh
vectra-axi detection list --profile lab --host-id 7 --fields id,detection_type,state,first_timestamp,last_timestamp,src_ip,src_host,summary,grouped_details --limit 20
```

This works on QUX and RUX and avoids a `detection show` call per row.
It projects fields returned by the list API; it cannot restore upstream omissions.
The row window can span pages, so one invocation can make several HTTP requests.
Check counts and the returned cursor before concluding that all detections were read.
If only the host name is known, use `host list --name <text>` first, select the matching ID, then pivot with `--host-id`; no combined name-to-detections command exists.
Reads are synchronous; no start/poll sequence is needed.

## Frequent read commands

Each line is an exact example and a separate read-only allowlist candidate.
Scope allowlists to these complete leaf paths, not entire groups containing writes.

```sh
# Local credential availability, without network access
vectra-axi auth status --profile lab
# Discover high-scoring hosts; --name <text> can narrow a known name
vectra-axi host list --profile lab --threat-gte 70 --limit 20
# Host detail includes every returned field, including IP/MAC when supplied
vectra-axi host show --profile lab --id 7
# Account context; host and account IDs are separate namespaces
vectra-axi account show --profile lab --id 7
# Type-qualified entity view requires --type host|account
vectra-axi entity show --profile lab --type host --id 7
# Active detection overview; --threat-gte and --certainty-gte filter scores
vectra-axi detection list --profile lab --state active --threat-gte 70 --fields id,state,threat --limit 20
# One detection when its description or individual context is needed
vectra-axi detection show --profile lab --id 42 --full
# Dedicated notes and tags are separate reads
vectra-axi detection note list --profile lab --id 42 --full
vectra-axi host tag list --profile lab --id 7
# Work ownership, group membership and automation context
vectra-axi assignment list --profile lab --resolved false --limit 20
vectra-axi group list --profile lab --limit 20
vectra-axi group member list --profile lab --id 8 --limit 20
vectra-axi triage rule show --profile lab --id 7
# QUX audit requires both inclusive UTC dates
vectra-axi audit list --profile lab --start-date 2026-10-01 --end-date 2026-10-02
# Health snapshot and lockdown status, without changing either
vectra-axi health list --profile cloud
vectra-axi lockdown list --profile lab --type host
# RUX-only feeds; use returned checkpoints for later batches
vectra-axi detection event list --profile cloud --limit 20
vectra-axi entity scoring list --profile cloud --type host --limit 20
vectra-axi audit list --profile cloud --limit 20
```

QUX group membership requires appliance 9.2+.
Triage rules describe automation, not a benign verdict.
Additional detection list fields worth requesting are `threat,certainty,is_triaged,triage_rule_id,triage_category,assigned_to,assigned_date,filtered_by_rule,filtered_by_user,filtered_by_ai,is_marked_custom`.

## Bound the output

Lists default to 100 rows; use `--limit 20` and a supported comma-separated `--fields` projection for a small first window.
Default detection columns are `id,detection_type,state,threat,certainty`.
`--fields` reduces output, not necessarily the upstream response size.
Detail text is previewed; `--full` expands returned text without recovering server omissions.
Host detail preserves every returned field rather than the list's compact projection.

Collection lists (detections, hosts, accounts, entities, assignments, groups, group members and triage rules) support `--all` instead of `--limit`.
One invocation traverses at most 10 requests including retries, 8 MiB, 60 seconds and 10,000 rows.
Resume a returned `--cursor <cursor>` with the original profile, filters and entity type; keep `--all` when resuming an all-pages read.
Partial reads retain validated rows, set `complete: false` and exit 1; a successful bounded window can also have a continuation cursor.
Notes, tags, health snapshots and lockdown status are nonpaged and reject `--all`.
Event feeds and audits reject `--all`: drain an in-batch cursor with the original filters and without `--from`, then continue with `--from <returned-checkpoint>`.
QUX audits have no cursor; narrow the date window instead.

## Help and failures

`vectra-axi --help` returns the full leaf catalogue, global flags and combinations.
`vectra-axi detection --help` returns only that group's immediate choices.
`vectra-axi detection list --help` returns that leaf's flags, pagination contract and examples.
Use the failing leaf's help when its error guidance is insufficient; do not start each investigation with help.
Do not combine `--help` with `--profile`.
Incomplete commands exit 2 with focused help.
Structured results and errors are TOON on stdout; diagnostics use stderr.
Exit 0 means success, 1 runtime failure (including partial reads), and 2 usage failure.

| Error code | Adjustment |
| --- | --- |
| `VALIDATION_ERROR` | Correct the named flag, required ID/type or invalid cursor context; do not repeat unchanged. |
| `CONFIG_INVALID`, `CONFIG_MOVED`, `PROFILE_AMBIGUOUS` | Repair configuration, follow the emitted migration hint or select `--profile`. |
| `AUTH_REQUIRED` | Supply the configured secret reference outside argv; check local credential availability. |
| `REQUEST_FAILED` | Inspect HTTP status: 401/403 needs credentials, permissions or licence review; 404 needs target/deployment review; 429 needs backoff. |
| `TRANSPORT_FAILED` | Check connectivity and TLS trust; never disable verification. |
| `REQUEST_BUDGET_EXCEEDED`, `ROW_BUDGET_EXCEEDED`, `DEADLINE_EXCEEDED`, `BYTE_BUDGET_EXCEEDED` | Retain partial evidence, resume the returned cursor if present or narrow filters/window. |
| `RESPONSE_INVALID`, `CONTINUATION_REPEATED` | Stop blind retries; inspect upstream response or repeated pagination. |
| `OPERATION_UNKNOWN`, `OPERATION_BLOCKED`, `DESTINATION_DENIED` | Check supported deployment and allowlisted operation; do not bypass the boundary. |

## State-changing commands

The read examples above do not change Vectra state.
Do not allowlist entire `detection`, `host`, `account`, `assignment`, `group` or `triage` groups: they also contain writes.
Note add/edit/delete/bulk-add, tag set/bulk-set/bulk-delete, detection triage/fixed/close/open, host key-asset/close, account close, assignment set/resolve and group/member/triage-rule mutations change state.
Feed, Match, setting, notification and proxy mutations also change state; some alter monitoring, suppress detections, redirect data or reboot devices.
Writes require hand-enabled profile operations; execution additionally requires `--execute --confirm '<exact target>'`.
Omitting `--execute` previews, but previews can read current state and require write authorization.
`setup hooks` changes local integrations and belongs outside investigation allowlists.
See the [complete command/effect table](../skills/vectra-axi/SKILL.md) for the remaining surface.
