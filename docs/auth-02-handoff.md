# AUTH-02 handoff

See the [implementation plan](implementation-plan.md#auth-02-handoff-and-acceptance) for prerequisite, scope, deferred slices and offline acceptance.
See [README.md](../README.md) for shipped configuration and credential behavior, and [design.md](design.md#evidence-and-api-contracts) for upstream evidence.
The relevant capability record is `qux.oauth.exchange` in the [inventory](../inventory/capabilities.json), which owns its route, release prerequisite, effect and permission constraints.

The [credential provider](../src/oauth.ts) captures one selected profile and exposes an internal credential function.
Call its returned function only after CORE-01 validates the intended resource operation and destination.
Credentials are internal material, never a command result or a grant for arbitrary POST requests.
Its transport accepts only the named `qux.oauth.exchange` request with a fixed method, versioned URL, form body and verified TLS options.
The [session](core-01-handoff.md) implements that seam; [README.md](../README.md) owns shipped destination, redirect and transport bounds.
There is no second HTTP system, authenticated fetch API or live-network default in AUTH-02.

CORE-01 debug and output writers must use the credential provider's [invocation redactor](../src/redact.ts).
