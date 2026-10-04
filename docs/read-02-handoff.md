# READ-02 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-02 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped host/account/entity behavior.
Prerequisite is READ-01 merged as `c8db788` (PR https://github.com/knowttl/vectra-axi/pull/8); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions.
The [entity module](../src/entities.ts) owns flag-to-query mapping, row decoding, field projection and output shaping for all six leaves.
See [README.md](../README.md) for generation-specific host/account/entity routing, CLI filter restrictions and continuation behavior; the [capability records](../inventory/capabilities.json) own session query allowlists.
`runHostShow`, `runAccountShow` and `runEntityShow` decode one detail body and retain its resource kind in the output.
[cli.ts](../src/cli.ts) validates `--type` and flag values before profile selection, builds the session on the injected transport, and sets exit 1 for partial reads while keeping their rows.
`main(argv, transport)` accepts a `RawTransport` so tests drive the full leaf path through the real session; production passes `nodeTransport()` by default.

## Convention for later read slices

Follow the READ-01 leaf convention: one catalogue entry per leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
The [catalogue](../src/catalogue.ts)'s `parseInvocation` owns command resolution and unknown-input errors.
The entity facade is the pattern for kind-qualified reads: require the selector up front, delegate to one existing operation, and never merge independently paged kinds into one ranking.
Cover one packaged CLI journey per slice through the declared binary with synthetic profiles and the [test-only HTTPS transport](../test/detection-transport.ts); do not duplicate a full journey per endpoint.
See [README.md](../README.md) for shipped read families and the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for remaining slice scope.
