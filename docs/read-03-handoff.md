# READ-03 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-03 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped note/tag behavior.
Prerequisite is READ-02 merged as `c9acc45` (PR https://github.com/knowttl/vectra-axi/pull/9); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions: `qux.detection.note.list`, `qux.detection.tag.list`, `qux.host.note.list`, `qux.host.tag.list`, `qux.account.note.list` and `qux.account.tag.list` are named; everything else keeps its prior disposition.
Note/tag mutations stay deferred `planned` families; the catalogue owns no note/tag write leaf and the session authorizes read GETs only, so no write request is constructible.
The [notes module](../src/notes.ts) owns owner-ID validation, note/tag decoding, text previewing and output shaping for all six leaves.
`<kind> note list` reads the dedicated versioned notes resource, which returns a bare list of `{id, note}` entries; `<kind> tag list` reads the versioned tagging route, which returns a `{tags: [...]}` body.
Both are paging:none single responses and use `session.request` directly, never the collection reader.
Long note text previews at 1200 characters with a `--full` hint naming the same leaf; `--full` prints the complete returned text and never implies recovery of unreturned content.
Detail bodies may carry an embedded note summary: show leaves surface it as `note_summary` with a pointer to the matching note list leaf, and show `--full` covers descriptions only.
[cli.ts](../src/cli.ts) validates `--id` before profile selection and dispatches the six leaves from one runner.
`parseInvocation` in [catalogue.ts](../src/catalogue.ts) resolves three-word leaves from the first three argv tokens, then falls back to two-word and single-word resolution.

## Convention for later read slices

Three-word leaves follow the READ-01 leaf convention: one catalogue entry per `group subgroup verb` leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Unknown second words still report `Unknown command: <group> <word>`; unknown third words report the full triple.
Cover one packaged CLI journey per slice through the declared binary with synthetic profiles and the [test-only HTTPS transport](../test/detection-transport.ts); do not duplicate a full journey per endpoint.
Assignments, users, groups, rules, audit, health and lockdown stay READ-04..08.
