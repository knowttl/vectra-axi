# READ-06 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-06 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped audit behavior.
Prerequisite is READ-02 merged as `c9acc45` (PR https://github.com/knowttl/vectra-axi/pull/9); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions, the session query allowlist and supporting evidence.
The [audits module](../src/audits.ts) owns window validation, row decoding, byte-ceiling enforcement and output shaping for the single leaf.
Audit reads are paging:date-window single responses and use `session.request` directly, never the collection reader.
[cli.ts](../src/cli.ts) validates the window before profile selection and dispatches the leaf from one runner.
[catalogue.ts](../src/catalogue.ts) owns leaf grammar and command resolution; see [README.md](../README.md) for the shipped authorization policy.

## Convention for later read slices

Follow the READ-01 leaf convention: one catalogue entry per leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Cover one packaged CLI journey per slice through the declared binary with synthetic profiles and the [test-only HTTPS transport](../test/detection-transport.ts); do not duplicate a full journey per endpoint.
See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for subsequent read slices.
