# AtMyApp SDKs

Packages for connecting websites to [AtMyApp](https://atmyapp.com), where developers build the site and their clients edit the content.

**Documentation: [docs.atmyapp.com](https://docs.atmyapp.com)**

| Package | Use it for |
| --- | --- |
| [`@atmyapp/astro`](packages/astro) | Astro integration: content, previews, SEO tags and forms |
| [`@atmyapp/core`](packages/core) | Any other JavaScript framework or runtime |
| [`@atmyapp/structure`](packages/structure) | Writing the content schema |
| [`@atmyapp/cli`](packages/cli) | Connecting a project and uploading schemas |
| [`create-atmyapp`](packages/create-atmyapp) | `npm create atmyapp@latest` |

The docs site lives in [`docs/`](docs).

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Internal dependencies use the `workspace:` protocol and are rewritten to semver ranges on publish. Run the docs locally with `pnpm --filter @atmyapp/docs dev`.

## Releases

Releases use [Changesets](https://github.com/changesets/changesets). For a change that should be released:

```sh
pnpm changeset
```

Pick the packages and the version bump, and commit the generated file in `.changeset/` with your change. Then:

1. Merge a PR that includes the changeset.
2. The **Release** workflow opens or updates a version PR.
3. Merge the version PR.
4. The workflow publishes the bumped packages to npm.

Commits without a changeset run CI but publish nothing. Docs deploy separately to GitHub Pages when `docs/` changes, and need no changeset.

Publishing uses the `NPM_TOKEN` secret (as `NODE_AUTH_TOKEN`). It needs publish access to the `@atmyapp` scope; with 2FA, use a granular token with 2FA bypass.

`packages/astro` is the only maintained source of `@atmyapp/astro`; the standalone At-My-App/astro repository is retired. Shared validation, defaults, nullability and item identity rules are described in [Content validation and normalization](docs/content-contract.md).
