# AtMyApp Packages

Public monorepo for the AtMyApp npm packages.

## Packages

- `@atmyapp/structure`
- `@atmyapp/core`
- `@atmyapp/cli`
- `@atmyapp/astro`

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Internal package dependencies use the `workspace:` protocol during development and are rewritten to regular semver ranges when published.

## Releases

Releases are managed with Changesets.

```sh
pnpm changeset
```

Merging the generated version PR publishes changed packages to npm with provenance.
