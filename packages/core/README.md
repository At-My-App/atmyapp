# @atmyapp/core

[![npm](https://img.shields.io/npm/v/@atmyapp/core.svg)](https://www.npmjs.com/package/@atmyapp/core)

The JavaScript client for [AtMyApp](https://atmyapp.com). Read your client's content (documents, collections, images, website settings) and send form submissions from any framework: Next.js, SvelteKit, Nuxt, Remix, a Node server or plain browser code.

Using Astro? Install [`@atmyapp/astro`](https://www.npmjs.com/package/@atmyapp/astro) instead. It wraps this package and adds previews, SEO tags and forms.

**Documentation: [docs.atmyapp.com](https://docs.atmyapp.com)**

## Install

```sh
npm install @atmyapp/core @atmyapp/structure
npm install --save-dev @atmyapp/cli
```

Works in Node 18+, edge runtimes and browsers.

## Quick start

**1. Describe your content** in `atmyapp.schema.ts`, then upload it with `npx atmyapp migrate`:

```ts
import { defineCollection, defineDocument, defineSchema, s } from "@atmyapp/structure";

export default defineSchema({
  definitions: {
    home: defineDocument({
      fields: { headline: s.string({ max: 80 }), hero: s.image({ optional: true }) },
    }),
    posts: defineCollection({
      fields: { title: s.string(), slug: s.slug({ source: "title" }) },
    }),
  },
});
```

**2. Create a client** with the Project API URL and API key from **Settings → API keys** in the dashboard:

```ts
import { createAtMyAppClient } from "@atmyapp/core";
import schema from "./atmyapp.schema";

export const ama = createAtMyAppClient({
  baseUrl: process.env.ATMYAPP_API_URL!, // https://edge.atmyapp.com/v0/projects/<id>
  apiKey: process.env.ATMYAPP_API_KEY!,
  schema,
  errorPolicy: "throw",
});
```

**3. Read typed content:**

```ts
import { CollectionsFilter as F } from "@atmyapp/core";

const home = await ama.storage.getValue("home");
home.headline;     // string
home.hero?.url;    // image URL

const posts = await ama.collections.list("posts", { limit: 10 });
const post = await ama.collections.first("posts", { filter: F.eq("slug", "hello-world") });
```

The API key is public: it reads published content and sends forms, so it's safe in browser code.

## What's in the client

| Namespace | For |
| --- | --- |
| `ama.storage` | Documents and single assets: `getValue`, `getFromPath`, `getStaticUrl` |
| `ama.collections` | Entries: `list`, `first`, `getById`, `getManyByIds`, with filters, sorting and pagination |
| `ama.submissions` | Forms: `submit`, `validate`, `getFormParams`, `getTypeStatus` |
| `ama.systemConfig` | Website settings (name, title, description, sharing image, icons) |
| `ama.localization` | Available languages for translated content |
| `ama.diagnostics` | A safe report of the configuration and connection |

## Send a form

```ts
const result = await ama.submissions.submit("contact", {
  email: "jan@example.com",
  message: "Do you deliver on Sundays?",
});

if (result.ok) showThanks();
else showErrors(result.error.fields ?? result.error.message);
```

`submit` never throws for problems a visitor can cause, retries lost connections safely, and checks values against your schema before sending. For plain HTML forms, `@atmyapp/core/forms` adds inline errors without an API key:

```ts
import { enhanceSubmissionForm } from "@atmyapp/core/forms";
enhanceSubmissionForm(document.querySelector("form")!);
```

## Previews

When your client previews a draft, AtMyApp opens your page with `?amaPreviewKey=…`. In server-rendered code, create a client per request with that key:

```ts
const previewKey = new URL(request.url).searchParams.get("amaPreviewKey") ?? undefined;
const ama = createAtMyAppClient({ baseUrl, apiKey, schema, previewKey, mode: previewKey ? "priority" : "client" });
```

Never put a preview key in a shared client.

## Learn more

- [Connect any JavaScript website](https://docs.atmyapp.com/quick-start/): step by step, with Next.js, SvelteKit and Nuxt examples
- [Collections](https://docs.atmyapp.com/guides/collections/): filters, pagination, references
- [Forms](https://docs.atmyapp.com/guides/forms/)
- [API reference](https://docs.atmyapp.com/reference/core/)

## License

ISC
