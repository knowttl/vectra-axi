# READ-08 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-08 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped lockdown status behavior.
Prerequisite is READ-02 merged as `c9acc45` (PR https://github.com/knowttl/vectra-axi/pull/9); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions, the session query allowlist and supporting evidence.
The [lockdown module](../src/lockdown.ts) owns kind validation, row decoding and output shaping for the single leaf.
Lockdown reads are paging:none single responses and use `session.request` directly, never the collection reader: each kind has its own status route with no query parameters, so there is no page to resume and no cursor to bind.
[cli.ts](../src/cli.ts) validates `--type` before profile selection and dispatches the leaf from one runner.
[catalogue.ts](../src/catalogue.ts) owns leaf grammar and command resolution; see [README.md](../README.md) for the shipped authorization policy.
RUX-06 maps the same leaf to the single v3.4 lockdown endpoint with its type selector on a cloud profile, including the RUX-only traffic value; traffic on QUX fails with generation guidance before any HTTP.
Lockdown execution stays unpromised: no execution leaf is declared, and the session authorizes read GETs only.

## Convention for later read slices

Follow the READ-01 leaf convention: one catalogue entry per leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Cover one packaged CLI journey per slice through the declared binary with synthetic profiles and the [test-only HTTPS transport](../test/detection-transport.ts); do not duplicate a full journey per endpoint.
See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for subsequent read slices.
