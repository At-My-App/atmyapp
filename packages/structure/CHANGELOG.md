# @atmyapp/structure

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
