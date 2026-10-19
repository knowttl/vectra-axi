<h1 align="center">vectra-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@knowttl/vectra-axi"><img alt="npm" src="https://img.shields.io/npm/v/@knowttl/vectra-axi?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/axi"><img alt="AXI" src="https://img.shields.io/badge/AXI-Agent%20eXperience%20Interface-green?style=flat-square" /></a>
</p>

Vectra AI CLI for agents, designed with AXI (Agent eXperience Interface).

vectra-axi provides reviewed reads for QUX (on-premises API v2.5) and RUX (cloud API v3.4), with writes disabled by default.
It emits compact TOON, contextual next-step suggestions, and structured errors on stdout.
Supported writes use explicit profile scopes, previews, and target confirmation.

## Benchmarks & Agent Ergonomics

- Compact list projections keep rows small and actionable.
- Empty results explicitly report zero; partial reads retain validated rows and report failure.
- Bounded collection windows expose cursors for continuation.
- Long descriptions and notes have previews with `--full` on supported read commands.
- Structured errors include codes and recovery hints, with distinct usage and runtime exit codes.

## Quick Start

Requires Node.js 22.12 or later.

### Skill installation

Install the agent skill explicitly:

```sh
npx skills add knowttl/vectra-axi --skill vectra-axi
```

The skill guides agents to invoke the CLI through `npx -y @knowttl/vectra-axi`.

### Zero setup

Inspect help and local configuration state without a global install:

```sh
npx -y @knowttl/vectra-axi
npx -y @knowttl/vectra-axi --help
npx -y @knowttl/vectra-axi setup
```

`home`, `setup`, help, and bare version flags are offline.
`setup` shows the configuration path and an example; it does not create configuration or install integrations.
Configure a profile as described in [Configuration](#configuration) before making API requests.
When following CLI suggestions without a global install, prefix each command with `npx -y @knowttl/vectra-axi`.

## Other ways to install

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

## Usage

The examples below use the globally installed `vectra-axi` command.
Replace profile names and IDs with values from your deployment.
Use `vectra-axi --help` for the command catalogue and a command's `--help` for its flags.
Help cannot be combined with `--profile`.
Bare `-v`, `-V`, or `--version` prints the package version.

### Command surface and subcommands

| Domain | Subcommands | Deployment |
| --- | --- | --- |
| Local setup | `home`, `setup`, `setup hooks`, `doctor`, `auth status`, `profile list`, `config path` | Both |
| `detection` | `list`, `show`, `event list` | Both; events are RUX-only |
| `host`, `account` | `list`, `show` | Both |
| `entity` | `list`, `show`, `scoring list` | Both; scoring events are RUX-only |
| `detection note`, `host note`, `account note` | `list`, `add`, `edit`, `delete` | Reads and edit/delete on both; add on QUX |
| `detection tag`, `host tag`, `account tag` | `list`, `set`, `bulk-set`, `bulk-delete` | Reads on both; writes on QUX |
| `assignment` | `list`, `set`, `outcome list`, `outcome show` | Reads on both; set on QUX |
| `user` | `list`, `show` | Both |
| `group` | `list`, `show`, `member list` | Both |
| `triage rule` | `list`, `show` | Both |
| `audit` | `list` | QUX date window; RUX checkpoint feed |
| `health` | `list`, `show`, `event list` | Both; connector/EDR checks are RUX-only |
| `lockdown` | `list` | Both; traffic status is RUX-only |
| `api` | `get` | Reviewed, allowlisted reads on both |

The [coverage record](docs/coverage.md) lists operation dispositions and limits.
Unlisted operations are not implied by this table.
There is no lockdown execution, assignment resolution, group mutation, or triage-rule mutation command.
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

### Gated writes

**Writes are disabled until a profile explicitly enables the matching operation.**
Even previews require that scope and may read current state over the network.
Omitting `--execute` previews without sending a mutation.
`--dry-run` is explicit preview mode and cannot be combined with `--execute`.
Execution requires both `--execute` and an exact `--confirm` target.
`VECTRA_AXI_READ_ONLY=1` overrides every profile's write opt-in.

These examples preview only, after the matching operations are enabled:

```sh
vectra-axi detection tag set --profile onprem --id 42 --tags reviewed,investigating
vectra-axi host tag bulk-set --profile onprem --ids 7,8 --tags reviewed
vectra-axi detection note add --profile onprem --id 42 --note 'Investigation started'
vectra-axi detection note edit --profile cloud --id 42 --note-id 7 --note 'Investigation updated'
vectra-axi detection note delete --profile cloud --id 42 --note-id 7
vectra-axi assignment set --profile onprem --host 7 --user 3
```

For single-target tag changes, note appends, and assignments, confirmation is the kind and ID, for example `--execute --confirm 'detection 42'`.
Note edit/delete requires the note ID too, for example `--execute --confirm 'detection 42 note 7'`.
Bulk confirmation names the complete normalized target set, for example `--execute --confirm '2 targets: host 7, host 8'`.

- `tag set` replaces the complete tag set; an empty `--tags-file` clears it.
- `tag bulk-set` adds named tags and `tag bulk-delete` removes named tags from at most 100 explicit targets.
  Bulk operations run per target and may partially succeed; inspect every reported outcome.
- `note add` appends every time, including repeated identical text.
  Note commands accept `--note` or `--note-file`; use `-` for stdin.
- `note edit` replaces text and `note delete` removes a note.
  Their previews truncate long text; inspect `note list --full` before confirming.
- `assignment set` requires one of `--host` or `--account`, plus one of `--user` or `--unassign`.

Tag replacement, note edit/delete, and assignment changes re-read before sending and refuse conflicting state with `VERSION_CONFLICT`.
These comparisons are not atomic server-side version checks; concurrent changes after the re-read can still be overwritten or removed.
Mutation intent and outcome are recorded durably as redacted metadata, without note text.
If a timeout leaves the outcome unknown, use the audit ID and read-back guidance before taking another action; never replay an ambiguous mutation.

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

| Variable | Meaning |
| --- | --- |
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

This example uses placeholder origins and credential references:

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
| `qux.<kind>.tag.set` | Replace tags |
| `qux.<kind>.tag.bulk-set`, `qux.<kind>.tag.bulk-delete` | Bulk tag changes |
| `qux.<kind>.note.add` | Append notes |
| `<generation>.<kind>.note.edit`, `<generation>.<kind>.note.delete` | Edit/delete notes on QUX or RUX |
| `qux.<kind>.assignment.create`, `.reassign`, `.unassign` | Assignments for hosts/accounts |

Replace `<kind>` with `detection`, `host`, or `account`, except assignments, which support only `host` and `account`.
Replace `<generation>` with `qux` or `rux`.
Assignment suffixes each require the full operation name, such as `qux.host.assignment.reassign`.
An absent scope or `allowWrites: false` disables writes; `operations` must be a nonempty array.
Listing an operation does not implement or authorize an unsupported route.

### Release

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

See [Development & Testing](#development--testing) for generating the packaged skill command table and coverage record.

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
The generated command table in the skill and the coverage record are checked for freshness by the test suite.

- [Design and source evidence](docs/design.md)
- [Implementation plan and offline acceptance](docs/implementation-plan.md)
- [Inventory format, dispositions, and verification](docs/inventory.md)
- [Operation coverage](docs/coverage.md)

See [CONTRIBUTING.md](CONTRIBUTING.md) for local validation and contribution guidance.
Tests run locally through no-mistakes; pull requests require local validation before merge. The test workflow file remains in the repository but is disabled on GitHub, so Actions runs only the release pipeline.
The release publish job checks build, lint, tests and generated documentation before publishing.

## License

Released under the [MIT License](LICENSE).
