# AUTH-02 handoff

See the [implementation plan](implementation-plan.md#auth-02-handoff-and-acceptance) for prerequisite, scope, deferred slices and offline acceptance.
See [README.md](../README.md) for shipped configuration and credential behavior, and [design.md](design.md#evidence-and-api-contracts) for upstream evidence.
The [inventory](../inventory/capabilities.json) owns each generation's exchange route, release prerequisite, effect and permission constraints.

The [credential provider](../src/oauth.ts) captures one selected profile and exposes an internal credential function.
Resource requests call its returned function only after the session validates the intended operation and destination.
See [README release guidance](../README.md#release) for the separate doctor check.
Credentials are internal material, never a command result or a grant for arbitrary POST requests.
See [README.md](../README.md) for the supported generations' named exchanges and credential lifecycle; [TokenTransport](../src/oauth.ts) owns the exact request type.
The [session](core-01-handoff.md) implements that seam; [README.md](../README.md) owns shipped destination, redirect and transport bounds.
There is no second HTTP system, authenticated fetch API or live-network default in AUTH-02.

CORE-01 debug and output writers must use the credential provider's [invocation redactor](../src/redact.ts).
