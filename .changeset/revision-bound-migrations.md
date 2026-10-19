---
"@atmyapp/structure": minor
"@atmyapp/cli": minor
---

Plan schema migrations against the target environment's content and apply exactly the reviewed plan. The CLI plans, confirms (`--yes` for CI), and applies with a plan digest and a durable operation ID, and adds `--operations` (renameField, backfillField), `--branch`, `--json` and `atmyapp migrate-status [--reconcile]`. The structure planner reports required-ness, enum, bound, format, rename, kind and path changes and exposes `validateMigrationOperations` and `applyMigrationOperations`. Legacy artifacts carrying `version: 1` are read as legacy, `isAssignedOnSave` identifies server-assigned order and sourced slug values, and JSON Schema `integer` columns read as whole numbers.
