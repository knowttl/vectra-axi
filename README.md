# vectra-axi
Agent-ergonomic CLI for Vectra AI, read-only by default

The INV-01 capability inventory and development tooling are implemented; no CLI commands are implemented yet.
The selected direction is TypeScript, on-prem QUX reads first, and a later RUX adapter for cloud migration.

- [Design and source evidence](docs/design.md)
- [Implementation slices and offline acceptance](docs/implementation-plan.md)
- [Inventory format, dispositions and verification](docs/inventory.md)

Development requires Node 22.12 or later and pnpm 10.34.6 through Corepack.
Run `corepack pnpm install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false`, then `corepack pnpm run build`, `corepack pnpm test` and `corepack pnpm run lint`.
Tests deny external network and require no Vectra credentials.
