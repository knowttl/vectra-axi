# READ-04 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-04 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped assignment/outcome/user behavior.
Prerequisite is READ-02 merged as `c9acc45` (PR https://github.com/knowttl/vectra-axi/pull/9); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions, session query allowlists and their supporting evidence.
The [assignments module](../src/assignments.ts) owns flag-to-query mapping, row decoding, status derivation, field projection and output shaping for all five leaves.
See [README.md](../README.md) for filter mappings, returned fields, assignment status semantics and resource-scoped IDs.
[cli.ts](../src/cli.ts) validates every new leaf's flags before profile selection, dispatches through a read-only runner that sets exit 1 for partial reads while keeping their rows, and reports the new leaves in its setup and capability state.
[catalogue.ts](../src/catalogue.ts) owns leaf grammar and command resolution; see [README.md](../README.md) for the shipped authorization policy.

## Convention for later read slices

Follow the READ-01 leaf convention: one catalogue entry per leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Use the catalogue's `parseInvocation` for command resolution and unknown-input errors.
See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for slice ownership and remaining read scope.
