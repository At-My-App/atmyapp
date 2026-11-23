# @atmyapp/cli

## 0.5.0

### Minor Changes

- 9be0ddb: Read the project from the terminal or a coding agent: `atmyapp whoami`, `doctor`, `schema show`, `content ls|get|pull`, `entries ls|get`, `assets get` and `locales status`. Content is named the same way everywhere (`doc:home@de#/hero/title`, `entry:posts/8f2a`), reads show the stored, delivered, overlay or effective view, and `content pull` keeps a local copy in `.ama/content` that later pulls update with only what changed.

  Every command now reads `ATMYAPP_CLI_URL` and `ATMYAPP_CLI_KEY`, prints `{ ok, data }` or `{ ok, error: { code, message, fix } }` with `--json`, uses documented exit codes, and never waits for input without a terminal. `atmyapp help --json` describes every command.

  Fixes: `atmyapp snapshot` used a fixed server instead of the session's; `atmyapp init` no longer tries to create a website API key with the CLI key (it prints where to create one).

- c02fca9: Add repeatable `entries ls --where` filters and keyset cursors for remote collections. Older cursors remain valid, and unfiltered listings still work with an older AtMyApp server.
- 0cf224a: Merge published changes into local spaces and stage files and attachments with resumable named uploads.
- 43e57cb: Edit AtMyApp content in local spaces, validate it, and submit named drafts for dashboard review. The local SDK applies space-specific file and translation deletions.
- df2bed2: Add scoped browser login, named draft publishing, website deployment and release commands, and project key management.
- f3f951c: Edit translations from source-checked segments or a merged local view. Share locale overlays and source history across CLI, SDK, and server workflows.
- e5e210b: `atmyapp submissions tail [type]` follows form submissions as they arrive: received ones with their environment, sender and a snippet; rejected ones with the reason; and inbox changes. `--json` prints NDJSON for scripts. Live visitor data is hidden unless `--include-live-data` is passed; test and local submissions always show in full.

### Patch Changes

- e5e210b: The `astro-tailwind` starter registers the `atmyapp()` integration (without it, builds failed to resolve `virtual:atmyapp/config`), depends on the current `@atmyapp/astro`, `@atmyapp/core` and `@atmyapp/structure`, and its `.env.example` uses `ATMYAPP_API_URL` with the content host. `atmyapp init` now prints `ATMYAPP_API_URL` with the content (`edge`) host instead of the CLI URL, and the generated client prefers it. `atmyapp --version` reports the installed version.
- 8f60f5a: Local mode images and files now load in the browser: the Astro dev server serves `.ama/content` at `/__atmyapp/content/`, and the client returns URLs on that route (set `ATMYAPP_LOCAL_ASSET_BASE` with other frameworks) instead of `file://` URLs, which browsers refuse on web pages. `$file` values that point outside the local store are no longer turned into URLs. Incremental `content pull` now hard-links unchanged files instead of copying the whole local copy.
- Updated dependencies [03686a1]
- Updated dependencies [8f60f5a]
- Updated dependencies [9be0ddb]
- Updated dependencies [43e57cb]
- Updated dependencies [f3f951c]
- Updated dependencies [e5e210b]
- Updated dependencies [9be0ddb]
  - @atmyapp/core@0.7.0
  - @atmyapp/structure@0.6.0

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
