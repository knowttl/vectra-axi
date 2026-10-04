# AUTH-02 handoff

AUTH-02 on `fm/vx-auth-02` uses merged AUTH-01 commit `f93e287` as its prerequisite.
The relevant inventory record is `qux.oauth.exchange`: QUX v2.5, appliance 9.1 or later, Basic client credentials, `POST /api/v2.5/oauth2/token`, form `grant_type=client_credentials`, effect `auth-exchange`.
An API client's role, permissions and licences still constrain resource access.
No inventory disposition or command grammar changes: the exchange lifecycle is internal and has no HTTP implementation yet.
RUX, the deep session/HTTP adapter, reads, retries and write policy remain their separately commissioned slices.

The [profile loader](../src/profiles.ts) accepts distinct strict token and OAuth variants, preserving AUTH-01 selection and redaction contracts.
OAuth requires `clientId` and `secretEnv`; token fields cannot coexist with them.
The [credential provider](../src/oauth.ts) captures one selected profile and owns a cache for that invocation.
Call its returned function only after CORE-01 validates the intended resource operation and destination.
Credentials are internal material, never a command result or a grant for arbitrary POST requests.
Its transport accepts only the named `qux.oauth.exchange` request with a fixed method, versioned URL, form body and verified TLS options.
CORE-01 must implement that seam with destination/redirect checks, bounded response decoding and an HTTP deadline; it must never follow credential-bearing redirects to arbitrary origins.
There is no second HTTP system, authenticated fetch API or live-network default in AUTH-02.

Successful responses require a nonempty whitespace-free access token, Bearer token type and finite numeric `expires_in` yielding a safe expiry in epoch milliseconds.
Expiry starts before the exchange so latency cannot extend token validity.
Expired tokens are discarded before reacquisition, and a failed reacquisition cannot return the old credential.
Every exchange makes one transport call with no internal retry, sleeps or refresh-token use.
Distinct actionable errors cover required credentials, rejected clients, denied access, TLS trust, expired returned credentials, malformed responses and other exchange failures.
Remote response bodies and raw transport errors are discarded from errors.
Client secrets, encoded Basic credentials and returned access/refresh tokens join the AUTH-01 redactor, including tokens in rejected responses.
CORE-01 debug and output writers must use this same invocation redactor.

The [official QUX guide](https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-oauth2) was rechecked on 2026-10-03 and confirms Bearer use and reacquisition without refresh-token support.
The differently shaped [pinned VAT implementation](https://github.com/vectranetworks/vectra_api_tools/blob/c76fd0c5d42e74b199e47dc42923582c2b1dbee7/modules/vectra.py) confirms the versioned QUX route, Basic client authentication, form grant and returned expiry in `_get_token` and `_check_token`.
Its retry, redirect and disabled-verification behavior are not adopted.
`knowttl/az-axi` on `main` was read through gh-axi for profile precedence, credential expiry/cache and SDK error conventions; no UI-auth reuse or global credential cache is adopted.

The [OAuth acceptance suite](../test/oauth.test.ts) covers the exact named exchange, expiry boundaries with fake time, cache isolation, reacquisition, malformed replies, bounded status/transport failures, CA failure and credential sentinel redaction through SDK formatting.
The [packaged suite](../test/cli.test.ts) confirms configured OAuth status with closed stdin and no secret or exchange.
Existing token, profile and TLS acceptance remains unchanged.
All suites use synthetic `.invalid` origins and the shared external-network guard; no live Vectra instance or real credentials are used.
Fixture acceptance verifies constructed TLS options, not a TLS handshake or unknown appliance compatibility.
