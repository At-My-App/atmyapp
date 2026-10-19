---
"@atmyapp/cli": minor
---

Confirming a migration plan approves its content warnings; the CLI sends that approval with the apply request. Each migration is recorded in `.ama/migrations/<operationId>.json` with its target, branch, compiled schema, operations and clears (never the token). `migrate-status` and `--reconcile` use exactly what was applied and refuse a session that points at another project or branch. With `--json`, stdout holds exactly one JSON document, also on failure, and logs go to stderr.
