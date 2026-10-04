# READ-07 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-07 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped health behavior.
Prerequisite is READ-06 merged as `703615b` (PR https://github.com/knowttl/vectra-axi/pull/12); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions, the session query allowlist and supporting evidence.
The [health module](../src/health.ts) owns snapshot validation, freshness/variant flags, the 9.4 release gate, checkpoint decoding and output shaping for the three leaves.
Snapshots are paging:none single responses and use `session.request` directly, never the collection reader.
The event feed is paging:checkpoint and owns its own single-batch runner for the same reason: the CORE-02 collection reader serves count/results/next collections only.
The session exposes the profile's declared `applianceRelease` on its snapshot so release-gated leaves can refuse before HTTP; absent means undeclared and the read proceeds.
[cli.ts](../src/cli.ts) validates flags before profile selection, enforces the release gate after selection, and dispatches the leaves from one runner.
[catalogue.ts](../src/catalogue.ts) owns leaf grammar and command resolution; see [README.md](../README.md) for the shipped authorization policy.
RUX-06 maps the same leaves to the v3.4 health, check and event routes on a cloud profile: subscription-sensitive bodies pass through untouched, integer event checkpoints normalize to their decimal form, and a cursor binds its generation's operation so a QUX cursor never resumes a cloud read.

## Convention for later read slices

Follow the READ-01 leaf convention: one catalogue entry per leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Cover one packaged CLI journey per slice through the declared binary with synthetic profiles and the [test-only HTTPS transport](../test/detection-transport.ts); do not duplicate a full journey per endpoint.
See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for subsequent read slices.
