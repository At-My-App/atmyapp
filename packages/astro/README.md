# @atmyapp/astro

[![npm](https://img.shields.io/npm/v/@atmyapp/astro.svg)](https://www.npmjs.com/package/@atmyapp/astro)

The [AtMyApp](https://atmyapp.com) integration for Astro. Your client edits content in the dashboard; your Astro site renders it as static HTML, with live previews of drafts, managed SEO tags and forms that need no backend.

**Documentation: [docs.atmyapp.com](https://docs.atmyapp.com) · [Step-by-step tutorial](https://docs.atmyapp.com/guides/astro/)**

Requires Astro 5+ and Node 22.14+.

## Install

```sh
npm install @atmyapp/astro @atmyapp/core @atmyapp/structure
npm install --save-dev @atmyapp/cli
```

Starting from scratch? `npm create atmyapp@latest` creates a ready-made Astro + Tailwind site.

## Set up

Add the Project API URL and API key from **Settings → API keys** to `.env`:

```dotenv
ATMYAPP_API_URL=https://edge.atmyapp.com/v0/projects/<project-id>
ATMYAPP_API_KEY=<api-key>
```

Register the integration:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import atmyapp from "@atmyapp/astro";

export default defineConfig({
  site: "https://www.example.com",
  integrations: [atmyapp()],
});
```

On AtMyApp hosting, both variables are provided to builds automatically.

## Use it

Read content in any page:

```astro
---
import { getAtMyApp } from "@atmyapp/astro/server";
import schema from "../../atmyapp.schema";

const ama = getAtMyApp(Astro, { schema });
const home = await ama.storage.getValue("home");
const services = await ama.collections.list("services");
---
<h1>{home.headline}</h1>
{services.map((s) => <a href={`/services/${s.slug}/`}>{s.title}</a>)}
```

Render titles, descriptions, social tags and icons from **Website settings**:

```astro
---
import AtMyAppHead from "@atmyapp/astro/components";
---
<head>
  <AtMyAppHead title="Services" />
</head>
```

Add a form that posts straight to AtMyApp:

```astro
---
import AtMyAppForm from "@atmyapp/astro/form";
---
<AtMyAppForm submission="contact" enhance>
  <input name="email" type="email" required />
  <textarea name="message" required></textarea>
  <button>Send</button>
</AtMyAppForm>
```

## Static builds and previews

`astro build` is static: content is fetched once and written as HTML. `astro dev` and AtMyApp preview servers render per request, so drafts show up when your client clicks **Preview**. Set `DEV_MODE=true` (with an adapter) for a dynamic production build. In `getStaticPaths()`, which has no `Astro` object, call `getAtMyApp({ schema })`.

## Learn more

- [Tutorial: build an Astro website](https://docs.atmyapp.com/guides/astro/)
- [Modes and previews](https://docs.atmyapp.com/guides/astro-previews/)
- [Metadata and SEO](https://docs.atmyapp.com/guides/astro-metadata/)
- [Forms](https://docs.atmyapp.com/guides/astro-forms/)
- [API reference](https://docs.atmyapp.com/reference/astro/)

## Development

This package lives in the [At-My-App/atmyapp](https://github.com/At-My-App/atmyapp) monorepo. `pnpm --filter @atmyapp/astro test:website` builds the fixture site in `test/fixtures/website` in static, development and Node server modes.

## License

ISC
