# vectra-axi
Agent-ergonomic CLI for Vectra AI, read-only by default

The INV-01 capability inventory, CLI-01 local command shell and AUTH-01 profiles/token/TLS primitives are implemented.
No Vectra API operations are implemented yet.
The selected direction is TypeScript, on-prem QUX reads first, and a later RUX adapter for cloud migration.

- [Design and source evidence](docs/design.md)
- [Implementation slices and offline acceptance](docs/implementation-plan.md)
- [Inventory format, dispositions and verification](docs/inventory.md)

Development requires Node 22.12 or later and pnpm 10.34.6 through Corepack.
Run `corepack pnpm install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false`, then `corepack pnpm run build`, `corepack pnpm test` and `corepack pnpm run lint`.
Tests deny external network and require no Vectra credentials.

Run `node bin/vectra-axi.js` after building for the unconfigured home view.
`home` and `setup` are local, read-only status views; `setup` installs nothing.
Run `node bin/vectra-axi.js --help` or `node bin/vectra-axi.js setup --help` for catalogue-generated help and examples.
Bare `-v`, `-V` and `--version` print only the package version without loading the command graph.
Every local leaf accepts `--help` or `--profile <name>` (also `--profile=<name>`); these flags are mutually exclusive.
Profile selection follows `--profile`, `VECTRA_AXI_PROFILE`, configured `defaultProfile`, then the sole configured profile.
Missing profiles report `PROFILE_REQUIRED`, unknown selections report `PROFILE_NOT_FOUND`, and multiple profiles without a selection report `PROFILE_AMBIGUOUS`.
Unknown commands, flags, positional arguments, repeated flags and version combinations fail before profile or network work.
API commands remain planned, and the SDK's implicit `update` command is refused.

Structured data, help and errors use TOON on stdout; stderr is reserved for diagnostics.
Exit codes are 0 for success, 1 for runtime failure (including a missing profile), and 2 for usage failure.
There are no prompts, HTTP calls or ordinary-command installation side effects.
`corepack pnpm pack --out vectra-axi.tgz` packages the built entrypoint, runtime modules and inventory.
See [CLI-01 acceptance](docs/implementation-plan.md#phase-0-turn-design-knowledge-into-one-executable-catalogue) for packaged verification.

Profiles live in `~/.vectra-axi/config.json`, or a file explicitly selected with `--config <path>` or `VECTRA_AXI_CONFIG`.
Repository-local configuration is never discovered automatically.
`setup` shows a synthetic example and the selected config path; hand-edit the file to configure a profile.
There is no credential prompt, config writer, browser login reuse or connectivity check.

```json
{
  "defaultProfile": "lab",
  "profiles": {
    "lab": {
      "kind": "qux",
      "origin": "https://fixture.invalid",
      "apiVersion": "2.5",
      "applianceRelease": "9.4",
      "auth": "token",
      "tokenEnv": "VECTRA_LAB_TOKEN",
      "caBundle": "private-ca.pem"
    }
  }
}
```

`applianceRelease` and `caBundle` are optional.
The origin must be an exact HTTPS origin without credentials, path, query, fragment or trailing slash.
Only QUX v2.5 personal-token profiles are supported in AUTH-01; OAuth, RUX, mixed authentication fields, inline secrets and TLS bypass settings fail at configuration load, including in unselected profiles.
Set the environment variable named by `tokenEnv` outside the CLI; never pass a secret in argv or the config file.
Token resolution provides `Authorization: Token …` to the future session and does not infer a personal token's expiry.
Private CA paths resolve relative to the config file and extend system trust while retaining certificate and hostname verification.
Local status views describe configuration without reading tokens or CA material for authentication; transport integration belongs to CORE-01.
Known referenced secret values are scrubbed from output and from error metadata before SDK formatting.
Future session failures distinguish `AUTH_REQUIRED`, `AUTH_EXPIRED` (explicit expiry evidence), `AUTH_FAILED`, `ACCESS_DENIED` and `TLS_TRUST_ERROR`; all are runtime failures with exit 1.
Write policy configuration and enforcement remain assigned to WRITE-00; no business writes are available.
See [AUTH-01 handoff](docs/auth-01-handoff.md) for the implemented contract and offline evidence.
