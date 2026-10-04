# AUTH-01 handoff

Prerequisite: CLI-01 on origin/main at `184a57a`, including INV-01 schema and the shared network-denying fixture harness.
The branch is `fm/vx-auth-01`, based on that commit.
No inventory rows or dispositions change, and no API operation becomes executable.

## Contract

`home` and `setup` accept `--config <path>` as well as the existing `--profile <name>` and `--help` flags.
`--help` remains mutually exclusive with `--profile`; it works without reading even an explicitly selected invalid config.
The user config path is `~/.vectra-axi/config.json`; explicit selection uses `--config` before `VECTRA_AXI_CONFIG`.
There is no automatic repository-local discovery.
The JSON shape is `{ defaultProfile?, profiles: { name: { kind, origin, apiVersion, applianceRelease?, auth, tokenEnv, caBundle? } } }`.
Every profile is validated at load, including profiles that are not selected.
AUTH-01 supports only `kind: qux`, `apiVersion: "2.5"`, `auth: token` and an environment variable name in `tokenEnv`.
An origin is an exact normalized HTTPS origin, with no trailing slash, credentials, path, query or fragment.
Unknown fields fail closed, including mixed OAuth/token fields, inline credentials, UI-login settings, TLS bypass and future write settings.
OAuth client credentials remain AUTH-02, the session/HTTP adapter remains CORE-01, RUX remains RUX-01, and write policy remains WRITE-00.

Profile precedence is explicit flag, environment, config default, then the sole profile.
Local output contains the selected profile name/source, kind, origin, version, optional appliance release, configured trust mode and disabled writes.
It makes no connectivity, credential-validity or appliance compatibility claim.
`setup` is read-only and shows synthetic configuration guidance without installing anything.
Missing, unknown and ambiguous profiles return distinct actionable runtime errors.

`resolveToken` resolves only the selected environment reference and returns the internal `Token …` header value.
It rejects unset, empty or whitespace-containing credentials, including header injection.
There is no persistent credential cache and no assumed personal-token expiry.
`tlsOptions` returns mandatory verification, loading optional private CA material beside the config and retaining system roots.
It does not connect or expose an authenticated transport.
`authFailure` translates explicit expiry evidence, HTTP 401, HTTP 403 and known Node certificate verification errors into distinct actionable codes.
CORE-01 must supply the observed failures and apply these primitives only after destination/operation checks.

The invocation owns one `SecretRedactor`, registering referenced environment values from every profile before validation.
The error boundary discards raw causes/stacks and sanitizes message, code, suggestions and optional details before SDK formatting.
Final stdout is scrubbed again, including serialized/escaped secret values.
The same redactor's text/value methods support future diagnostics and ordinary results; future stderr/debug/audit writers must use them before emission.
No current command emits debug diagnostics or audit metadata.

## Evidence and acceptance

The merged design and the [official QUX token guide](https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-token-auth) establish personal token authentication.
A differently shaped check in [pinned VAT vectra.py](https://github.com/vectranetworks/vectra_api_tools/blob/c76fd0c5d42e74b199e47dc42923582c2b1dbee7/modules/vectra.py#L235) confirms the `Token` scheme.
The [official QUX OAuth guide](https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-oauth2) confirms QUX v2.x versus RUX v3.x and continued personal-token support.
[az-axi origin/main at d02a9739](https://github.com/knowttl/az-axi/tree/d02a9739a50f35a2a69c340e4f8cbe724856fbdf) supplies profile naming/precedence and SDK output/error-boundary conventions.
Its automatic local config discovery and implicit UI auth are deliberately not used because the merged Vectra profile contract rejects them.

`test/auth.test.ts` exercises profile precedence and rejection, token resolution, mandatory TLS/private CA options, failure codes and sentinel redaction through the SDK's real formatting interface.
TLS material is synthetic text; these tests verify option construction, not a real TLS handshake or appliance compatibility.
`test/cli.test.ts` packs the binary and checks configured state, ambiguous-profile guidance, output redaction, ignored local config and offline help with closed stdin and synthetic home.
The existing network guard denies external connections in both test processes and packaged subprocesses.
No live Vectra instance, real credentials or tenant/customer data is used.
