# @atmyapp/cli

## 0.4.0

### Minor Changes

- 6f364cd: Confirming a migration plan approves its content warnings; the CLI sends that approval with the apply request. Each migration is recorded in `.ama/migrations/<operationId>.json` with its target, branch, compiled schema, operations and clears (never the token). `migrate-status` and `--reconcile` use exactly what was applied and refuse a session that points at another project or branch. With `--json`, stdout holds exactly one JSON document, also on failure, and logs go to stderr.

### Patch Changes

- Updated dependencies [6f364cd]
  - @atmyapp/core@0.6.0
  - @atmyapp/structure@0.5.0

## 0.3.0

### Minor Changes

- d6d295e: Persist the normalized canonical schema directly from the CLI. Preserve paths and field metadata, remove generated audit timestamps from schema output, reject colliding aliases and unsupported versions, and expose deterministic contract serialization. Public submission schemas no longer accept secret literals; configure those on the server. The CLI includes TypeScript as a runtime dependency and accurately reports that removed-column values are retained.
- d6d295e: Plan schema migrations against the target environment's content and apply exactly the reviewed plan. The CLI plans, confirms (`--yes` for CI), and applies with a plan digest and a durable operation ID, and adds `--operations` (renameField, backfillField), `--branch`, `--json` and `atmyapp migrate-status [--reconcile]`. The structure planner reports required-ness, enum, bound, format, rename, kind and path changes and exposes `validateMigrationOperations` and `applyMigrationOperations`. Legacy artifacts carrying `version: 1` are read as legacy, `isAssignedOnSave` identifies server-assigned order and sourced slug values, and JSON Schema `integer` columns read as whole numbers.

### Patch Changes

- Updated dependencies [d6d295e]
- Updated dependencies [d6d295e]
- Updated dependencies [d6d295e]
  - @atmyapp/structure@0.4.0
  - @atmyapp/core@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [fb461ae]
  - @atmyapp/structure@0.3.0
  - @atmyapp/core@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [0560083]
- Updated dependencies [0560083]
  - @atmyapp/core@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [a742a81]
  - @atmyapp/structure@0.2.0
  - @atmyapp/core@0.2.0

## 0.2.0

### Minor Changes

- 83e59fc: Add the AtMyApp project creator with an Astro, Tailwind CSS, and AtMyApp starter template. Also allow `atmyapp migrate --dry-run` to run before a project session is configured.

## 0.1.5

### Patch Changes

- 8803c37: Move AtMyApp packages into the public monorepo release pipeline.
- Updated dependencies [8803c37]
  - @atmyapp/structure@0.1.4
  - @atmyapp/core@0.1.4
