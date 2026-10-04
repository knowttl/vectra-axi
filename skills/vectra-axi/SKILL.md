---
name: vectra-axi
description: Use vectra-axi for Vectra SOC inspection through explicit profiles, plus gated tag replaces, note appends and assignment sets.
user-invocable: false
---

# vectra-axi

Agent-ergonomic CLI for Vectra AI, read-only by default, through token-efficient TOON output.
Gated tag replaces (`detection|host|account tag set`), note appends (`detection|host|account note add`) and assignment sets (`assignment set --host|--account --user|--unassign`) require hand-enabled profiles.
See [README.md](../../README.md) for shipped reads by deployment and write restrictions.

Run `vectra-axi doctor` first.
See [README release guidance](../../README.md#release) for its profile selection, bounded checks and recovery behavior.

## Orientation

The exact current leaf registry is `src/catalogue.ts`. Its capability labels
are `native` (implemented by a vectra-axi handler) and its Vectra effect is
`read` for reads and `write` for the gated tag replaces, note appends and assignment sets. The list below
records current executable leaves; it
makes no coverage claim for other Vectra operations. See `docs/coverage.md`
for the per-operation disposition records.
See [README release guidance](../../README.md#release) for generating and checking this table and the coverage record.

<!-- command-registry:start -->
| Command | Capability | Vectra effect |
|---|---|---|
| `vectra-axi home` | native | read |
| `vectra-axi setup` | native | read |
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
| `vectra-axi detection note add` | native | write |
| `vectra-axi host note list` | native | read |
| `vectra-axi host tag list` | native | read |
| `vectra-axi host tag set` | native | write |
| `vectra-axi host note add` | native | write |
| `vectra-axi account note list` | native | read |
| `vectra-axi account tag list` | native | read |
| `vectra-axi account tag set` | native | write |
| `vectra-axi account note add` | native | write |
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
| `vectra-axi lockdown list` | native | read |
<!-- command-registry:end -->

Run `vectra-axi <complete-leaf-path> --help` for that leaf's accepted flags
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
argv or the config file. `vectra-axi setup` shows the selected config path
and a synthetic example; it writes nothing.

```sh
vectra-axi setup                  # selected config path and example
vectra-axi doctor                 # explicit profile check
vectra-axi detection list --profile <name> --state active --limit 100
```

## Selecting a profile

See [README.md](../../README.md) for profile flags, selection precedence and missing-profile errors, including doctor's multiple-profile behavior.

## Safety

See [README.md](../../README.md) for the session's generation-specific authorization and credential behavior.
Host 7 and account 7 are different objects: `entity show` requires `--type host|account`.
Audit windows require both `--start-date` and `--end-date` as inclusive UTC days.
Health event reads start from a returned `--from` checkpoint, never a computed next ID.
Lockdown output is status only; no lockdown execution leaf exists.
