---
name: vectra-axi
description: "Inspect Vectra QUX and RUX detections, hosts, accounts, notes, tags, assignments, groups, health and lockdown, plus reviewed raw reads and gated writes, through token-efficient TOON output."
user-invocable: false
---

# vectra-axi

Agent-ergonomic CLI for Vectra AI, read-only by default, through token-efficient TOON output.
Covers QUX (on-prem v2.5) and RUX (cloud v3.4) detection, host, account, type-qualified entity, note, tag, assignment, outcome, user, group, member, triage-rule, audit, health, lockdown, detection-event and entity-scoring reads, plus the reviewed `api get` raw-read leaf over allowlisted GET operations.
Gated writes require hand-enabled profiles; see the [command reference](https://github.com/knowttl/vectra-axi/blob/main/README.md#command-surface-and-subcommands) for shipped writes by deployment and write restrictions.

Run commands non-interactively as `npx -y @knowttl/vectra-axi ...`: no global install needed and no interactive prompts.
Version pinning is the installer's choice: use `npx -y @knowttl/vectra-axi@<version> ...` to select a specific release.
Never run against a real Vectra instance in tests; use the offline suite instead.

After configuring a profile, run `npx -y @knowttl/vectra-axi doctor` to check connectivity.
See [doctor guidance](https://github.com/knowttl/vectra-axi/blob/main/README.md#doctor) for profile selection and bounded checks.

## Orientation

The table lists shipped commands: `native` means implemented, and the Vectra effect is `read` or gated `write`.
See [operation coverage](https://github.com/knowttl/vectra-axi/blob/main/docs/coverage.md) for per-operation dispositions and [development guidance](https://github.com/knowttl/vectra-axi/blob/main/README.md#development--testing) for regenerating these records.

<!-- command-registry:start -->
| Command | Capability | Vectra effect | List pagination |
|---|---|---|---|
| `npx -y @knowttl/vectra-axi home` | native | read | - |
| `npx -y @knowttl/vectra-axi setup` | native | read | - |
| `npx -y @knowttl/vectra-axi setup hooks` | native | read | - |
| `npx -y @knowttl/vectra-axi doctor` | native | read | - |
| `npx -y @knowttl/vectra-axi auth status` | native | read | - |
| `npx -y @knowttl/vectra-axi profile list` | native | read | Local configuration; no endpoint or --all |
| `npx -y @knowttl/vectra-axi config path` | native | read | - |
| `npx -y @knowttl/vectra-axi detection list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi detection show` | native | read | - |
| `npx -y @knowttl/vectra-axi detection event list` | native | read | RUX: checkpoint batch; --cursor/--from continuation, no --all |
| `npx -y @knowttl/vectra-axi host list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi host show` | native | read | - |
| `npx -y @knowttl/vectra-axi account list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi account show` | native | read | - |
| `npx -y @knowttl/vectra-axi entity list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi entity show` | native | read | - |
| `npx -y @knowttl/vectra-axi entity scoring list` | native | read | RUX: checkpoint batch; --cursor/--from continuation, no --all |
| `npx -y @knowttl/vectra-axi detection triage set` | native | write | - |
| `npx -y @knowttl/vectra-axi detection triage clear` | native | write | - |
| `npx -y @knowttl/vectra-axi detection close` | native | write | - |
| `npx -y @knowttl/vectra-axi detection open` | native | write | - |
| `npx -y @knowttl/vectra-axi host key-asset set` | native | write | - |
| `npx -y @knowttl/vectra-axi detection note list` | native | read | QUX: nonpaged single response; no --all; RUX: nonpaged single response; no --all |
| `npx -y @knowttl/vectra-axi detection tag list` | native | read | QUX: nonpaged single response; no --all; RUX: nonpaged single response; no --all |
| `npx -y @knowttl/vectra-axi detection tag set` | native | write | - |
| `npx -y @knowttl/vectra-axi detection tag bulk-set` | native | write | - |
| `npx -y @knowttl/vectra-axi detection tag bulk-delete` | native | write | - |
| `npx -y @knowttl/vectra-axi detection note add` | native | write | - |
| `npx -y @knowttl/vectra-axi detection note edit` | native | write | - |
| `npx -y @knowttl/vectra-axi detection note delete` | native | write | - |
| `npx -y @knowttl/vectra-axi host close` | native | disruptive | - |
| `npx -y @knowttl/vectra-axi account close` | native | disruptive | - |
| `npx -y @knowttl/vectra-axi host note list` | native | read | QUX: nonpaged single response; no --all; RUX: nonpaged single response; no --all |
| `npx -y @knowttl/vectra-axi host tag list` | native | read | QUX: nonpaged single response; no --all; RUX: nonpaged single response; no --all |
| `npx -y @knowttl/vectra-axi host tag set` | native | write | - |
| `npx -y @knowttl/vectra-axi host tag bulk-set` | native | write | - |
| `npx -y @knowttl/vectra-axi host tag bulk-delete` | native | write | - |
| `npx -y @knowttl/vectra-axi host note add` | native | write | - |
| `npx -y @knowttl/vectra-axi host note edit` | native | write | - |
| `npx -y @knowttl/vectra-axi host note delete` | native | write | - |
| `npx -y @knowttl/vectra-axi account note list` | native | read | QUX: nonpaged single response; no --all; RUX: nonpaged single response; no --all |
| `npx -y @knowttl/vectra-axi account tag list` | native | read | QUX: nonpaged single response; no --all; RUX: nonpaged single response; no --all |
| `npx -y @knowttl/vectra-axi account tag set` | native | write | - |
| `npx -y @knowttl/vectra-axi account tag bulk-set` | native | write | - |
| `npx -y @knowttl/vectra-axi account tag bulk-delete` | native | write | - |
| `npx -y @knowttl/vectra-axi account note add` | native | write | - |
| `npx -y @knowttl/vectra-axi account note edit` | native | write | - |
| `npx -y @knowttl/vectra-axi account note delete` | native | write | - |
| `npx -y @knowttl/vectra-axi assignment list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi assignment set` | native | write | - |
| `npx -y @knowttl/vectra-axi assignment resolve` | native | disruptive | - |
| `npx -y @knowttl/vectra-axi assignment outcome list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi assignment outcome create` | native | write | - |
| `npx -y @knowttl/vectra-axi assignment outcome edit` | native | write | - |
| `npx -y @knowttl/vectra-axi assignment outcome delete` | native | write | - |
| `npx -y @knowttl/vectra-axi assignment outcome show` | native | read | - |
| `npx -y @knowttl/vectra-axi user list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi user show` | native | read | - |
| `npx -y @knowttl/vectra-axi audit list` | native | read | QUX: date window; narrow dates to bound the response, no --all; RUX: checkpoint batch; --cursor/--from continuation, no --all |
| `npx -y @knowttl/vectra-axi group list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi group show` | native | read | - |
| `npx -y @knowttl/vectra-axi group member add` | native | write | - |
| `npx -y @knowttl/vectra-axi group member remove` | native | write | - |
| `npx -y @knowttl/vectra-axi group member set` | native | write | - |
| `npx -y @knowttl/vectra-axi group member list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi triage rule list` | native | read | QUX: collection pages; bounded --all supported; RUX: collection pages; bounded --all supported |
| `npx -y @knowttl/vectra-axi triage rule create` | native | write | - |
| `npx -y @knowttl/vectra-axi triage rule edit` | native | write | - |
| `npx -y @knowttl/vectra-axi triage rule delete` | native | write | - |
| `npx -y @knowttl/vectra-axi triage rule show` | native | read | - |
| `npx -y @knowttl/vectra-axi health list` | native | read | QUX: nonpaged single response; no --all; RUX: nonpaged single response; no --all |
| `npx -y @knowttl/vectra-axi health show` | native | read | - |
| `npx -y @knowttl/vectra-axi health event list` | native | read | QUX: checkpoint batch; --cursor/--from continuation, no --all; RUX: checkpoint batch; --cursor/--from continuation, no --all |
| `npx -y @knowttl/vectra-axi api get` | native | read | - |
| `npx -y @knowttl/vectra-axi lockdown list` | native | read | QUX: nonpaged single response; no --all; RUX: nonpaged single response; no --all |
<!-- command-registry:end -->

Run `npx -y @knowttl/vectra-axi <complete-leaf-path> --help` for that leaf's accepted flags
and reference. Unknown flags fail before any credential or HTTP work.
Use `npx -y @knowttl/vectra-axi detection --help` to discover a group's immediate choices.

## Setup (explicit only)

No ordinary command installs or changes configuration, except the explicit
`npx -y @knowttl/vectra-axi setup hooks` session-hook installer (see [hook setup](https://github.com/knowttl/vectra-axi/blob/main/README.md#global-install-and-session-hooks) for that opt-in path).
Hand-edit
`$XDG_CONFIG_HOME/vectra-axi/config.json` (default `~/.config/vectra-axi/config.json`), or select a file with `--config <path>`:

```json
{
  "version": 1,
  "defaultProfile": "lab",
  "profiles": {
    "lab": {
      "kind": "qux",
      "origin": "https://qux.example.invalid",
      "apiVersion": "2.5",
      "auth": "token",
      "token": { "env": "VECTRA_AXI_TOKEN" }
    }
  }
}
```

Set the variable named by the SecretRef outside the CLI.
Never pass a secret in argv or the config file.
`npx -y @knowttl/vectra-axi setup` shows the selected config path and a synthetic example; it writes nothing.

Windows uses `%APPDATA%\vectra-axi\config.json` and ignores XDG variables.
The old `~/.vectra-axi/config.json` triggers `CONFIG_MOVED` with a move command.
See the [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md).
Use `npx -y @knowttl/vectra-axi auth status` to verify local credential availability without network access.

```sh
npx -y @knowttl/vectra-axi setup                  # selected config path and example
npx -y @knowttl/vectra-axi doctor                 # explicit profile check
npx -y @knowttl/vectra-axi detection list --profile <name> --state active --limit 100
```

## Selecting a profile

See [configuration](https://github.com/knowttl/vectra-axi/blob/main/README.md#configuration) for profile flags, selection precedence and missing-profile errors, including doctor's multiple-profile behavior.

## Safety

Read-only by default. Every write previews first and sends only with `--execute` plus a typed `--confirm` naming the exact target; the profile must hand-enable the operation in its `writes` scope, and `VECTRA_AXI_READ_ONLY=1` forces read-only for the whole process.
Unknown outcomes are never replayed: ambiguous timeouts report the audit id with read-back guidance instead of resending.
Known secret values are scrubbed from output and error metadata.
See [configuration](https://github.com/knowttl/vectra-axi/blob/main/README.md#configuration) for generation-specific authorization and credential behavior.
Host 7 and account 7 are different objects: `entity show` requires `--type host|account`.
See [output guidance](https://github.com/knowttl/vectra-axi/blob/main/README.md#toon-output-behavior) for QUX date windows and RUX checkpoint feeds.
Health event reads start from a returned `--from` checkpoint, never a computed next ID.
Lockdown output is status only; no lockdown execution leaf exists.
