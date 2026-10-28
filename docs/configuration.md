# Configuration reference

[Paths and selection](#paths-and-selection) · [Profiles and SecretRefs](#profiles-and-secretrefs) · [Doctor](#doctor) · [Session hooks](#session-hooks)

## Paths and selection

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

## Profiles and SecretRefs

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
See [compatibility policy](../CONTRIBUTING.md#compatibility) for deprecated keys and unversioned config envelopes.
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

## Doctor

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

## Session hooks

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

