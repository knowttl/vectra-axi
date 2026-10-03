# CLI-01 handoff

Prerequisite: INV-01 at `ab4c042` on `origin/main`.
The slice consumes the complete inventory through its existing schema without changing any inventory row or disposition.
All 72 planned API operations and two blocked credential exports remain unavailable at runtime.
No authentication, profile loading, session, endpoint adapter or HTTP dispatch is introduced.

The executable catalogue owns `home`, `setup`, their help, accepted flags and the implemented-capability list.
No arguments show local unconfigured state with executable identity and discovery suggestions.
`setup` is a read-only availability view, with profile configuration explicitly deferred to AUTH-01 and integration deferred to PACK-01.
The shared flags are `--help` and `--profile <name>` or `--profile=<name>`; they cannot be combined.
Both leaves take no positional arguments, reject duplicate flags and reject unknown input before profile handling.
Only bare `-v`, `-V` and `--version` are accepted as version probes.
The SDK's automatic update command is disabled.

The shell pins `axi-sdk-js` 0.1.13 and follows current az-axi `origin/main` at `a7c1ca4bb605f3835d1717dde553f349a81b646f` for catalogue-first validation, SDK output and refusal of implicit update.
The SDK fast-path subpath and builtin-only version leaf bypass the command graph.
Exit semantics follow this repository's design: success is 0, runtime failure is 1, and usage failure is 2.
Data, help and errors use TOON on stdout, with diagnostics reserved for stderr.

Acceptance is exercised through `test/cli.test.ts`, which packs and unpacks the real package, resolves its declared binary and invokes it with closed stdin and an empty synthetic home.
It reuses the inventory test network guard through a subprocess preload; no Vectra instances or credentials are used.
The packaged runtime uses installed local dependencies without fetching packages.

| Invocation | stdout | stderr | Exit |
|---|---|---|---|
| `--version`, `-v`, `-V` | Bare package version | Empty | 0 |
| No arguments | TOON unconfigured state and discovery | Empty | 0 |
| `--help`, `home --help`, `setup --help` | Catalogue-generated TOON help | Empty | 0 |
| `home --profile lab` | TOON `PROFILE_REQUIRED` and `vectra-axi setup` guidance | Empty | 1 |
| `home --profil lab` | TOON `VALIDATION_ERROR`, valid flags and help guidance | Empty | 2 |
| `home --profile lab --help` | TOON combination error and help guidance | Empty | 2 |
| Planned API command or `update` | TOON unknown-command error | Empty | 2 |

The suite also checks version with the command graph absent and compares its latency with a Node startup floor measured in the same test process.
Build, test and lint remain the existing INV-01 toolchain and CI contracts.
