# create-atmyapp

## 0.2.3

### Patch Changes

- e5e210b: The `astro-tailwind` starter registers the `atmyapp()` integration (without it, builds failed to resolve `virtual:atmyapp/config`), depends on the current `@atmyapp/astro`, `@atmyapp/core` and `@atmyapp/structure`, and its `.env.example` uses `ATMYAPP_API_URL` with the content host. `atmyapp init` now prints `ATMYAPP_API_URL` with the content (`edge`) host instead of the CLI URL, and the generated client prefers it. `atmyapp --version` reports the installed version.
- Updated dependencies [e5e210b]
- Updated dependencies [e5e210b]
  - @atmyapp/cli@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [6f364cd]
  - @atmyapp/cli@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [d6d295e]
- Updated dependencies [d6d295e]
  - @atmyapp/cli@0.3.0

## 0.2.0

### Minor Changes

- 83e59fc: Add the AtMyApp project creator with an Astro, Tailwind CSS, and AtMyApp starter template. Also allow `atmyapp migrate --dry-run` to run before a project session is configured.

### Patch Changes

- Updated dependencies [83e59fc]
  - @atmyapp/cli@0.2.0
