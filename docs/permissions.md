# Permissions

Read-only is the default even when the upstream credential has write permissions.
The CLI does not grant API permissions; configure the deployment's API role for the resources you need.

| Access | Required upstream permission |
| --- | --- |
| QUX token reads | Personal API token with read access to the requested resource |
| QUX OAuth reads | API client credentials on appliance 9.1+ with the requested resource access |
| RUX reads | OAuth API client with read access to the requested resource; subscriptions may further restrict routes |
| Named writes | Mutation permission for the requested operation, plus its local [write scope](writes.md#write-scopes) |

Permission names vary by deployment; the CLI does not prescribe a universal OAuth scope string.
Resource requests and OAuth exchanges send credentials and requested operation data only to the configured HTTPS origin.
Read results leave the CLI through stdout for your terminal or agent to consume.
Credentials are referenced from environment variables or protected files, never stored by the CLI or printed as values.
There is no login command or persistent credential cache.

