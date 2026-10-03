# vectra-axi
Agent-ergonomic CLI for Vectra AI, read-only by default

The INV-01 capability inventory and CLI-01 local command shell are implemented.
No Vectra API operations or profile configuration are implemented yet.
The selected direction is TypeScript, on-prem QUX reads first, and a later RUX adapter for cloud migration.

- [Design and source evidence](docs/design.md)
- [Implementation slices and offline acceptance](docs/implementation-plan.md)
- [Inventory format, dispositions and verification](docs/inventory.md)

Development requires Node 22.12 or later and pnpm 10.34.6 through Corepack.
Run `corepack pnpm install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false`, then `corepack pnpm run build`, `corepack pnpm test` and `corepack pnpm run lint`.
Tests deny external network and require no Vectra credentials.

Run `node bin/vectra-axi.js` after building for the unconfigured home view.
`home` and `setup` are local, read-only status views; `setup` installs nothing.
Run `node bin/vectra-axi.js --help` or `node bin/vectra-axi.js setup --help` for catalogue-generated help and examples.
Bare `-v`, `-V` and `--version` print only the package version without loading the command graph.
Every local leaf accepts `--help` or `--profile <name>` (also `--profile=<name>`); these flags are mutually exclusive.
Profile selection reports `PROFILE_REQUIRED` until AUTH-01 implements configuration.
Unknown commands, flags, positional arguments, repeated flags and version combinations fail before profile or network work.
API commands remain planned, and the SDK's implicit `update` command is refused.

Structured data, help and errors use TOON on stdout; stderr is reserved for diagnostics.
Exit codes are 0 for success, 1 for runtime failure (including a missing profile), and 2 for usage failure.
There are no prompts, HTTP calls or ordinary-command installation side effects.
`corepack pnpm pack --out vectra-axi.tgz` packages the built entrypoint, runtime modules and validated inventory.
The CLI suite unpacks this artifact and invokes its declared binary with closed stdin, a synthetic home and the shared external-network guard.
