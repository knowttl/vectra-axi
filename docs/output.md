# Output and pagination

## Home context

No arguments and `home` select the same profile as explicit reads.
See [Profiles and SecretRefs](configuration.md#profiles-and-secretrefs) for supported deployment and authentication combinations.
Unsupported deployment, version or authentication combinations fail configuration validation before any service call.
Home reads only `state=active` detections, retaining the native threat/certainty scores on both deployments.
Entities, health and other detection states are not queried or represented as empty.
The explicit `setup` command remains offline, and only `setup hooks` installs session integration.

Home fetches at most one collection page with `page_size=5`, a five-row output limit, no retries and a ten-second deadline, using the session's existing response byte limit.
The deadline also covers OAuth authentication; the named token exchange is the only possible POST and grants no response-operation permission.
Detection type and state previews stop at 80 characters; add `--full` to the scoped `detection show` hint for complete returned text.
`total` is the server count or null when unknown, never a local estimate or an entity total.
`shown` counts validated rows in this window, including when a later row is malformed.

| Live status | Meaning | Exit |
| --- | --- | --- |
| `complete` | Returned active detection collection exhausted successfully | 0 |
| `empty` | Successful exhausted read explicitly returned no active detections | 0 |
| `windowed` | Five-row limit reached with more data available | 0 |
| `denied` | API role, permission or licence denial; total unknown | 1 |
| `authentication_failed` | Missing or rejected credential; no successful detection read | 1 |
| `incomplete` | Malformed response, inconsistent count, or budget failure; validated rows retained | 1 |
| `unavailable` | Detection request or OAuth exchange service failure; no empty-success claim | 1 |

Failure output retains the error code and diagnostic guidance.
The next read keeps the selected config, profile and active filter; environment-only profiles retain their environment selection.
Run the suggested `detection list --limit 20` to obtain a larger window and a continuation cursor, then resume that cursor with the same config, profile and filters.
Home deliberately omits opaque cursors and the exhaustive command inventory to keep session context small.
Run `vectra-axi --help` for complete capability discovery.

## TOON output behavior

`complete: true` means the matching result is exhausted without error and no cursor remains.
For checkpoint feeds, this covers the current batch, not future events available through the returned checkpoint.
A bounded window with a cursor reports `complete: false` and exits 0; a failed read reports `complete: false` and exits 1.
On cursor resume, completeness describes exhaustion from that position, not whether earlier rows were included again.

- Structured results, help, errors and bounded response-invalid diagnostics go to stdout.
- `RESPONSE_INVALID` and `MALFORMED_RESPONSE` diagnostics for resource responses include `status`, `contentType`, `shape` and `shapeTruncated` without values or validator messages.
  Missing or invalid status and content type are reported as null.
  Arrays sample one element, unsafe keys become placeholders, and registered secrets are redacted.
  Shapes stop at four levels, 64 entries, 256 characters per path or 4,096 total path characters; `shapeTruncated` indicates omitted structure.
  Invalid JSON reports an undefined root shape because no parsed body is available.
  Doctor keeps response-invalid diagnostics on each failed profile under `diagnostics`.
  Bulk tag results keep response-invalid diagnostics on each refused target under `diagnostics`.
  RUX threat-feed list failures retain their error code and response diagnostics alongside any validated rows.
  Accepted mutations with invalid JSON retain success and emit `warnings` with the operation, target, audit ID and response diagnostics; read back the target without replaying the write.
  The parse failure alone does not change exit 0 to failure; other failures in the same invocation can still produce exit 1.
- Collection lists use compact fields, counts, and a default 100-row window.
  Supported `--fields` values depend on the command and deployment.
  Detection `--fields triage_category` preserves the API value, including null, and omits the field when the API does not supply it.
- Resume collections with `--cursor` and the original filters and target context.
  A successful bounded window can still have more rows; cursors do not provide snapshot isolation.
- Detection, host, account, type-qualified entity, assignment, assignment outcome, user, group, group member and triage rule lists support `--all` on QUX and RUX.
  It traverses pages within 10 requests (including retries), 8 MiB of decoded page bodies, 60 seconds and 10,000 output rows per invocation.
  `--all` cannot be combined with `--limit`.
  Exhausted budgets retain validated rows, report `complete: false` with an error and continuation cursor, and exit 1.
  Resume with `--all --cursor <cursor>` and the original profile, filters and entity type to start fresh budgets at the next unread position.
- Event feeds return checkpoints and may return a cursor inside a batch.
  Drain that cursor with the original filters and without `--from` before continuing with `--from <checkpoint>`.
  `remaining_count` is not a stable total; changed batches are refused during cursor replay.
- Notes, tags, health summaries and lockdown status are nonpaged single responses and do not accept `--all`.
  Checkpoint event feeds and date-window audits also do not accept `--all`.
  Every list's help and the generated [skill command table](../skills/vectra-axi/SKILL.md) state its pagination contract for each supported deployment.
- QUX audits require both inclusive UTC dates and have no cursor; use smaller date windows if the response exceeds the byte budget.
- Failed reads retain validated rows, report `complete: false`, and exit 1.
  Access or licence denial is an error, never an empty success.
- Exit codes are 0 for success, 1 for runtime failure, and 2 for usage failure.

`api get` accepts inventory operation IDs, recorded path/query keys, and recorded field projections only.
It does not accept arbitrary URLs, headers, methods, or credential-export operations.
Quote `--path` and `--query` pairs joined with `&`, and percent-encode reserved characters inside values.
Checkpoint and date-window operations use their named commands instead.

