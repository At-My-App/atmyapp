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

Releases are managed with Changesets. A push to `main` always runs CI and the
release workflow, but it does not publish a new npm version unless there is a
pending changeset.

For a change that should be released, run:

```sh
pnpm changeset
```

Choose the changed package, select the semver bump, and commit the generated
file under `.changeset/` with your code change.

The release flow is:

1. Merge a PR that includes one or more `.changeset/*.md` files.
2. The `Release` workflow opens or updates a version PR.
3. Review and merge the version PR.
4. The `Release` workflow publishes the bumped packages to npm.

Commits without changeset files still run CI, but they do not create package
versions and do not publish anything.

Publishing uses the `NPM_TOKEN` GitHub Actions secret through `NODE_AUTH_TOKEN`.
The token must have permission to publish the `@atmyapp` packages. If the npm
account or packages require 2FA, use a granular token with publish access and
2FA bypass enabled.
