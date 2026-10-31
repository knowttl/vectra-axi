# Contributing

Keep changes focused and describe the problem, resulting behavior and validation in the pull request.
Use Node.js 24 and pnpm 10.34.6 through Corepack for local development.

## Local validation

Run these checks before requesting review:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false
corepack pnpm run build
corepack pnpm run lint
corepack pnpm test
corepack pnpm run docs:check
```

The [test workflow](.github/workflows/ci.yml) defines push and pull-request checks for main on Linux and Windows.
Local validation is required before merge, and the release publish job repeats these checks before publishing.

Canonical source: knowttl/bstack revision feeccb1e6f1ae119bf4c74277c8bad328b05afe8, skills/verification/references/testing.md.
<!-- BEGIN canonical test-quality rules -->
**Test quality.** Write and review every test against these rules.
Tests are never required first; a change is verified end to end against the behaviour the user expects.

1. Trust upstream invariants: do not test states that types, schemas or database constraints already rule out.
   Test invalid input only at the boundary that validates it.
2. Assert outcomes from an agreed source (spec, domain rule, ground-truth fixture), never values copied from what the code returns today.
3. Mock only true external boundaries, with schema-valid or recorded payloads.
   Never mock in-process code.
   Delete tests that only check how a mock was set up or called, unless that call is the requirement.
4. Test through the public interface: no private helpers, internal state or internal call counts.
5. Every assertion must be able to fail when the behaviour breaks: no existence-, type- or constant-only assertions.

Exempt: validation-boundary tests, contract tests against an agreed schema or recording, and regression tests that cite the bug they reproduce.
<!-- END canonical test-quality rules -->

Tests use temporary HOME and XDG directories, synthetic credentials and fixtures, and deny external network access.
Do not use real services, credentials or customer data for automated validation.
Use `node scripts/isolated.ts node bin/vectra-axi.js --help` for an offline manual CLI check.

After changing the command catalogue or capability inventory, rebuild and run `corepack pnpm run docs:generate`, then repeat `docs:check`.
Do not edit generated command tables, coverage records, the command reference or the agent guide by hand. Edit `scripts/agent-guide.md` for guide changes, then regenerate.
Keep the README group overview aligned with the generated command reference.
See the [implementation plan](docs/implementation-plan.md) for the existing fixture conventions and acceptance contracts.

## Compatibility

The deprecated `tokenEnv`/`secretEnv` keys and unversioned configuration envelopes remain supported through `0.1.x` and retire in `0.2.0`.
Patch releases do not count as a new minor release.
Use the versioned profile envelope and `token`/`clientSecret` SecretRefs for new configurations.
