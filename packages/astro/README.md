# @atmyapp/astro

Static-first AtMyApp integration for Astro: environment-based clients, request-scoped previews, managed head metadata, HTML forms and optional diagnostics.

Requires Astro 5+ and Node 22.14+. This is the canonical Astro SDK in the unified At-My-App/atmyapp repository.

```sh
npm install @atmyapp/astro
```

```dotenv
ATMYAPP_API_KEY=pk-ama-your-project-key
ATMYAPP_API_URL=https://api.atmyapp.com/v0/projects/YOUR_PROJECT_ID
```

```js
import { defineConfig } from "astro/config";
import atmyapp from "@atmyapp/astro";
export default defineConfig({
  site: "https://www.example.com",
  integrations: [atmyapp({ diagnostics: true })],
});
```

Use `getAtMyApp(Astro)` from `@atmyapp/astro/server` for content, `AtMyAppHead` from `@atmyapp/astro/components` in your layout, and `AtMyAppForm` from `@atmyapp/astro/form` for direct HTML submissions.

`DEV_MODE=true` enables dynamic rendering; `IS_DYNAMIC` is an alias. Local development defaults dynamic, production builds static. Dynamic production builds require an Astro adapter. API keys are public; previews remain request-scoped.

## Guides

- [Complete setup](../../docs/src/content/docs/guides/astro.mdx)
- [Modes and previews](../../docs/src/content/docs/guides/astro-previews.mdx)
- [Metadata and SEO](../../docs/src/content/docs/guides/astro-metadata.mdx)
- [Static HTML forms](../../docs/src/content/docs/guides/astro-forms.mdx)
- [API reference](../../docs/src/content/docs/reference/astro.mdx)

The website fixture in `test/fixtures/website` is exercised in static, development and built Node server modes by `pnpm --filter @atmyapp/astro test:website`. Releases use the unified workspace Changesets workflow.

## Website settings

Manage website-wide defaults in **Settings → Website settings**. `<AtMyAppHead />` uses them automatically; `<AtMyAppHead title="Menu" />` applies the website-name suffix, while `titleMode="absolute"` preserves an exact page title. AMA generates browser and phone icon variants on the server; the SDK renders their URLs. See the metadata guide for precedence, clearing, preview behavior and server-rendering limits.
