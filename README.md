# vectra-axi

Vectra AI QUX and RUX CLI for agents and the humans running them, with bounded reads and gated writes.

[![npm version](https://img.shields.io/npm/v/@knowttl/vectra-axi)](https://www.npmjs.com/package/@knowttl/vectra-axi) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Node.js](https://img.shields.io/node/v/@knowttl/vectra-axi)](package.json) [![npm provenance](https://img.shields.io/badge/npm-provenance-verified)](https://www.npmjs.com/package/@knowttl/vectra-axi?activeTab=provenance) [![AXI](https://img.shields.io/badge/AXI-agent%20interface-blue)](https://github.com/kunchenguid/axi)

[Why](#why-this-exists) · [Quickstart](#quickstart) · [Agent setup](#use-with-your-agent) · [Coverage](#what-it-covers) · [Safety](#safety) · [Configuration](#configuration) · [Output](#output-and-exit-codes) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing) · [Security](#security) · [License](#license)

## Why this exists

Investigating Vectra detections through REST means handling deployment-specific routes, authentication, pagination and verbose responses in each agent session.
vectra-axi exposes reviewed QUX and RUX operations with compact TOON output, bounded reads and actionable next steps.
Writes require a profile allowlist, a preview and explicit execution gates.
It uses Vectra APIs directly without an MCP server; an inventory entry alone never enables an operation.

## Quickstart

Requires Node.js 22.12 or later and a Vectra API credential for network reads.

```sh
npm install --global @knowttl/vectra-axi
vectra-axi
# Alternative without a global install:
npx -y @knowttl/vectra-axi
```

Synthetic excerpt from the offline home view before configuration:

```text
state: unconfigured
profiles: 0
```

Run `vectra-axi setup` to print the config path and example without writing files.
Save the [QUX token or RUX OAuth profile](docs/configuration.md#profiles-and-secretrefs) there and supply the referenced secret through your secret manager or a protected file.
Then check the profile and read detections:

```sh
vectra-axi auth status --profile onprem
vectra-axi doctor --profile onprem
vectra-axi detection list --profile onprem --limit 2
```

## Use with your agent

<a id="global-install-and-session-hooks"></a>

```sh
vectra-axi setup hooks
npx skills add knowttl/vectra-axi --skill vectra-axi
```

Hooks inject local session context into Claude Code, Codex and OpenCode; the skill supplies on-demand command guidance.
Neither grants API permissions or enables writes.
Install hooks from a stable global installation; temporary, worktree and pipeline targets are refused.
Restart the agent session after installation.
See [SKILL.md](skills/vectra-axi/SKILL.md) for the full command table and [hook behavior](docs/configuration.md#session-hooks) for details.
To remove hooks, delete only `vectra-axi-hook` SessionStart entries from `~/.claude/settings.json` and `~/.codex/hooks.json`, and delete `~/.config/opencode/plugins/axi-vectra-axi-hook.js`.
Keep other integrations and Codex's shared hooks setting intact.

## What it covers

<a id="command-surface-and-subcommands"></a>

| Groups | Purpose | Access | Reference |
| --- | --- | --- | --- |
| `home`, `setup`, `profile`, `config`, `auth`, `doctor` | Local state, integration setup and explicit connectivity checks | Local; doctor reads | [Configuration](docs/configuration.md) |
| `detection`, `host`, `account`, `entity` | Investigate detections and entities; manage notes, tags and state | Read / gated write | [Investigation](docs/investigation.md) |
| `assignment`, `user` | Inspect users, assign work and resolve outcomes | Read / gated write | [Commands](docs/commands.md) |
| `group`, `triage` | Inspect groups and manage membership and triage automation | Read / gated write | [Writes](docs/writes.md) |
| `threat-feed`, `match` | Threat feeds, rulesets and device assignments | Read / gated write | [Writes](docs/writes.md#feeds-match-and-triage-rules) |
| `setting`, `notification`, `proxy` | Monitoring, export, event delivery and attribution settings | Read / gated write | [Writes](docs/writes.md) |
| `audit`, `health`, `lockdown`, `api` | Audit, health, lockdown status and allowlisted raw reads | Read | [Commands](docs/commands.md) |

Deployment support is operation-specific; see the generated [command reference](docs/commands.md) and [coverage record](docs/coverage.md).
Run `vectra-axi --help` or `vectra-axi <command> --help` for flags and examples.
Group help lists immediate choices; incomplete commands exit 2 with a focused help hint.

## Safety

vectra-axi is read-only by default, even with an upstream write-capable credential.
Writes require hand-edited `writes.allowWrites: true` and an exact operation in `writes.operations`.
Omitting `--execute` previews; `--dry-run` explicitly previews and cannot combine with `--execute`.
Execution requires `--execute --confirm '<exact target>'`; previews may read current state and require the allowlist too.
`VECTRA_AXI_READ_ONLY=1` overrides every profile's write opt-in; there is no `VECTRA_AXI_ALLOW_*` environment gate.
Mutations require a durable redacted journal; never replay an unknown outcome without reading back.
Pre-send re-reads detect conflicts but do not provide atomic server-side concurrency protection.
Secrets use environment or protected-file references, never argv or inline config values; TLS verification is mandatory.
See the [write gates and scope matrix](docs/writes.md), [upstream permissions](docs/permissions.md) and [credential handling](docs/configuration.md#profiles-and-secretrefs).

## Configuration

Profiles select QUX token/OAuth or RUX OAuth deployments.
Selection follows `--profile`, `VECTRA_AXI_PROFILE`, a complete env profile, `defaultProfile`, then the sole configured profile.
`--config` overrides `VECTRA_AXI_CONFIG`; repository-local files are never discovered automatically.

| Platform | Default config | Default state directory |
| --- | --- | --- |
| Linux / macOS | `~/.config/vectra-axi/config.json` | `~/.local/state/vectra-axi` |
| Windows | `%APPDATA%\vectra-axi\config.json` | `%LOCALAPPDATA%\vectra-axi` |

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `VECTRA_AXI_CONFIG` | Config file | Platform path above |
| `VECTRA_AXI_PROFILE` | Profile selector | Selection above |
| `VECTRA_AXI_READ_ONLY` | Force read-only: `1` / `true`; `0` / `false` disables override | Off; invalid values fail closed |
| `VECTRA_AXI_WRITE_LOG` | Mutation journal file | `writes.log` in state directory |
| `VECTRA_AXI_KIND` | Env profile deployment kind | Unset |
| `VECTRA_AXI_ORIGIN` | Env profile HTTPS origin | Unset |
| `VECTRA_AXI_API_VERSION` | Env profile API version | Unset |
| `VECTRA_AXI_AUTH` | Env profile auth model | Unset |
| `VECTRA_AXI_CLIENT_ID` | Env profile OAuth client ID | Unset |
| `VECTRA_AXI_TOKEN` | Default token reference / env profile secret | Unset |
| `VECTRA_AXI_CLIENT_SECRET` | Default OAuth reference / env profile secret | Unset |
| `VECTRA_AXI_APPLIANCE_RELEASE` | Optional QUX release checks | Unset |
| `VECTRA_AXI_CA_BUNDLE` | Optional env profile PEM trust bundle | System trust |
| `XDG_CONFIG_HOME` | Unix config root; absolute paths only | `~/.config` |
| `XDG_STATE_HOME` | Unix state root; absolute paths only | `~/.local/state` |
| `APPDATA` | Windows config root | `~/AppData/Roaming` |
| `LOCALAPPDATA` | Windows state root | `~/AppData/Local` |
| `HOME` | Skill discovery home | OS home |
| `CODEX_THREAD_ID`, `PI_SESSION_ID` | Detect agent host for skill hint | Unset |
| `OPENCODE`, `CLAUDECODE` | Detect host when `1` | Unset |
| `CODEX_HOME` | Codex skill discovery root | `~/.codex` |
| `CLAUDE_CONFIG_DIR` | Claude skill discovery root | `~/.claude` |
| `OPENCODE_CONFIG_DIR` | Additional OpenCode skill root | Unset |
| `PI_CODING_AGENT_DIR` | Pi skill discovery root | `~/.pi/agent` |
| `ProgramFiles` | Windows managed Claude skill root base | `C:\Program Files` |

<a id="profiles-and-secretrefs"></a>
<a id="doctor"></a>

See [configuration and SecretRef examples](docs/configuration.md) for secure file permissions, env profile requirements, OAuth, CA bundles and legacy-path migration.
Doctor reads one bounded QUX detection window or checks RUX OAuth only; RUX success does not prove resource-read access.
Without a selected or default profile, doctor checks all configured profiles.

## Output and exit codes

<a id="toon-output-behavior"></a>

Structured results, help and errors use TOON on stdout; diagnostics use stderr.
Lists use compact fields and a default 100-row window; supported `--fields` vary by command and deployment.
Long text is previewed; `--full` expands returned text without recovering server omissions.
Supported collections use `--all` and resumable `--cursor`; partial failures retain validated rows and report `complete: false`.
See [output and pagination](docs/output.md) for traversal budgets, checkpoints and date windows.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Runtime failure, including partial reads |
| 2 | Usage failure |

## Troubleshooting

| Error | Next step |
| --- | --- |
| `CONFIG_INVALID` | Check the [profile schema and env requirements](docs/configuration.md) |
| `CONFIG_MOVED` | Follow the emitted move command for legacy config or journal |
| `PROFILE_AMBIGUOUS` | Pass `--profile <name>` or configure `defaultProfile` |
| `AUTH_REQUIRED` | Supply the referenced environment secret or protected secret file |
| `VERSION_CONFLICT` | Read current state and review a fresh preview |

## Contributing

<a id="development--testing"></a>

See [CONTRIBUTING.md](CONTRIBUTING.md) for isolated offline checks, fixture conventions, documentation generation and compatibility policy, and [release guidance](docs/releases.md) for publication.

## Security

See [SECURITY.md](SECURITY.md) for reporting instructions.

## License

Released under the [MIT License](LICENSE).
