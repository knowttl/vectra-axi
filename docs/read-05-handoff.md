# READ-05 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-05 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped group/member/triage-rule behavior.
Prerequisite is READ-02 merged as `c9acc45` (PR https://github.com/knowttl/vectra-axi/pull/9); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions and deferred mutation families, and [README.md](../README.md) for shipped group/member/rule shapes, release prerequisites and write restrictions.
The [groups module](../src/groups.ts) owns flag-to-query mapping, row decoding, kind-preserving projection and output shaping for all five leaves.
[cli.ts](../src/cli.ts) validates every new leaf's flags before profile selection, dispatches through a read-only runner that sets exit 1 for partial reads while keeping their rows, and reports the new leaves in its setup and capability state.
See `parseInvocation` in [catalogue.ts](../src/catalogue.ts) for leaf resolution and unknown-command reporting.

## Convention for later read slices

Follow the READ-01 leaf convention: one catalogue entry per leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Three-word leaves (`group member list`, `triage rule list`, `triage rule show`) resolve from the first three tokens when the triple names a catalogue entry.
Leaf field tables in [cli.ts](../src/cli.ts) must stay at module scope: the shell handler runs inside `runAxiCli` before later declarations in `main` initialize, so a table declared there reads as uninitialized.
Cover one packaged CLI journey per slice through the declared binary with synthetic profiles and the [test-only HTTPS transport](../test/detection-transport.ts); do not duplicate a full journey per endpoint.
See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for subsequent read slices.
