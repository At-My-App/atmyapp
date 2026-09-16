# @atmyapp/astro

## 0.2.0

### Minor Changes

- fb461ae: Replace experimental Astro metadata with framework-independent Website settings. Share the schema, defaults, title and social resolution, and basic homepage structured data. Support managed image references and explicit removal. Astro uses the neutral system-config endpoint and renders server-generated browser and phone icon URLs.

  This changes the experimental configuration path and removes the framework parameter from system-config reads. Coordinate the AMA backend update and initialize Website settings; no migration is provided. Page title overrides support `titleMode="absolute"`. AI enrichment remains a subsequent feature.

### Patch Changes

- Updated dependencies [fb461ae]
  - @atmyapp/core@0.4.0

## 0.1.0

### Minor Changes

- 0560083: Add static-first Astro integration, shared request-scoped clients, DEV_MODE with IS_DYNAMIC alias, preview-aware metadata defaults, safe head output, HTML submission forms and detailed Astro guides. System configuration requests now carry preview context, and all core request clients honor customFetch through the transport library's supported option. Astro integration requires Astro 5+ and Node 22.14+.
- 0560083: Add optional, sanitized integration reports and an Astro diagnostics route helper for runtime and static websites.

### Patch Changes

- Updated dependencies [0560083]
- Updated dependencies [0560083]
  - @atmyapp/core@0.3.0

## 0.0.4

### Patch Changes

- Updated dependencies [a742a81]
  - @atmyapp/core@0.2.0

## 0.0.3

### Patch Changes

- 83e59fc: Add the AtMyApp project creator with an Astro, Tailwind CSS, and AtMyApp starter template. Also allow `atmyapp migrate --dry-run` to run before a project session is configured.

## 0.0.2

### Patch Changes

- 8803c37: Move AtMyApp packages into the public monorepo release pipeline.
- Updated dependencies [8803c37]
  - @atmyapp/core@0.1.4
