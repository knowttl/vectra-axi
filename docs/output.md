# Output and pagination

## TOON output behavior

- Structured results, help, and errors go to stdout; diagnostics go to stderr.
- Collection lists use compact fields, counts, and a default 100-row window.
  Supported `--fields` values depend on the command and deployment.
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
- Partial reads retain validated rows, report `complete: false`, and exit 1.
  Access or licence denial is an error, never an empty success.
- Exit codes are 0 for success, 1 for runtime failure, and 2 for usage failure.

`api get` accepts inventory operation IDs, recorded path/query keys, and recorded field projections only.
It does not accept arbitrary URLs, headers, methods, or credential-export operations.
Quote `--path` and `--query` pairs joined with `&`, and percent-encode reserved characters inside values.
Checkpoint and date-window operations use their named commands instead.

