# @atmyapp/structure

## 0.5.0

### Minor Changes

- 6f364cd: Collection reads keep the server's `previewApproximate` flag: `dataWithMeta` results carry it, `onPreviewApproximate` is called (a console warning by default), and `strictPreview` turns an approximate preview into a failed request that follows `errorPolicy`. The structure package adds `pruneDeletedItemTranslations`, which drops translations of source items that were deleted, and `validateLocalizedOverlayFields`, which reports translated values for fields that are not localized (`not-localizable`).

## 0.4.0

### Minor Changes

- d6d295e: Persist the normalized canonical schema directly from the CLI. Preserve paths and field metadata, remove generated audit timestamps from schema output, reject colliding aliases and unsupported versions, and expose deterministic contract serialization. Public submission schemas no longer accept secret literals; configure those on the server. The CLI includes TypeScript as a runtime dependency and accurately reports that removed-column values are retained.
- d6d295e: Plan schema migrations against the target environment's content and apply exactly the reviewed plan. The CLI plans, confirms (`--yes` for CI), and applies with a plan digest and a durable operation ID, and adds `--operations` (renameField, backfillField), `--branch`, `--json` and `atmyapp migrate-status [--reconcile]`. The structure planner reports required-ness, enum, bound, format, rename, kind and path changes and exposes `validateMigrationOperations` and `applyMigrationOperations`. Legacy artifacts carrying `version: 1` are read as legacy, `isAssignedOnSave` identifies server-assigned order and sourced slug values, and JSON Schema `integer` columns read as whole numbers.
- d6d295e: Add shared draft/publication validation with stable issue codes and severities, explicit nullability, creation-only normalization, stable object-list identities, strict schema checks, and a testing corpus export. Reject ambiguous identity/union normalization instead of guessing, preserve delivery keys and generated item types, include singleton references in integrity snapshots, and make website settings types reflect their optional stored fields. Publication editorial acceptance must be bound to an exact human-reviewed state by the server.

## 0.3.0

### Minor Changes

- fb461ae: Replace experimental Astro metadata with framework-independent Website settings. Share the schema, defaults, title and social resolution, and basic homepage structured data. Support managed image references and explicit removal. Astro uses the neutral system-config endpoint and renders server-generated browser and phone icon URLs.

  This changes the experimental configuration path and removes the framework parameter from system-config reads. Coordinate the AMA backend update and initialize Website settings; no migration is provided. Page title overrides support `titleMode="absolute"`. AI enrichment remains a subsequent feature.

## 0.2.0

### Minor Changes

- a742a81: Add order fields and improve reference and slug handling for managed content schemas.

## 0.1.4

### Patch Changes

- 8803c37: Move AtMyApp packages into the public monorepo release pipeline.
