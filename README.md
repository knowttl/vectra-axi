# vectra-axi
Agent-ergonomic CLI for Vectra AI, read-only by default

The INV-01 capability inventory, CLI-01 local command shell, AUTH-01 profiles/token/TLS primitives, AUTH-02 OAuth credential lifecycle, CORE-01 QUX session with fixture HTTP adapter, CORE-02 bounded collection reader with retries, cancellation and partial results, and READ-01 detection list/show leaves are implemented.
`detection list` and `detection show` call the session; every other Vectra API operation remains planned or blocked.
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
The SDK's implicit `update` command is refused.

Structured data, help and errors use TOON on stdout; stderr is reserved for diagnostics.
Exit codes are 0 for success, 1 for runtime failure (including a missing profile), and 2 for usage failure.
There are no prompts or ordinary-command installation side effects.
Home, setup, help and version remain offline; detection reads make authenticated HTTP requests.
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
Token resolution provides `Authorization: Token …` to the session and does not infer a personal token's expiry.
Unset, empty or whitespace-only token values report `AUTH_REQUIRED`; other whitespace-containing tokens report `AUTH_FAILED`.
Credential material remains in invocation memory; there is no persistent credential cache.
Private CA paths resolve relative to the config file and extend system trust while retaining certificate and hostname verification.
Local status views describe configuration without reading tokens or CA material for authentication.
The session in `src/session.ts` owns URL construction, operation authorization, credential attachment and response validation in one path; command handlers receive no raw authenticated fetch object.
They show profile name/source, kind, origin, API version, optional appliance release, authentication mode, configured trust mode and disabled writes, without claiming connectivity, credential validity or appliance compatibility.
Known referenced secret values are scrubbed from output and from error metadata before SDK formatting.
Session failures distinguish `AUTH_REQUIRED`, `AUTH_EXPIRED` (explicit expiry evidence), `AUTH_FAILED` (HTTP 401), `ACCESS_DENIED` (HTTP 403) and `TLS_TRUST_ERROR` (CA loading or known certificate verification errors); all are runtime failures with exit 1.
Only known QUX v2.5 read operations from the capability inventory are authorized; unknown, blocked, credential-export and other-generation operations report `OPERATION_UNKNOWN` or `OPERATION_BLOCKED` before any credential is resolved or HTTP call is made.
The session itself does not retry: unmapped failure statuses report `REQUEST_FAILED`, malformed success bodies report `RESPONSE_INVALID`, unreachable origins report `TRANSPORT_FAILED`, and any destination outside the profile's HTTPS origin and version prefix - including cross-origin redirects and continuation links - reports `DESTINATION_DENIED` with no credential sent.
Same-origin redirects and continuation links must retain the operation's bound pathname and declared query keys.
Redirects are followed up to 3 hops; continuation links are validated and fetched by the bounded collection reader in `src/collections.ts`, which keeps every page inside the session's same-operation authorization.
The production adapter verifies TLS, applies a 30-second deadline per HTTP request and limits each response body to 8 MiB.
Write policy configuration and enforcement remain assigned to WRITE-00; no business writes are available.
See [AUTH-01 handoff](docs/auth-01-handoff.md) for integration constraints and offline acceptance links.

The internal collection reader defaults to a 100-row window; a successful bounded window returns `complete: true` and may still carry a cursor for more rows.
Collection pages require a `results` array; `count` may be absent, null or a non-negative integer, and `next` may be absent, null or a nonempty URL string.
The first usable `count` is retained across pages and resumes; otherwise `total` is `null`, and `remaining_count` never supplies a stable total.
Malformed pages report `RESPONSE_INVALID`; empty pages with a continuation are skipped.
A limit inside a page preserves its unreturned offset in an opaque cursor; resumption refetches that page, so mutable collections do not provide snapshot isolation.
Cursor format v2 binds profile identity, origin, API version, operation, query/path context, pending page, offset, remaining window and last known total, and preserves visited-page history across resumes.
Repeated continuations, including multi-page cycles across resumes, report `CONTINUATION_REPEATED` before following the repeated link.
Resumption requires the original query and path context and rejects incompatible cursors with `VALIDATION_ERROR`.

Each collection invocation defaults to 10 session requests including retries, 8 MiB of cumulative reserialized decoded page bodies, a 60-second deadline and 3 attempts per page.
The default requested `page_size` is 100 where the operation declares that query key; a caller-supplied value is retained, and other routes consume server-sized pages.
These are shared defaults with per-call policy overrides, not evidenced endpoint-specific ceilings.
Only HTTP 429, 502, 503 and 504 are retried, honoring valid Retry-After integer delay-seconds or HTTP-date values; past dates mean zero delay.
Absent or unusable headers use doubling backoff from 500ms capped at 10 seconds.
A delay beyond the remaining deadline reports `DEADLINE_EXCEEDED` with both delays; request and byte ceilings report `REQUEST_BUDGET_EXCEEDED` and `BYTE_BUDGET_EXCEEDED`.
Cancellation reports `REQUEST_CANCELLED`; cancellation and deadline expiry abort pending production requests, including OAuth exchanges, prevent later redirect/resource sends and release retry/deadline timers.
Runtime failures retain validated rows with `complete: false`, an error and a cursor at the pending page, including failures before any rows are returned.
Caller usage errors throw before HTTP; checkpoint and date-window operations are rejected rather than decoded as collections.
See the [CORE-02 handoff](docs/core-02-handoff.md) for the integration interface and the [implementation plan](docs/implementation-plan.md#session-and-investigation-slices) for acceptance and later slices.

`detection list --profile <name>` reads QUX v2.5 detections through the session and the bounded collection reader.
Filter flags map one-to-one to the recorded server-side query keys: `--state`, `--detection-type`, `--detection-category`, `--host-id`, `--tags`, `--certainty-gte`, `--threat-gte`, `--ordering`, `--min-id` and `--max-id`.
Filtering is server-side; numeric filter shapes are validated locally, while unsupported server-side values surface as read errors rather than silent client-side scans.
Values beginning with a dash use inline syntax, such as `--ordering=-id`.
List rows project the recorded field subset `id`, `detection_type`, `state`, `threat` and `certainty`; `--fields` selects a comma-separated subset and rejects unknown fields before any HTTP call.
`--limit` sets the row window (default 100); a capped window returns a cursor, and resuming with `--cursor` repeats the original filters because the cursor binds its query context.
Successful output carries the profile, a known-or-null total, a shown count, the rows, completeness and follow-up help, including a `detection show` suggestion for the first row.
An empty window succeeds with an explicit `0 detections found ...` message; a partial window keeps its validated rows with `complete: false`, an inline error and a cursor, and exits 1.
`detection show --profile <name> --id <id>` reads one detection's recorded detail fields.
Detection IDs must be positive integers; nullable fields retain null, omitted fields stay omitted, and malformed fields report `RESPONSE_INVALID`.
Long descriptions are previewed with their total length and a `--full` hint; `--full` prints the complete returned text but cannot restore content the response omits.
Both leaves validate flag values before loading configuration or selecting a profile, and reject unknown commands and combinations before credential or HTTP work.
Missing profiles fail before HTTP; API access denials report `ACCESS_DENIED` with exit 1, never an empty success.
Hosts, accounts and type-qualified entities stay READ-02; notes and tags stay READ-03; no business write leaf exists.

For OAuth, replace `auth` and `tokenEnv` with `"auth": "oauth"`, `"clientId": "synthetic-client"` and `"secretEnv": "VECTRA_LAB_SECRET"`.
Set the variable named by `secretEnv` outside the CLI.
Client IDs must be nonempty without whitespace or the Basic-auth colon delimiter.
QUX OAuth requires appliance release 9.1 or later.
The internal credential provider requests Basic client authentication on the named `POST /api/v2.5/oauth2/token` exchange with form `grant_type=client_credentials`.
It caches Bearer credentials in invocation memory until the returned numeric `expires_in`, measured conservatively from exchange start.
At expiry it reacquires using client credentials; it never uses a returned refresh token or assumes a fixed lifetime.
Successful responses require a nonempty access token containing only ASCII letters, digits, `-`, `.`, `_`, `~`, `+` or `/`, optionally followed by trailing `=` padding, a case-insensitive Bearer `token_type`, and finite numeric `expires_in` yielding a safe integer expiry in epoch milliseconds.
Unsuitable access tokens are rejected before caching; a failed reacquisition cannot return the expired credential.
Missing secrets report `AUTH_REQUIRED`, rejected client credentials report `AUTH_FAILED`, denied access reports `ACCESS_DENIED`, and certificate errors report `TLS_TRUST_ERROR`.
Already-expired returned credentials report `AUTH_EXPIRED`; malformed successful responses report `AUTH_RESPONSE_INVALID`; other status or transport failures report `AUTH_EXCHANGE_FAILED`.
An exchange failure triggers no automatic retry or business request.
Remote response bodies and raw transport errors are discarded from exchange errors.
The provider registers the client secret, encoded Basic credential and returned access/refresh token strings with the existing redactor, including rejected responses.
Malformed Unicode remains redacted in raw and JSON-escaped forms; an unused malformed refresh token does not prevent authentication.
The named OAuth exchange runs over the same session adapter and destination checks as resource requests and never follows redirects.
See [AUTH-02 handoff](docs/auth-02-handoff.md) for the credential seam, [CORE-01 handoff](docs/core-01-handoff.md) for the session interface, [CORE-02 handoff](docs/core-02-handoff.md) for bounded collections and [CORE-01 acceptance](docs/implementation-plan.md#core-01-handoff-and-acceptance) for fixture evidence.
