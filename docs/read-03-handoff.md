# READ-03 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-03 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped note/tag behavior.
Prerequisite is READ-02 merged as `c9acc45` (PR https://github.com/knowttl/vectra-axi/pull/9); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions and deferred mutation families, and [README.md](../README.md) for shipped note/tag shapes, text limits, embedded summaries and write restrictions.
The [notes module](../src/notes.ts) owns owner-ID validation, note/tag decoding, text previewing and output shaping for all six leaves.
Note and tag reads are paging:none single responses and use `session.request` directly, never the collection reader.
[cli.ts](../src/cli.ts) validates `--id` before profile selection and dispatches the six leaves from one runner.
See `parseInvocation` in [catalogue.ts](../src/catalogue.ts) for leaf resolution and unknown-command reporting.

## Convention for later read slices

Three-word leaves follow the READ-01 leaf convention: one catalogue entry per `group subgroup verb` leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Cover one packaged CLI journey per slice through the declared binary with synthetic profiles and the [test-only HTTPS transport](../test/detection-transport.ts); do not duplicate a full journey per endpoint.
See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for subsequent read slices.
