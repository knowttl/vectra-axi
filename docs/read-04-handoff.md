# READ-04 handoff

See the [implementation plan](implementation-plan.md#phase-2-finish-the-on-prem-soc-read-release) for scope and the READ-04 acceptance row, and [design.md](design.md#cli-and-output-contract) for the output contract.
See [README.md](../README.md) for shipped assignment/outcome/user behavior.
Prerequisite is READ-02 merged as `c9acc45` (PR https://github.com/knowttl/vectra-axi/pull/9); branch from latest `origin/main`.

## What shipped

See the [capability records](../inventory/capabilities.json) for operation dispositions: `qux.assignment.list`, `qux.assignment-outcome.list`, `qux.assignment-outcome.show`, `qux.user.list` and `qux.user.show` are named; everything else keeps its prior disposition.
The three READ-04 collection records additionally allowlist `page` and `page_size` for server-returned continuation links, evidenced by VAT `yield_results` following server `next` links and the `page`/`page_size` keys in VAT `_generate_assignment_params`; no CLI flag sets them.
The [assignments module](../src/assignments.ts) owns flag-to-query mapping, row decoding, status derivation, field projection and output shaping for all five leaves.
`assignment list` maps singular CLI flags to the plural wire keys (`--account` to `accounts`, `--host` to `hosts`, `--assignee` to `assignees`, plus `resolution`, strict `--resolved true|false` and `--created-after`).
Rows decode the recorded `id`, `host_id`, `account_id` and `date_resolved` subset and gain a CLI-derived `status` (`unresolved` for null `date_resolved`, `resolved` otherwise), which `--fields` can project alongside the wire fields.
Outcomes and users decode and project their recorded subsets; `user list` passes `--username` through to the server.
`assignment outcome show` and `user show` decode one detail body each; IDs stay scoped to their resource.
[cli.ts](../src/cli.ts) validates every new leaf's flags before profile selection, dispatches through a read-only runner that sets exit 1 for partial reads while keeping their rows, and reports the new leaves in its setup and capability state.
[catalogue.ts](../src/catalogue.ts) resolves three-word leaves (`assignment outcome list`, `assignment outcome show`) by longest match; one- and two-word resolution is unchanged.
No resolve, reassign or outcome-mutation leaf exists; the session still refuses non-read operations.

## Convention for later read slices

Follow the READ-01 leaf convention: one catalogue entry per leaf with kebab-case flags, flag validation before configuration/profile selection, `{ output, failed }` runners dispatched from CLI glue, and domain coverage through the real session with a fake `RawTransport` and synthetic `.invalid` fixtures under the [external-network guard](../test/network-guard.ts).
Three-word leaves resolve from the first three argv tokens in `parseInvocation`; unknown third words report `Unknown command: <group> <word> <word>`.
Assignments, outcomes and users stay READ-04; notes/tags stay READ-03; groups, rules, audit, health and lockdown stay READ-05..08.
