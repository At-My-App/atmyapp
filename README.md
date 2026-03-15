# AtMyApp Structure

[![npm version](https://badge.fury.io/js/%40atmyapp%2Fstructure.svg)](https://badge.fury.io/js/%40atmyapp%2Fstructure)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

Canonical schema toolkit for AtMyApp. `@atmyapp/structure` is the single runtime package that owns schema parsing, normalization, validation, introspection, migration planning, and legacy `.structure.json` compatibility.

## What it solves

- One canonical schema model for collections, documents, files, and images
- Runtime-agnostic authoring with both TypeScript DSL and neutral JSON input
- Shared validation across CLI, server, dashboard, and assistant flows
- First-class system fields such as `id`, `createdAt`, `updatedAt`, and `slug`
- First-class asset fields for associated files and images
- Shared migration planning with actionable change prompts
- Legacy `.structure.json` generation and parsing during rollout

## Installation

```bash
# npm
npm install @atmyapp/structure

# yarn
yarn add @atmyapp/structure

# pnpm
pnpm add @atmyapp/structure
```

## Core concepts

- `collection`: multi-entry structured data with indexes, query semantics, and system fields
- `document`: single path-backed structured file, replacing the old `jsonx` concept
- `asset` fields: first-class associated files such as `image`, `file`, and `gallery`
- `systemFields`: reserved fields that can be enabled and configured but not declared as normal fields
- fields are required by default; use `optional: true` to make a field optional
- `description`: supported at schema, definition, field, MDX config, and MDX component levels for assistant-facing context

## TypeScript DSL

```ts
import {
  compileSchema,
  defineCollection,
  defineDocument,
  defineSchema,
  s,
} from "@atmyapp/structure";

const schema = defineSchema({
  description: "Marketing site schema",
  mdx: {
    blog: {
      description: "Blog content components",
      components: {
        Callout: {
          description: "Highlighted message block",
          props: {
            title: "string",
          },
        },
      },
    },
  },
  definitions: {
    posts: defineCollection({
      description: "Blog posts",
      fields: {
        title: s.string({
          description: "Public title shown on the page",
        }),
        cover: s.image({
          description: "Associated hero image for the post",
          config: {
            optimizeFormat: "webp",
            maxSize: {
              width: 1920,
              height: 1080,
            },
          },
        }),
        body: s.mdx("blog", {
          description: "Long-form article body",
        }),
        author: s.reference("authors", {
          description: "Linked author profile",
          by: "slug",
        }),
        seo: s.object({
          title: s.string(),
          socialImages: s.array(
            s.image({
              description: "Image used for social previews",
            }),
            {
              optional: true,
              description: "Nested list of social preview images",
            }
          ),
        }),
      },
      systemFields: {
        slug: {
          enabled: true,
          source: "title",
        },
      },
      indexes: ["title"],
    }),
    settings: defineDocument({
      description: "Single site settings file",
      fields: {
        theme: s.string({
          description: "Theme identifier used by the UI",
        }),
        accent: s.string({
          description: "Optional accent color",
          optional: true,
        }),
      },
    }),
  },
});

const compiled = compileSchema(schema);
```

`defineDocument()` does not need a `path` by default. If the key is `settings`, both `settings` and `settings.json` resolve to the same document automatically.

## Neutral JSON input

The same canonical model can be authored without TypeScript:

```json
{
  "version": 1,
  "description": "Marketing site schema",
  "definitions": {
    "settings": {
      "kind": "document",
      "description": "Single site settings file",
      "path": "settings.json",
      "fields": {
        "theme": {
          "kind": "scalar",
          "scalar": "string",
          "description": "Theme identifier used by the UI"
        }
      }
    }
  }
}
```

## Main APIs

### Compiler

```ts
import { compileSchema, parseSchema, normalizeSchema } from "@atmyapp/structure";
```

- `parseSchema(input)`: parses canonical JSON or legacy `.structure.json`
- `normalizeSchema(schema)`: normalizes definitions, paths, and defaults
- `compileSchema(input)`: builds the compiled schema with precomputed indexes

### Introspection

```ts
import {
  getDefinition,
  getCollection,
  getDocument,
  getField,
  listAssetFields,
  listConfigs,
  listReferences,
  listSystemFields,
  resolveDefinitionForPath,
} from "@atmyapp/structure";
```

Use these helpers instead of manually traversing raw `.structure` objects.

## References

References store string values by default, but the schema can describe how those strings should resolve:

```ts
s.reference("authors", {
  by: "id",
});

s.reference("posts", {
  by: "slug",
});

s.reference("settings", {
  by: "path",
});
```

- `target`: the referenced definition name
- `by: "id"`: default for collection-style identity
- `by: "slug"`: requires the target to expose a slug
- `by: "path"`: useful for document-style references
- `multiple: true`: stores an array of references
- `onDelete`: optional lifecycle hint for downstream consumers

The current runtime value shape is a string or string array. That keeps references easy to store, easy to index, and easy to migrate while still carrying explicit semantics in the schema.

## Nested types and lists

Nested objects and arrays are first-class in the canonical schema model:

```ts
const article = defineDocument({
  fields: {
    title: s.string(),
    seo: s.object({
      title: s.string(),
      summary: s.string({ optional: true }),
    }),
    gallery: s.array(
      s.image({
        config: {
          optimizeFormat: "webp",
        },
      }),
      {
        optional: true,
      }
    ),
  },
});
```

Notes:

- all nested fields are required unless marked with `optional: true`
- `s.array(s.image())` works for image lists
- `s.gallery()` is still available when you want a semantic “multiple images” asset field
- nested field descriptions are preserved in the compiled schema and legacy output

## Images and asset config

Image fields support config aligned with existing `@atmyapp/core` and `@atmyapp/cli` image definitions:

```ts
s.image({
  config: {
    optimizeFormat: "webp",
    optimizeLoad: "progressive",
    ratioHint: { x: 16, y: 9 },
    maxSize: { width: 1920, height: 1080 },
  },
});
```

That config is preserved through canonical compilation and legacy `.structure.json` emission.

### Validation

```ts
import {
  validateSchemaDocument,
  validateContent,
  validateContentAtPath,
} from "@atmyapp/structure";
```

- `validateSchemaDocument(input)`: validates authored schema documents
- `validateContent(compiled, definitionName, data)`: validates parsed content objects
- `validateContentAtPath(compiled, path, content, mimeType?)`: validates raw file content against the resolved definition

### Migrations

```ts
import {
  diffSchemas,
  planMigration,
  renderMigrationPrompts,
} from "@atmyapp/structure";
```

Migration planning classifies changes as compatible, safe auto-convert, confirmable convert, or incompatible. The planner produces executable actions such as:

- `confirm_convert`
- `require_union`
- `backfill_generated_field`
- `create_unique_index`
- `drop_field`
- `drop_definition`

## Legacy `.structure.json` compatibility

The package can compile existing `.structure.json` files and also emit legacy-compatible output:

```ts
import { compileSchema, toLegacyStructure } from "@atmyapp/structure";

const compiled = compileSchema(existingStructureJson);
const legacy = toLegacyStructure(compiled.document);
```

This keeps old projects working while runtime consumers migrate to the canonical schema model.

## Development

```bash
npm ci
npm test
npm run build
npm pack --dry-run
```

## Publishing

The repository includes manual release workflows similar to the `@atmyapp/core` package:

- run tests before release
- verify the version was bumped
- build the package
- create a GitHub release
- publish to npm with provenance

Before publishing:

1. Update the version in `package.json`.
2. Run `npm test`.
3. Run `npm run build`.
4. Run `npm pack --dry-run`.
5. Trigger the GitHub release workflow.

## License

ISC
