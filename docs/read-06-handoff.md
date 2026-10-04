# READ-06 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-06 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped audit behavior.
Prerequisite is READ-02 merged as `c9acc45` (PR https://github.com/knowttl/vectra-axi/pull/9); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions, the session query allowlist and supporting evidence.
See [README.md](../README.md) for the shared audit leaf's generation-specific behavior and [cli.ts](../src/cli.ts) for dispatch to the QUX and RUX runners.
[catalogue.ts](../src/catalogue.ts) owns leaf grammar and command resolution; see [README.md](../README.md) for the shipped authorization policy.

## Convention for later read slices

Follow the READ-01 leaf convention: one catalogue entry per leaf with kebab-case flags, generation-independent flag-shape validation before configuration/profile selection and generation-specific requirements before HTTP, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Cover one packaged CLI journey per slice through the declared binary with synthetic profiles and the [test-only HTTPS transport](../test/detection-transport.ts); do not duplicate a full journey per endpoint.
See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for subsequent read slices.
