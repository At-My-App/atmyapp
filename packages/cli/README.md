# AtMyApp CLI

[![npm version](https://badge.fury.io/js/%40atmyapp%2Fcli.svg)](https://badge.fury.io/js/%40atmyapp%2Fcli)

The official CLI for working with AtMyApp projects.

It is now centered on the canonical schema flow:

- author definitions in `atmyapp.schema.ts`, `atmyapp.schema.mts`, `atmyapp.schema.js`, `atmyapp.schema.mjs`, or `atmyapp.schema.json`
- compile them with `@atmyapp/structure`
- generate the normalized canonical schema without a legacy conversion
- upload that payload with `atmyapp migrate`

## Installation

```bash
npm install -g @atmyapp/cli
```

## Quick Start

Create a new Astro + Tailwind + AtMyApp project:

```bash
npm create atmyapp@latest
```

Or, if the CLI is already installed:

```bash
atmyapp create
```

Work with AtMyApp inside an existing project:

```bash
# 1. Authenticate this workspace
atmyapp use --token your-cli-token --url https://edge.atmyapp.com/projects/your-project-id

# 2. Generate a canonical schema + starter client
atmyapp init --template minimal

# 3. Compile and upload it
atmyapp migrate

# 4. Or preview the generated payload locally
atmyapp migrate --dry-run --verbose
```

## Canonical Schema

```ts
import {
  defineCollection,
  defineDocument,
  defineSchema,
  s,
} from "@atmyapp/structure";

export default defineSchema({
  definitions: {
    posts: defineCollection({
      fields: {
        title: s.string({ min: 3 }),
        slug: s.string({ format: "short" }),
        excerpt: s.string({ format: "long", default: "" }),
        cover: s.image({ optional: true }),
        seo: s.object({
          optional: true,
          fields: {
            title: s.string({ optional: true }),
          },
        }),
        publishedAt: s.date({ optional: true }),
      },
    }),
    settings: defineDocument({
      fields: {
        theme: s.string({ default: "light" }),
        supportEmail: s.string({ format: "email" }),
      },
    }),
  },
});
```

The CLI accepts either:

- a `default` export
- a named `schema` export

## Commands

### `atmyapp create`

Creates a new project from an AtMyApp template.

```bash
atmyapp create
atmyapp create my-site
atmyapp create my-site --template astro-tailwind --pm pnpm
atmyapp create my-site --no-install --no-git
atmyapp create my-site --yes
```

The `astro-tailwind` template creates a static Astro site with Tailwind CSS, a root `atmyapp.schema.ts`, two starter pages, sample joke content, and package scripts for development, builds, previews, checks, and AtMyApp migrations.

For the public initializer flow, use:

```bash
npm create atmyapp@latest
```

### `atmyapp init`

Creates starter files for your project. By default it writes `atmyapp.schema.ts`.

```bash
atmyapp init
atmyapp init --template empty
atmyapp init --template minimal
atmyapp init --template blog
atmyapp init --path atmyapp.schema.json
atmyapp init --force
```

Templates:

- `empty` creates only a bare schema
- `minimal` creates a small document-based schema plus an exported client file
- `blog` creates a hero document, a blog-post collection, and an exported client file

For `minimal` and `blog`, `init` also asks whether you want to create a new project API key. If you confirm, it:

- fetches your project environments
- creates a new API key in the default environment
- prints `ATMYAPP_URL=...` and `ATMYAPP_API_KEY=...` lines to copy into your env file

If you want that API key flow, make sure you have already run `atmyapp use`, or pass `--url`, `--token`, and `--project-id` directly to `init`.

### `atmyapp use`

Stores your project URL and CLI token in `.ama/session.json`.

```bash
atmyapp use --token cli_... --url https://edge.atmyapp.com/projects/your-project-id
```

### `atmyapp migrate`

Finds your canonical schema file, compiles it to `.ama/definitions.json`, and plans the change against the target environment's stored content. If nothing in the plan blocks it, the CLI asks for confirmation when stored content is affected, then applies exactly the reviewed plan.

```bash
atmyapp migrate [options]
```

Options:

- `--dry-run` Compile locally without contacting the server
- `--branch <name>` Target environment branch (default: `main`)
- `--operations <file>` JSON file with explicit content operations (see below)
- `-y, --yes` Apply a plan that rewrites, removes or hides stored content without asking (required in CI)
- `--json` Print the plan and result as JSON
- `--clear-collection <name>`, `--clear-content <name>`, `--clear-column <collection.column>` Confirm removals. Removed columns are hidden from editors, and their values are kept in storage.
- `--dangerously-resolve-all-conflicts` Plan again with clears for every destructive conflict in the current plan
- `--verbose` Print detailed logs, including sample content changes

The plan shows:
- schema changes;
- how many stored items the operations rewrite;
- removals;
- content problems the change would introduce, separated from problems that already existed.

The plan is blocked when the change would make stored content invalid, for example a field that becomes required while entries lack it. Fix the content, or add a `backfillField` operation.

Renames are never guessed. Declare them in an operations file:

```json
[
  { "type": "renameField", "definition": "posts", "from": "title", "to": "headline" },
  { "type": "backfillField", "definition": "posts", "field": "summary", "value": "" }
]
```

`renameField` moves stored values, including translations, and moves form layouts to the new name. `backfillField` fills the field only where it is missing.

A plan with content warnings, such as a shorter maximum length than some stored values, needs the same confirmation. Confirming approves exactly those warnings.

Each apply uses a new operation ID. Before the request is sent, the CLI writes a record of it to `.ama/migrations/<operationId>.json`: the server URL, branch, compiled schema, operations and clears (never the token). Records are never changed afterwards. If content changed after the plan was made, the CLI reports that nothing was written; run it again to review a fresh plan. If the response is lost, the migration may still have been applied. Check it with:

### `atmyapp migrate-status`

```bash
atmyapp migrate-status [operationId] [--reconcile] [--operations <file>] [--json]
```

This reports whether a migration was committed. The default operation is the last one started in this directory. `--reconcile` re-runs follow-up work, such as updating the read model, for a committed migration. It uses the recorded schema and operations, so later edits to your schema files do not matter. If your session now points at a different project or branch, the command stops instead of checking the wrong one. `--operations` is only needed for a migration started elsewhere, without a local record.

With `--json`, stdout contains exactly one JSON document, also on failure; logs go to stderr.

If no canonical schema file is found, the command exits with a clear error.

The CLI looks for both:

- `atmyapp.schema.*`
- `ama.schema.*`

If both exist, `atmyapp.schema.*` wins.

For `minimal` and `blog`, the generated client file reads:

- `ATMYAPP_API_KEY`
- `ATMYAPP_URL`
- `ATMYAPP_API_URL`
- `ATMYAPP_BASE_URL`

### `atmyapp upload`

Uploads local files directly into project storage.

```bash
atmyapp upload "content/**/*" --base-path content --commit "Update content"
```

### `atmyapp generate`

Generates a placeholder file for a project storage path.

```bash
atmyapp generate --path content/settings.json
```

### `atmyapp snapshot`

Fetches a snapshot of project storage from the configured project.

## Project Config

Optional project config can live in:

- `atmyapp.config.ts`
- `atmyapp.config.js`

Supported fields:

```ts
export default {
  description: "Marketing site schema",
  args: {
    locale: "en",
  },
  metadata: {
    source: "cli",
  },
};
```

`atmyapp migrate` merges this with the session config from `.ama/session.json`.

## Runtime API

The package also exports runtime helpers for custom tooling:

```ts
import {
  compileCanonicalSource,
  generateCanonicalOutput,
  runCanonicalMigrate,
} from "@atmyapp/cli";
```

These APIs compile canonical schema modules with `@atmyapp/structure` and return the generated migration payload plus validation details.

## Notes

- The CLI no longer supports the old type-alias extraction flow based on exported `ATMYAPP` tuples.
- The generated `.ama/definitions.json` is the normalized canonical schema persisted as `.structure.json`. It preserves explicit paths and field metadata and contains no generated audit timestamp. Schema authoring belongs to the website repository; the dashboard is read-only. `--clear-column` confirms hiding a removed field while retaining its stored values. `--dry-run` compiles locally; it is not a remote data-safety check.
- For schema authoring and inference helpers, use [`@atmyapp/structure`](https://www.npmjs.com/package/@atmyapp/structure).
