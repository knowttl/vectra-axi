# vectra-axi

Vectra AI QUX and RUX CLI for agents and the humans running them, with reviewed investigation reads and explicitly gated writes.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@knowttl/vectra-axi)](https://www.npmjs.com/package/@knowttl/vectra-axi)
[![Node.js](https://img.shields.io/node/v/@knowttl/vectra-axi)](package.json)
[![npm provenance](https://img.shields.io/badge/npm-provenance-verified)](https://www.npmjs.com/package/@knowttl/vectra-axi?activeTab=provenance)

Inspect local profiles without credentials or a network request.
Actual output on an unconfigured installation:

```console
$ npx -y @knowttl/vectra-axi profile list
count: 0
profiles: []
```

[Quickstart](#quickstart) • [Use with your agent](#use-with-your-agent) • [Features](#features) • [Safety](#safety-and-permissions) • [Configuration](#configuration) • [Commands](#command-surface-and-subcommands)

## Why this exists

Investigating Vectra detections through REST means handling deployment-specific routes, authentication, pagination and verbose responses in each agent session.
vectra-axi applies [AXI](https://github.com/kunchenguid/axi) conventions to QUX on-premises API v2.5 and RUX cloud API v3.4: compact TOON results, bounded reads and actionable errors from a CLI.
It uses Vectra's APIs directly without an MCP server, and enables only reviewed operations.

### Features

- **Investigation:** detections, hosts, accounts, notes, tags, assignments, groups and triage rules, with deployment-specific coverage.
- **Pagination:** bounded collection traversal with `--all` and resumable cursors; checkpoint feeds retain their own continuation rules.
- **Output:** field projections, long-text previews, explicit empty results and validated rows retained on partial failure.
- **Write policy:** per-profile operation allowlists, previews, exact target confirmations and a durable redacted journal.
- **Credentials:** environment or file SecretRefs, mandatory TLS verification and invocation-only OAuth tokens.
- **Agent context:** optional local SessionStart hooks and an installable skill.

## Quickstart

Requires Node.js 22.12 or later, npm, and a Vectra API credential for the deployment you administer.
Start with a local read:

```sh
npx -y @knowttl/vectra-axi profile list
npx -y @knowttl/vectra-axi setup
```

On an unconfigured installation, `profile list` prints `count: 0` and `profiles: []` as shown above.
`setup` prints the config path and a profile example; it creates no configuration or integrations.
Save the [profile example](#profiles-and-secretrefs) at that path, replace the `.invalid` origin with your deployment origin, and supply the referenced token through your secret manager's environment injection or a protected secret file.
Never paste credentials into command arguments or chat.
Use the cloud profile with OAuth instead for RUX.

```sh
npx -y @knowttl/vectra-axi auth status --profile onprem
npx -y @knowttl/vectra-axi doctor --profile onprem
npx -y @knowttl/vectra-axi detection list --profile onprem --ordering=-id --limit 2
```

Example output from the repository's synthetic QUX fixture; your rows and counts depend on your deployment and permissions:

```text
profile: onprem
total: 2
count: 2 detections
detections[2]{id,detection_type,state,threat,certainty}:
  2,synthetic-type,active,72,80
  1,synthetic-type,active,null,80
complete: true
help[1]: Run `vectra-axi detection show --profile onprem --id 2` for full detail
```

`home`, `setup`, `profile list`, `auth status`, help and bare version flags stay offline.
The first `npx` invocation may download the package from npm.
When following CLI suggestions without a global install, prefix commands with `npx -y @knowttl/vectra-axi`.

## Use with your agent

Choose session hooks for automatic local context, or install the skill for discovery on demand.
Either works independently; both may be installed.

```sh
npx skills add knowttl/vectra-axi --skill vectra-axi
```

The skill guides agents to invoke the CLI through `npx -y @knowttl/vectra-axi`.

### Global install and session hooks

```sh
npm install --global @knowttl/vectra-axi
vectra-axi setup hooks
```

This explicitly installs optional SessionStart hooks for Claude Code, Codex, and OpenCode.
Setup refuses hook targets in temporary directories, Git worktrees, and pipeline builds, including symlink targets.
Install the package in a stable location before setting up hooks.
Restart the agent session after installation.
The hook prints a local summary of profile names, deployment kinds, write posture, version, and a next step.
It makes no Vectra or OAuth request and succeeds with a short status when unconfigured.
Ordinary commands do not install hooks or change configuration.
To remove hooks, delete only the SessionStart entries marked `vectra-axi-hook` from `~/.claude/settings.json` and `~/.codex/hooks.json`, and delete the managed `~/.config/opencode/plugins/axi-vectra-axi-hook.js` plugin.
Keep other integrations and Codex's shared hooks feature setting intact.
There is no CLI uninstall command.

### Direct install

```sh
npm install --global @knowttl/vectra-axi
vectra-axi setup
```

For a local build, follow [Development & Testing](#development--testing), then run `node bin/vectra-axi.js`.
To install that build globally:

```sh
corepack pnpm pack --out vectra-axi.tgz
npm install --global ./vectra-axi.tgz
```

## Safety and permissions

Read-only is the default even when the upstream credential has write permissions.
The CLI does not grant API permissions; configure the deployment's API role for the resources you need.

| Access | Required upstream permission |
| --- | --- |
| QUX token reads | Personal API token with read access to the requested resource |
| QUX OAuth reads | API client credentials on appliance 9.1+ with the requested resource access |
| RUX reads | OAuth API client with read access to the requested resource; subscriptions may further restrict routes |
| Named writes | Corresponding tag, note, assignment, detection-state or entity-close mutation permission, plus the local operation scope below |

Permission names vary by deployment; the CLI does not prescribe a universal OAuth scope string.
Resource requests and OAuth exchanges send credentials and requested operation data only to the configured HTTPS origin.
Read results leave the CLI through stdout for your terminal or agent to consume.
Credentials are referenced from environment variables or protected files, never stored by the CLI or printed as values.
There is no login command or persistent credential cache.

### Gated writes

**Writes are disabled until a profile explicitly enables the matching operation.**
Even previews require that scope and may read current state over the network.
Omitting `--execute` previews without sending a mutation.
`--dry-run` is explicit preview mode and cannot be combined with `--execute`.
Execution requires both `--execute` and an exact `--confirm` target.
RUX `notification destination list` and `show --id <id>` redact webhook URLs and tokens.
`notification destination create|edit --config-file <path|->` takes JSON with `destination_type`, `title`, optional `enabled`, and `config` containing `destination_params.url` and optional `event_rules`.
Edit fully replaces the destination, so supply the original URL and tokens rather than redacted read output.
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

## Configuration

Hand-edit `$XDG_CONFIG_HOME/vectra-axi/config.json` (default `~/.config/vectra-axi/config.json`), or select a file with `--config <path>`.
On Windows, configuration lives in `%APPDATA%\vectra-axi\config.json`; XDG variables are ignored.
State lives in `$XDG_STATE_HOME/vectra-axi` (default `~/.local/state/vectra-axi`), or `%LOCALAPPDATA%\vectra-axi` on Windows.
Relative XDG paths are ignored.
The old `~/.vectra-axi/config.json` is never read: when it alone exists, `CONFIG_MOVED` supplies the exact move command.
The same hard cut applies to `~/.vectra-axi/writes.log`; move it into the state directory before issuing another mutation.
See the [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md) and the packaged `axi-credential.schema.json` for one profile's schema.
Repository-local configuration is never discovered automatically.
An absent default file means unconfigured state; an invalid file or missing explicitly selected file reports `CONFIG_INVALID`.

| Flag or variable | Meaning |
| --- | --- |
| `--config <path>` | Explicit config file; overrides `VECTRA_AXI_CONFIG` |
| `--profile <name>` | Explicit profile; overrides `VECTRA_AXI_PROFILE` |
| `--limit`, `--all`, `--cursor` | Bounded list window, collection traversal, continuation; support varies by command |
| `--fields`, `--full` | Field projection or full text on supported commands |
| `--dry-run`, `--execute`, `--confirm` | Write preview or explicitly confirmed execution |
| `VECTRA_AXI_CONFIG` | Config path; overridden by `--config` |
| `VECTRA_AXI_PROFILE` | Profile name; overridden by `--profile` |
| `VECTRA_AXI_READ_ONLY` | `1` or `true` forces read-only; `0`, `false` or unset is off; other values fail closed (case-insensitive) |
| `VECTRA_AXI_WRITE_LOG` | Mutation journal path; defaults to `writes.log` in the state directory |
| `VECTRA_AXI_TOKEN` | Default token SecretRef and env profile token |
| `VECTRA_AXI_CLIENT_SECRET` | Default clientSecret SecretRef and env profile OAuth secret |

Profile selection follows `--profile`, `VECTRA_AXI_PROFILE`, a complete env profile, `defaultProfile`, then the sole configured profile.
An env profile sets `VECTRA_AXI_KIND`, `VECTRA_AXI_ORIGIN`, `VECTRA_AXI_API_VERSION`, `VECTRA_AXI_AUTH`, and `VECTRA_AXI_TOKEN` or both `VECTRA_AXI_CLIENT_ID` and `VECTRA_AXI_CLIENT_SECRET`.
Optional fields use `VECTRA_AXI_APPLIANCE_RELEASE` and `VECTRA_AXI_CA_BUNDLE`.
Partial env profiles fail with `CONFIG_INVALID`; explicit file profile selection ignores those field variables.
Multiple profiles without a selection normally report `PROFILE_AMBIGUOUS`.
Names match exactly, and `defaultProfile` must name an existing profile.

### Profiles and SecretRefs

This example uses placeholder origins and credential references.
`kind`, `origin`, `apiVersion` and `auth` select the deployment and authorization model; secret values stay outside this file.

<details>
<summary>QUX token and RUX OAuth profiles</summary>

```json
{
  "version": 1,
  "defaultProfile": "onprem",
  "profiles": {
    "onprem": {
      "kind": "qux",
      "origin": "https://appliance.invalid",
      "apiVersion": "2.5",
      "applianceRelease": "9.4",
      "auth": "token",
      "token": { "env": "VECTRA_AXI_TOKEN" }
    },
    "cloud": {
      "kind": "rux",
      "origin": "https://cloud.invalid",
      "apiVersion": "3.4",
      "auth": "oauth",
      "clientId": "example-client",
      "clientSecret": { "env": "VECTRA_AXI_CLIENT_SECRET" }
    }
  }
}
```

</details>

Replace the origins and client ID, then set the referenced secret variables outside the CLI.
SecretRefs accept `{"env":"NAME"}` or `{"file":"/absolute/path"}`; file content has a leading BOM and trailing whitespace removed.
Windows file references require an absolute drive path, with UNC and device paths refused.
Omitted secrets default to the corresponding `VECTRA_AXI_*` environment reference.
`{"stored":true}` reports `AUTH_REQUIRED` because vectra-axi does not implement credential storage or login.
The deprecated `tokenEnv` and `secretEnv` keys, including unversioned legacy config envelopes, remain accepted through the `0.1.x` minor line and retire in `0.2.0`.
Migrate to the versioned profile envelope and `token`/`clientSecret` SecretRefs before upgrading to `0.2.0`; patch releases do not end this compatibility window.
Config reads require an owned regular file with no group or other write bits; secret files require no group or other permission bits (0400 is accepted).
Use `chmod 600 <path>` to repair Unix permissions.
Windows writes set a protected DACL for the current account, SYSTEM and Administrators; `auth status` and `doctor` verify it, and ordinary reads reject reparse points.
`vectra-axi config path`, `vectra-axi profile list`, and `vectra-axi auth status` inspect local configuration without network access.
Auth status verifies secret availability and reports its reference, never its value.
Never put secrets in command arguments or the config file.
Origins must be exact HTTPS origins without credentials, paths, queries, fragments, or trailing slashes.
Unknown fields, inline secrets, mixed authentication settings, UI-login fields, and TLS bypass settings are rejected, including in unselected profiles.
There are no credential prompts, browser login reuse, or persistent credential caches.
Known referenced secrets and OAuth credentials are scrubbed from output.

QUX supports personal tokens or OAuth client credentials; OAuth requires appliance release 9.1 or later.
For QUX OAuth, replace `auth` and `token` with `"auth": "oauth"`, `"clientId": "example-client"`, and `"clientSecret": {"env":"VECTRA_AXI_CLIENT_SECRET"}`.
QUX exchanges credentials at `/api/v2.5/oauth2/token`; RUX uses `/oauth2/token` and supports OAuth only, with no `applianceRelease` field.
Access-token lifetimes use the returned expiry, with QUX reacquiring client credentials and RUX supporting refresh-token rotation.
Credentials remain in invocation memory.

`applianceRelease` is optional on QUX and enables applicable release checks.
An optional `caBundle` on either kind points to a PEM CA bundle, resolved relative to the config file.
It extends system trust while retaining certificate and hostname verification.
Requests, redirects, and continuation links are constrained to the profile origin and the authorized operation's route and query keys.
The HTTP adapter applies a 30-second request deadline and an 8 MiB response limit.

### Write scopes

Add a `writes` object inside the selected profile to opt into specific implemented operations, for example:

```json
"writes": {
  "allowWrites": true,
  "operations": ["qux.detection.tag.set"]
}
```

| Operation pattern | Supported scope |
| --- | --- |
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
| `rux.notification-destination.create`, `.edit`, `.delete` | High risk: redirects event data to external endpoints or stops delivery; RUX only |
| `<generation>.threat-feed.create`, `.edit`, `.delete`, `.file.set`, `.file.delete` | Threat intelligence feeds; affect matching and detection scoring |
| `<generation>.detection.close`, `<generation>.detection.open` (including `-bulk` variants) | Close/reopen detections on QUX (release 9.3+) or RUX |
| `<generation>.detection.fixed.set` | Mark/unmark legacy fixed state on QUX or RUX |
| `<generation>.host.key-asset.set` | Set host key-asset state on QUX or RUX |
| `<generation>.detection.triage.set`, `.clear` | Set/clear per-detection triage suppression on QUX or RUX |
| `<generation>.triage-rule.create`, `.edit`, `.delete` | Create/replace/delete org-wide triage rules on QUX or RUX |
| `<generation>.host.close`, `<generation>.account.close` | Close hosts/accounts with all active detections on QUX (release 9.3+) or RUX |

Replace `<kind>` with `detection`, `host`, or `account`, except assignments, which support only `host` and `account`, and detection close/open/fixed set, which support only `detection`.
Replace `<generation>` with `qux` or `rux`.
Assignment suffixes each require the full operation name, such as `qux.host.assignment.reassign`.
An absent scope or `allowWrites: false` disables writes; `operations` must be a nonempty array.
Listing an operation does not implement or authorize an unsupported route.

### Doctor

After configuring profiles, run the explicit check:

```sh
vectra-axi doctor --profile onprem
vectra-axi doctor --profile cloud
```

Doctor checks one bounded detection window (`--limit 1`) for QUX and only the OAuth exchange for RUX.
RUX doctor success does not prove resource-read access.
With several profiles and no explicit, environment, or default selection, doctor checks all configured profiles.
Any failure returns a nonzero exit status; no configured profiles reports `PROFILE_REQUIRED`.
Doctor never enables writes or signs in interactively.

See [Development & Testing](#development--testing) for generating the packaged skill command table, coverage record, command reference and README summary.

## Commands

The examples below use the globally installed `vectra-axi` command.
Replace profile names and IDs with values from your deployment.
Use `vectra-axi --help` for the command catalogue and a command's `--help` for its flags.
Group help, such as `vectra-axi detection --help` or `vectra-axi detection note --help`, lists the immediate choices.
Incomplete commands exit 2 with those choices and a focused help command.
Help cannot be combined with `--profile`.
Bare `-v`, `-V`, or `--version` prints the package version.

### Command surface and subcommands

<!-- command-registry:start -->
| Domain | Commands | Deployment |
| --- | --- | --- |
| `home` | `home` | Local |
| `setup` | `setup`, `setup hooks` | Local |
| `doctor` | `doctor` | QUX, RUX |
| `auth` | `auth status` | Local |
| `profile` | `profile list` | Local |
| `config` | `config path` | Local |
| `detection` | `detection list`, `detection show`, `detection event list`, `detection triage set`, `detection triage clear`, `detection fixed set`, `detection close`, `detection open`, `detection note list`, `detection tag list`, `detection tag set`, `detection tag bulk-set`, `detection tag bulk-delete`, `detection note bulk-add`, `detection note add`, `detection note edit`, `detection note delete` | QUX, RUX |
| `host` | `host list`, `host show`, `host key-asset set`, `host close`, `host note list`, `host tag list`, `host tag set`, `host tag bulk-set`, `host tag bulk-delete`, `host note bulk-add`, `host note add`, `host note edit`, `host note delete` | QUX, RUX |
| `account` | `account list`, `account show`, `account close`, `account note list`, `account tag list`, `account tag set`, `account tag bulk-set`, `account tag bulk-delete`, `account note bulk-add`, `account note add`, `account note edit`, `account note delete` | QUX, RUX |
| `entity` | `entity list`, `entity show`, `entity scoring list` | QUX, RUX |
| `assignment` | `assignment list`, `assignment set`, `assignment resolve`, `assignment outcome list`, `assignment outcome create`, `assignment outcome edit`, `assignment outcome delete`, `assignment outcome show` | QUX, RUX |
| `threat-feed` | `threat-feed list`, `threat-feed show`, `threat-feed create`, `threat-feed edit`, `threat-feed delete`, `threat-feed file set`, `threat-feed file delete` | QUX, RUX |
| `setting` | `setting internal-network show`, `setting internal-network set` | QUX |
| `notification` | `notification destination list`, `notification destination show`, `notification destination create`, `notification destination edit`, `notification destination delete` | RUX |
| `proxy` | `proxy list`, `proxy show`, `proxy create`, `proxy edit`, `proxy delete` | QUX, RUX |
| `user` | `user list`, `user show` | QUX, RUX |
| `audit` | `audit list` | QUX, RUX |
| `group` | `group list`, `group show`, `group create`, `group edit`, `group delete`, `group member add`, `group member remove`, `group member set`, `group member list` | QUX, RUX |
| `triage` | `triage rule list`, `triage rule create`, `triage rule edit`, `triage rule delete`, `triage rule show` | QUX, RUX |
| `health` | `health list`, `health show`, `health event list` | QUX, RUX |
| `api` | `api get` | QUX, RUX |
| `lockdown` | `lockdown list` | QUX, RUX |
<!-- command-registry:end -->

Deployment columns summarize each domain; individual commands have narrower support.
Detection events and entity scoring are RUX-only; note append, assignment set and assignment resolve support QUX and RUX.
Note edit/delete and tag writes support both deployments, as do detection/host/account note and tag reads.
`health event list` supports both; connector/EDR checks and traffic lockdown status are RUX-only.
QUX group membership requires appliance 9.2 or later.

The generated [full command reference](docs/commands.md) lists every executable leaf, its deployment support and paging contract from the CLI registry and inventory.
The [coverage record](docs/coverage.md) lists operation dispositions and limits.
Unlisted operations are not implied by this table.
Triage-rule create, full replacement and delete use the gated write policy on QUX and RUX.
These high-risk rules affect org-wide automation and can suppress future detections.
Use `threat-feed list` or `threat-feed show --id <id>` to review feed metadata without printing STIX contents.
Create previews with `threat-feed create --name neutral-feed --category cnc --certainty High --indicator-type Watchlist --duration 7` and confirms `new threat feed neutral-feed`.
Edit accepts `--id` plus any of the create fields; existing default fields are preserved.
`threat-feed file set --id <id> --file <stix>` uploads or replaces a file; `threat-feed file delete --id <id>` removes the file; `threat-feed delete --id <id>` removes the feed.
All existing-feed writes confirm `threat feed <id>` and re-read metadata before sending; this check is not atomic.
Writes remain off until a hand-edited profile allowlists the exact operation, default to preview, and require `--execute --confirm` to send.
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

`entity list` and `entity show` require `--type host|account`.
RUX entity urgency and importance remain distinct from threat and certainty; its entity facade rejects threat/certainty filters.
Use `host list` or `account list` for those filters on RUX.
`user list --username` is QUX-only; RUX users expose `name` rather than `username`.

### TOON output behavior

- Structured results, help, and errors go to stdout; diagnostics go to stderr.
- Collection lists use compact fields, counts, and a default 100-row window.
  Supported `--fields` values depend on the command and deployment.
- Resume collections with `--cursor` and the original filters and target context.
  A successful bounded window can still have more rows; cursors do not provide snapshot isolation.
- Detection, host, account, type-qualified entity, assignment, assignment outcome, user, group, group member and triage rule lists support `--all` on QUX and RUX.
  It traverses pages within 10 requests (including retries), 8 MiB of decoded page bodies, 60 seconds and 10,000 output rows per invocation.
  `--all` cannot be combined with `--limit`.
  Exhausted budgets retain validated rows, report `complete: false` with an error and continuation cursor, and exit 1.
  Resume with `--all --cursor <cursor>` and the original profile, filters and entity type to start fresh budgets at the next unread position.
- Event feeds return checkpoints and may return a cursor inside a batch.
  Drain that cursor with the original filters and without `--from` before continuing with `--from <checkpoint>`.
  `remaining_count` is not a stable total; changed batches are refused during cursor replay.
- Notes, tags, health summaries and lockdown status are nonpaged single responses and do not accept `--all`.
  Checkpoint event feeds and date-window audits also do not accept `--all`.
  Every list's help and the generated [skill command table](skills/vectra-axi/SKILL.md) state its pagination contract for each supported deployment.
- QUX audits require both inclusive UTC dates and have no cursor; use smaller date windows if the response exceeds the byte budget.
- Partial reads retain validated rows, report `complete: false`, and exit 1.
  Access or licence denial is an error, never an empty success.
- Exit codes are 0 for success, 1 for runtime failure, and 2 for usage failure.

`api get` accepts inventory operation IDs, recorded path/query keys, and recorded field projections only.
It does not accept arbitrary URLs, headers, methods, or credential-export operations.
Quote `--path` and `--query` pairs joined with `&`, and percent-encode reserved characters inside values.
Checkpoint and date-window operations use their named commands instead.

## Coverage

See the generated [operation coverage](docs/coverage.md) for supported operations and explicit limits, and the [command reference](docs/commands.md) for per-deployment commands.
An inventory entry alone does not enable an operation.

## Development & Testing

Use Node.js 22.12 or later and pnpm 10.34.6 through Corepack.

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false
corepack pnpm run build
corepack pnpm test
corepack pnpm run lint
corepack pnpm run docs:check
node scripts/isolated.mjs node bin/vectra-axi.js --help
```

Tests deny external network, run with a temporary HOME and XDG directories, and require no Vectra credentials.
For manual CLI validation, use `node scripts/isolated.mjs node bin/vectra-axi.js --help` to keep agent configuration isolated.
After changing the executable catalogue or capability inventory, rebuild and regenerate documentation with `corepack pnpm run docs:generate`.
The generated command table in the skill, the coverage record, the README summary and the full command reference are checked for freshness by the test suite.
The README summary and full command reference are generated from the same executable registry and checked by `docs:check`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local validation and contribution guidance.
Tests run locally; pull requests require local validation before merge.
The test workflow file remains in the repository but is disabled on GitHub, so Actions runs only the release pipeline.
The release publish job checks build, lint, tests and generated documentation before publishing.

## Versioning and releases

vectra-axi remains pre-1.0; review release notes before upgrading.
Deprecated aliases remain available for one minor release, not one patch release.
Specifically, `tokenEnv`/`secretEnv` and unversioned config envelopes are accepted through `0.1.x` and retire in `0.2.0`; use versioned SecretRef profiles now.

[GitHub releases](https://github.com/knowttl/vectra-axi/releases) and [npm versions](https://www.npmjs.com/package/@knowttl/vectra-axi?activeTab=versions) have two historical differences: `0.1.0` exists on npm without an initial GitHub release, and GitHub's `v0.1.4` publish failed, so npm skips from `0.1.3` to `0.1.5`.
The `0.1.4` gap is preserved; it will not be republished.
Release publication uses npm trusted publishing with provenance.

## Security reporting

GitHub private vulnerability reporting is currently disabled for this repository.
For a sensitive report, [open an issue requesting a private contact channel](https://github.com/knowttl/vectra-axi/issues/new) without disclosing vulnerability details.
Once a private channel is established, include the affected version and a reproduction using synthetic data.
Do not include credentials, customer data or private deployment details in public issues.

## License

Released under the [MIT License](LICENSE).

If this project saved you time or helped your workflow, please consider giving it a ⭐ on GitHub to help others find it!
