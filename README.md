# vectra-axi
Agent-ergonomic CLI for Vectra AI, read-only by default

The INV-01 capability inventory, CLI-01 local command shell, AUTH-01 profiles/token/TLS primitives and AUTH-02 OAuth credential lifecycle are implemented.
No Vectra API operations are implemented yet.
The selected direction is TypeScript, on-prem QUX reads first, and a later RUX adapter for cloud migration.

- [Design and source evidence](docs/design.md)
- [Implementation slices and offline acceptance](docs/implementation-plan.md)
- [Inventory format, dispositions and verification](docs/inventory.md)

Development requires Node 22.12 or later and pnpm 10.34.6 through Corepack.
Run `corepack pnpm install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false`, then `corepack pnpm run build`, `corepack pnpm test` and `corepack pnpm run lint`.
Tests deny external network and require no Vectra credentials.

Run `node bin/vectra-axi.js` after building for the local home view.
`home` and `setup` are local, read-only status views; `setup` installs nothing.
Run `node bin/vectra-axi.js --help` or `node bin/vectra-axi.js setup --help` for catalogue-generated help and examples.
Bare `-v`, `-V` and `--version` print only the package version without loading the command graph.
Every local leaf accepts `--help` or `--profile <name>` (also `--profile=<name>`); these flags are mutually exclusive.
Profile selection follows `--profile`, `VECTRA_AXI_PROFILE`, configured `defaultProfile`, then the sole configured profile.
Without profiles or a selection, local views show unconfigured state successfully.
Selecting a profile when none are configured reports `PROFILE_REQUIRED`; unknown selections among configured profiles report `PROFILE_NOT_FOUND`, and multiple profiles without a selection report `PROFILE_AMBIGUOUS`.
Unknown commands, flags, positional arguments, repeated flags and version combinations fail before profile or network work.
API commands remain planned, and the SDK's implicit `update` command is refused.

Structured data, help and errors use TOON on stdout; stderr is reserved for diagnostics.
Exit codes are 0 for success, 1 for runtime failure (including a missing profile), and 2 for usage failure.
There are no prompts, HTTP calls or ordinary-command installation side effects.
`corepack pnpm pack --out vectra-axi.tgz` packages the built entrypoint, runtime modules and inventory.
See [CLI-01 acceptance](docs/implementation-plan.md#phase-0-turn-design-knowledge-into-one-executable-catalogue) for packaged verification.

Profiles live in `~/.vectra-axi/config.json`, or a file explicitly selected with `--config <path>` or `VECTRA_AXI_CONFIG`.
`--config` takes precedence over `VECTRA_AXI_CONFIG`; both local leaves also accept `--config=<path>`.
An absent default config means unconfigured state; unreadable or malformed files, including an absent explicitly selected file, report `CONFIG_INVALID`.
Help and bare version flags do not read configuration.
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
Profile names and `defaultProfile` must be nonempty identifiers without surrounding whitespace; selections match exactly without trimming.
`defaultProfile`, when present, must name an existing profile.
The origin must be an exact HTTPS origin without credentials, path, query, fragment or trailing slash.
Only QUX v2.5 personal-token and OAuth client-credentials profiles are supported; unknown fields, RUX, mixed authentication fields, inline secrets, UI-login settings and TLS bypass settings fail at configuration load, including in unselected profiles.
Set the environment variable named by `tokenEnv` outside the CLI; never pass a secret in argv or the config file.
Token resolution provides `Authorization: Token …` to the future session and does not infer a personal token's expiry.
Unset, empty or whitespace-only token values report `AUTH_REQUIRED`; other whitespace-containing tokens report `AUTH_FAILED`.
Credential material remains in invocation memory; there is no persistent credential cache.
Private CA paths resolve relative to the config file and extend system trust while retaining certificate and hostname verification.
Local status views describe configuration without reading tokens or CA material for authentication; transport integration belongs to CORE-01.
They show profile name/source, kind, origin, API version, optional appliance release, authentication mode, configured trust mode and disabled writes, without claiming connectivity, credential validity or appliance compatibility.
Known referenced secret values are scrubbed from output and from error metadata before SDK formatting.
Future session failures distinguish `AUTH_REQUIRED`, `AUTH_EXPIRED` (explicit expiry evidence), `AUTH_FAILED` (HTTP 401), `ACCESS_DENIED` (HTTP 403) and `TLS_TRUST_ERROR` (CA loading or known certificate verification errors); all are runtime failures with exit 1.
Write policy configuration and enforcement remain assigned to WRITE-00; no business writes are available.
See [AUTH-01 handoff](docs/auth-01-handoff.md) for integration constraints and offline acceptance links.

For OAuth, replace `auth` and `tokenEnv` with `"auth": "oauth"`, `"clientId": "synthetic-client"` and `"secretEnv": "VECTRA_LAB_SECRET"`.
Set the variable named by `secretEnv` outside the CLI.
Client IDs must be nonempty without whitespace or the Basic-auth colon delimiter.
QUX OAuth requires appliance release 9.1 or later.
The internal credential provider requests Basic client authentication on the named `POST /api/v2.5/oauth2/token` exchange with form `grant_type=client_credentials`.
It caches Bearer credentials in invocation memory until the returned numeric `expires_in`, measured conservatively from exchange start.
At expiry it reacquires using client credentials; it never uses a returned refresh token or assumes a fixed lifetime.
Missing secrets report `AUTH_REQUIRED`, rejected client credentials report `AUTH_FAILED`, denied access reports `ACCESS_DENIED`, and certificate errors report `TLS_TRUST_ERROR`.
Already-expired returned credentials report `AUTH_EXPIRED`; malformed successful responses report `AUTH_RESPONSE_INVALID`; other status or transport failures report `AUTH_EXCHANGE_FAILED`.
An exchange failure triggers no automatic retry or business request.
The provider registers the client secret, encoded Basic credential, access token and any returned refresh token with the existing redactor.
Actual HTTP execution, destination/redirect validation and request deadlines remain CORE-01; all current CLI views remain offline.
See [AUTH-02 handoff](docs/auth-02-handoff.md) for the fixture seam and acceptance evidence.
