# READ-01 handoff

See the [implementation plan](implementation-plan.md#session-and-investigation-slices) for scope and the READ-01 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped detection behavior.
Prerequisite is CORE-02 merged as `2b4af30` (PR https://github.com/knowttl/vectra-axi/pull/7); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions.
The [detection module](../src/detections.ts) owns flag-to-query mapping, row decoding, field projection, truncation and output shaping.
`runDetectionList(session, flags)` returns `{ output, failed }`: shaped AXI output plus whether the caller must exit nonzero.
`runDetectionShow(session, flags)` returns the same shape for one detail read.
[cli.ts](../src/cli.ts) selects the profile, builds the session on the injected transport, and sets exit 1 for partial reads while keeping their rows.
`main(argv, transport)` accepts a `RawTransport` so tests drive the full leaf path through the real session; production passes `nodeTransport()` by default.

## Convention for later read slices

Add one catalogue entry per `group verb` leaf with kebab-case flags, following the `detection list` entry in the [catalogue](../src/catalogue.ts).
See `parseInvocation` in [catalogue.ts](../src/catalogue.ts) for leaf resolution and unknown-command reporting.
Map each new flag to its inventory query key in the domain module and pass values through; validate shapes (integers, numbers, required selectors) before any session call.
Project rows to the inventory's field subset and reject unknown `--fields` values before HTTP.
Return `{ output, failed }` from the runner and dispatch it from `runDetection`-style CLI glue; never expose the transport or credentials to output shaping.
Follow [README.md](../README.md) for shipped partial, empty, denied, cursor and truncation behavior and the [collection interface](core-02-handoff.md) for row decoding before commit.
Cover the leaf in the domain test file through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
See the [implementation plan](implementation-plan.md#session-and-investigation-slices) for the required packaged investigation journey and deferred family scope.
