# AUTH-01 handoff

See the [implementation plan](implementation-plan.md#auth-01-handoff-and-acceptance) for prerequisite, scope, deferred slices and offline acceptance.
See [README.md](../README.md) for shipped configuration, behavior and development commands, and [design.md](design.md#evidence-and-api-contracts) for upstream evidence.
Write policy configuration and enforcement remain deferred to [WRITE-00](implementation-plan.md#phase-4-add-writes-as-a-new-capability-one-family-at-a-time).

CORE-01 must apply the [authentication primitives](../src/auth.ts) only after destination and operation checks, and supply observed status, expiry and TLS failures.
The [profile loader](../src/profiles.ts) registers referenced environment values from every profile in the [invocation redactor](../src/redact.ts) before configuration validation.
Its error boundary discards raw causes/stacks and sanitizes metadata before SDK formatting; final stdout is scrubbed again, including escaped secret values.
Future stderr/debug/audit writers must use the same redactor before emission.
No current command emits debug diagnostics or audit metadata.
