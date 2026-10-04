# AUTH-01 handoff

See the [implementation plan](implementation-plan.md#auth-01-handoff-and-acceptance) for prerequisite, scope, deferred slices and offline acceptance.
See [README.md](../README.md) for shipped configuration, behavior and development commands, and [design.md](design.md#evidence-and-api-contracts) for upstream evidence.
See [README.md](../README.md) for write policy configuration and [design.md](design.md#later-mutation-coordinator) for coordinator enforcement.

The [session](core-01-handoff.md) integrates the [authentication primitives](../src/auth.ts); see [README.md](../README.md) for shipped destination enforcement and failure behavior.
The [profile loader](../src/profiles.ts) registers referenced environment values from every profile in the [invocation redactor](../src/redact.ts) before configuration validation.
Its error boundary discards raw causes/stacks and sanitizes metadata before SDK formatting; final stdout is scrubbed again, including escaped secret values.
Future stderr/debug/audit writers must use the same redactor before emission.
No current command emits debug diagnostics or audit metadata.
