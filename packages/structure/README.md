# @atmyapp/structure

[![npm](https://img.shields.io/npm/v/@atmyapp/structure.svg)](https://www.npmjs.com/package/@atmyapp/structure)

Define what your client can edit in an [AtMyApp](https://atmyapp.com) website: documents, collections, fields and forms, in TypeScript. The same definitions validate content in the dashboard, guide the AI assistant, and give your code typed results.

**Documentation: [docs.atmyapp.com](https://docs.atmyapp.com) · [Design your schema](https://docs.atmyapp.com/guides/structure/) · [Field reference](https://docs.atmyapp.com/reference/fields/)**

## Install

```sh
npm install @atmyapp/structure
```

`@atmyapp/core` re-exports everything here, so websites can import from either.

## Example

```ts
// atmyapp.schema.ts
import {
  defineCollection,
  defineDocument,
  defineSchema,
  defineSubmission,
  s,
} from "@atmyapp/structure";

export default defineSchema({
  definitions: {
    home: defineDocument({
      description: "The homepage.",
      fields: {
        headline: s.string({ max: 80, description: "Large heading at the top." }),
        intro: s.longText({ optional: true }),
        hero: s.image({ optional: true }),
      },
    }),
    authors: defineCollection({
      fields: { name: s.string(), avatar: s.image({ optional: true }) },
    }),
    posts: defineCollection({
      fields: {
        title: s.string({ max: 90 }),
        slug: s.slug({ source: "title" }),
        body: s.markdown(),
        author: s.reference("authors"),
        tags: s.array({ items: s.string(), maxItems: 5, optional: true }),
      },
    }),
  },
  submissions: {
    contact: defineSubmission({
      fields: { email: s.email(), message: s.longText({ min: 10 }) },
    }),
  },
});
```

Upload it with the CLI:

```sh
npx atmyapp migrate
```

## Fields

| Builder | Value |
| --- | --- |
| `s.string`, `s.shortText`, `s.longText`, `s.markdown`, `s.email`, `s.url` | `string` |
| `s.number`, `s.integer` | `number` |
| `s.boolean` | `boolean` |
| `s.date`, `s.datetime`, `s.timestamp` | ISO `string` |
| `s.enum({ values })`, `s.union({ variants })` | one of the values / variants |
| `s.object({ fields })`, `s.array({ items })` | nested content |
| `s.image`, `s.file`, `s.gallery` | `{ url }` / `{ url }[]` |
| `s.reference(target)` | the target entry's ID |
| `s.slug({ source })`, `s.order()`, `s.mdx({ config })` | URL identifier, rank, MDX |

Fields are required unless `optional: true`. Add `nullable: true` to let editors clear a value. Every option is in the [field reference](https://docs.atmyapp.com/reference/fields/).

## Types and validation

```ts
import { compileSchema, validateContent, type InferDefinition } from "@atmyapp/structure";
import schema from "./atmyapp.schema";

type Post = InferDefinition<"posts", typeof schema>;

const result = validateContent(compileSchema(schema), "home", { headline: "Hi" });
if (!result.valid) console.log(result.issues);
```

The package also exports introspection helpers and migration planning for tools. See the [API reference](https://docs.atmyapp.com/reference/structure/).

## License

ISC
