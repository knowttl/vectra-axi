---
name: vectra-axi
description: "Inspect Vectra QUX and RUX detections, hosts, accounts, notes, tags, assignments, groups, health and lockdown, plus reviewed raw reads and gated tag, note and assignment writes, through token-efficient TOON output."
user-invocable: false
---

# vectra-axi

Agent-ergonomic CLI for Vectra AI, read-only by default, through token-efficient TOON output.
Covers QUX (on-prem v2.5) and RUX (cloud v3.4) detection, host, account, type-qualified entity, note, tag, assignment, outcome, user, group, member, triage-rule, audit, health, lockdown, detection-event and entity-scoring reads, plus the reviewed `api get` raw-read leaf over allowlisted GET operations.
Gated tag replaces (`detection|host|account tag set`), bulk tag changes (`detection|host|account tag bulk-set|bulk-delete`), note appends (`detection|host|account note add`), note edits/deletes (`detection|host|account note edit|delete`) and assignment sets (`assignment set --host|--account --user|--unassign`) require hand-enabled profiles.
See [README.md](../../README.md) for shipped reads by deployment and write restrictions.

Run commands non-interactively as `npx -y @knowttl/vectra-axi ...`: no global install needed and no interactive prompts.
Version pinning is the installer's choice: use `npx -y @knowttl/vectra-axi@<version> ...` to select a specific release.
Never run against a real Vectra instance in tests; use the offline suite instead.

Run `npx -y @knowttl/vectra-axi doctor` first.
See [README release guidance](../../README.md#release) for its profile selection, bounded checks and recovery behavior.

## Orientation

The exact current leaf registry is `src/catalogue.ts`. Its capability labels
are `native` (implemented by a vectra-axi handler) and its Vectra effect is
`read` for reads (including the reviewed `api get` raw reads) and `write` for the gated tag replaces, bulk tag changes, note appends, note edits/deletes and assignment sets. The list below
records current executable leaves; it
makes no coverage claim for other Vectra operations. See `docs/coverage.md`
for the per-operation disposition records.
See [README release guidance](../../README.md#release) for generating and checking this table and the coverage record.

<!-- command-registry:start -->
| Command | Capability | Vectra effect |
|---|---|---|
| `vectra-axi home` | native | read |
| `vectra-axi setup` | native | read |
| `vectra-axi setup hooks` | native | read |
| `vectra-axi doctor` | native | read |
| `vectra-axi detection list` | native | read |
| `vectra-axi detection show` | native | read |
| `vectra-axi detection event list` | native | read |
| `vectra-axi host list` | native | read |
| `vectra-axi host show` | native | read |
| `vectra-axi account list` | native | read |
| `vectra-axi account show` | native | read |
| `vectra-axi entity list` | native | read |
| `vectra-axi entity show` | native | read |
| `vectra-axi entity scoring list` | native | read |
| `vectra-axi detection note list` | native | read |
| `vectra-axi detection tag list` | native | read |
| `vectra-axi detection tag set` | native | write |
| `vectra-axi detection tag bulk-set` | native | write |
| `vectra-axi detection tag bulk-delete` | native | write |
| `vectra-axi detection note add` | native | write |
| `vectra-axi detection note edit` | native | write |
| `vectra-axi detection note delete` | native | write |
| `vectra-axi host note list` | native | read |
| `vectra-axi host tag list` | native | read |
| `vectra-axi host tag set` | native | write |
| `vectra-axi host tag bulk-set` | native | write |
| `vectra-axi host tag bulk-delete` | native | write |
| `vectra-axi host note add` | native | write |
| `vectra-axi host note edit` | native | write |
| `vectra-axi host note delete` | native | write |
| `vectra-axi account note list` | native | read |
| `vectra-axi account tag list` | native | read |
| `vectra-axi account tag set` | native | write |
| `vectra-axi account tag bulk-set` | native | write |
| `vectra-axi account tag bulk-delete` | native | write |
| `vectra-axi account note add` | native | write |
| `vectra-axi account note edit` | native | write |
| `vectra-axi account note delete` | native | write |
| `vectra-axi assignment list` | native | read |
| `vectra-axi assignment set` | native | write |
| `vectra-axi assignment outcome list` | native | read |
| `vectra-axi assignment outcome show` | native | read |
| `vectra-axi user list` | native | read |
| `vectra-axi user show` | native | read |
| `vectra-axi audit list` | native | read |
| `vectra-axi group list` | native | read |
| `vectra-axi group show` | native | read |
| `vectra-axi group member list` | native | read |
| `vectra-axi triage rule list` | native | read |
| `vectra-axi triage rule show` | native | read |
| `vectra-axi health list` | native | read |
| `vectra-axi health show` | native | read |
| `vectra-axi health event list` | native | read |
| `vectra-axi api get` | native | read |
| `vectra-axi lockdown list` | native | read |
<!-- command-registry:end -->

Run `npx -y @knowttl/vectra-axi <complete-leaf-path> --help` for that leaf's accepted flags
and reference. Unknown flags fail before any credential or HTTP work.

## Setup (explicit only)

No ordinary command installs or changes configuration. Hand-edit
`~/.vectra-axi/config.json`, or select a file with `--config <path>`:

```json
{
  "defaultProfile": "lab",
  "profiles": {
    "lab": {
      "kind": "qux",
      "origin": "https://qux.example.invalid",
      "apiVersion": "2.5",
      "auth": "token",
      "tokenEnv": "VECTRA_LAB_TOKEN"
    }
  }
}
```

Set the variable named by `tokenEnv` outside the CLI. Never pass a secret in
argv or the config file. `npx -y @knowttl/vectra-axi setup` shows the selected config path
and a synthetic example; it writes nothing.

```sh
npx -y @knowttl/vectra-axi setup                  # selected config path and example
npx -y @knowttl/vectra-axi doctor                 # explicit profile check
npx -y @knowttl/vectra-axi detection list --profile <name> --state active --limit 100
```

## Selecting a profile

See [README.md](../../README.md) for profile flags, selection precedence and missing-profile errors, including doctor's multiple-profile behavior.

## Safety

Read-only by default. Every write previews first and sends only with `--execute` plus a typed `--confirm` naming the exact target; the profile must hand-enable the operation in its `writes` scope, and `VECTRA_AXI_READ_ONLY=1` forces read-only for the whole process.
Unknown outcomes are never replayed: ambiguous timeouts report the audit id with read-back guidance instead of resending.
Known secret values are scrubbed from output and error metadata.
See [README.md](../../README.md) for the session's generation-specific authorization and credential behavior.
Host 7 and account 7 are different objects: `entity show` requires `--type host|account`.
See [README audit guidance](../../README.md) for QUX date windows and RUX checkpoint feeds.
Health event reads start from a returned `--from` checkpoint, never a computed next ID.
Lockdown output is status only; no lockdown execution leaf exists.
