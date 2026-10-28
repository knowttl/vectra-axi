# Investigation guide

[Deployment support](#deployment-support) · [Detection context](#detection-context) · [Examples](#examples) · [Host and entity fields](#host-and-entity-fields)

## Deployment support

Deployment columns summarize each domain; individual commands have narrower support.
Detection events and entity scoring are RUX-only; note append, assignment set and assignment resolve support QUX and RUX.
Note edit/delete and tag writes support both deployments, as do detection/host/account note and tag reads.
`health event list` supports both; connector/EDR checks and traffic lockdown status are RUX-only.
QUX group membership requires appliance 9.2 or later.

## Detection context

Detection show includes returned triage and assignment fields on QUX and RUX: `is_triaged`, `triage_rule_id`, `triage_category`, `assigned_to`, `assigned_date`, `filtered_by_rule`, `filtered_by_user`, `filtered_by_ai` and `is_marked_custom`.
Detection list exposes these through `--fields`, retaining its five default columns.
Assignment details may include user identities; credential redaction still applies to nested values.
Use `--full` for the complete returned description; it cannot restore fields omitted by the server.
For additional triage context, use `triage rule list` and `audit list`.

## Examples

Use `vectra-axi --help` for the catalogue and `vectra-axi <command> --help` for flags.
Help cannot be combined with `--profile`.
Bare `-v`, `-V` or `--version` prints the package version.

```sh
# Local state and explicit connectivity check
vectra-axi home
vectra-axi doctor --profile onprem

# Investigate detections and their context
vectra-axi detection list --profile onprem --state active --limit 20
vectra-axi detection list --profile onprem --fields id,state,threat --ordering=-id
vectra-axi detection show --profile onprem --id 42 --full
vectra-axi detection note list --profile onprem --id 42 --full
vectra-axi detection tag list --profile onprem --id 42
vectra-axi host list --profile onprem --threat-gte 70
vectra-axi account show --profile onprem --id 19
vectra-axi entity list --profile cloud --type host

# Assignments, groups, and triage rules
vectra-axi assignment list --profile onprem
vectra-axi assignment outcome list --profile onprem
vectra-axi user list --profile cloud
vectra-axi group list --profile cloud
vectra-axi group member list --profile cloud --id 7
vectra-axi triage rule show --profile onprem --id 3

# Audit, health, lockdown status, and cloud event feeds
vectra-axi audit list --profile onprem --start-date 2026-10-01 --end-date 2026-10-02
vectra-axi health show --profile onprem --check connectivity --fresh
vectra-axi lockdown list --profile cloud --type traffic
vectra-axi detection event list --profile cloud --limit 20
vectra-axi entity scoring list --profile cloud --type host --limit 20
vectra-axi audit list --profile cloud --limit 20

# Reviewed raw read, using an inventory operation ID
vectra-axi api get --profile onprem --operation qux.detection.show --path id=42
```

## Host and entity fields

`host show` returns every host field supplied by the QUX v2.5 or RUX v3.4 API as raw TOON, including IP/MAC data when present, nested values and fields added by the API.
The API object is under `host`; CLI metadata (`profile`, `type`, `help`, `note_summary`) stays outside it, so identically named API fields are preserved inside `host`.
Strings longer than 500 characters are previewed; use `host show --profile <name> --id <id> --full` for complete returned text.
Secret redaction applies with and without `--full`; upstream omissions cannot be recovered.
`host list` keeps its compact field projection and existing paging budgets.

`entity list` and `entity show` require `--type host|account`.
`entity show --profile <name> --type host --id <id>` returns the same full host object as `host show`, with `--full` for complete text; account and RUX entity behavior is unchanged.
RUX entity urgency and importance remain distinct from threat and certainty; its entity facade rejects threat/certainty filters.
Use `host list` or `account list` for those filters on RUX.
`user list --username` is QUX-only; RUX users expose `name` rather than `username`.

