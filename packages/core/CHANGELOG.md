# @atmyapp/core

## 0.6.0

### Minor Changes

- 6f364cd: Collection reads keep the server's `previewApproximate` flag: `dataWithMeta` results carry it, `onPreviewApproximate` is called (a console warning by default), and `strictPreview` turns an approximate preview into a failed request that follows `errorPolicy`. The structure package adds `pruneDeletedItemTranslations`, which drops translations of source items that were deleted, and `validateLocalizedOverlayFields`, which reports translated values for fields that are not localized (`not-localizable`).

### Patch Changes

- Updated dependencies [6f364cd]
  - @atmyapp/structure@0.5.0

## 0.5.0

### Minor Changes

- d6d295e: Add shared draft/publication validation with stable issue codes and severities, explicit nullability, creation-only normalization, stable object-list identities, strict schema checks, and a testing corpus export. Reject ambiguous identity/union normalization instead of guessing, preserve delivery keys and generated item types, include singleton references in integrity snapshots, and make website settings types reflect their optional stored fields. Publication editorial acceptance must be bound to an exact human-reviewed state by the server.

### Patch Changes

- Updated dependencies [d6d295e]
- Updated dependencies [d6d295e]
- Updated dependencies [d6d295e]
  - @atmyapp/structure@0.4.0

## 0.4.0

### Minor Changes

- fb461ae: Replace experimental Astro metadata with framework-independent Website settings. Share the schema, defaults, title and social resolution, and basic homepage structured data. Support managed image references and explicit removal. Astro uses the neutral system-config endpoint and renders server-generated browser and phone icon URLs.

  This changes the experimental configuration path and removes the framework parameter from system-config reads. Coordinate the AMA backend update and initialize Website settings; no migration is provided. Page title overrides support `titleMode="absolute"`. AI enrichment remains a subsequent feature.

### Patch Changes

- Updated dependencies [fb461ae]
  - @atmyapp/structure@0.3.0

## 0.3.0

### Minor Changes

- 0560083: Add optional, sanitized integration reports and an Astro diagnostics route helper for runtime and static websites.

### Patch Changes

- 0560083: Add static-first Astro integration, shared request-scoped clients, DEV_MODE with IS_DYNAMIC alias, preview-aware metadata defaults, safe head output, HTML submission forms and detailed Astro guides. System configuration requests now carry preview context, and all core request clients honor customFetch through the transport library's supported option. Astro integration requires Astro 5+ and Node 22.14+.

## 0.2.0

### Minor Changes

- a742a81: Add order fields and improve reference and slug handling for managed content schemas.

### Patch Changes

- Updated dependencies [a742a81]
  - @atmyapp/structure@0.2.0

## 0.1.4

### Patch Changes

- 8803c37: Move AtMyApp packages into the public monorepo release pipeline.
- Updated dependencies [8803c37]
  - @atmyapp/structure@0.1.4
