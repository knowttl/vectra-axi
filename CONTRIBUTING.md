# Contributing

Keep changes focused and describe the problem, resulting behavior and validation in the pull request.
Use Node.js 22.12 or later and pnpm 10.34.6 through Corepack.

## Local validation

Run these checks before requesting review:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false
corepack pnpm run build
corepack pnpm run lint
corepack pnpm test
corepack pnpm run docs:check
```

Tests run locally through no-mistakes; the test workflow file remains in the repository but is disabled on GitHub, so Actions runs only the release pipeline.
Local validation is required before merge, and the release publish job repeats these checks before publishing.
Tests use temporary HOME and XDG directories, synthetic credentials and fixtures, and deny external network access.
Do not use real services, credentials or customer data for automated validation.
Use `node scripts/isolated.mjs node bin/vectra-axi.js --help` for an offline manual CLI check.

After changing the command catalogue or capability inventory, rebuild and run `corepack pnpm run docs:generate`, then repeat `docs:check`.
Do not edit generated command tables, coverage records, the command reference or the README command summary by hand.
See [development guidance](README.md#development--testing) and the [implementation plan](docs/implementation-plan.md) for the existing fixture conventions and acceptance contracts.

## Compatibility

The deprecated `tokenEnv`/`secretEnv` keys and unversioned configuration envelopes remain supported through `0.1.x` and retire in `0.2.0`.
Patch releases do not count as a new minor release.
Use the versioned profile envelope and `token`/`clientSecret` SecretRefs for new configurations.
