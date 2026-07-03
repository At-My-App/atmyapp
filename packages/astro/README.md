# @atmyapp/astro

`@atmyapp/astro` is a minimal Astro integration for AtMyApp that injects managed head metadata at build time and exposes a ready-to-use browser client for analytics events.

## Installation

```bash
npm install @atmyapp/astro
```

## 3-step setup

1. Add environment variables to your `.env` file:

```env
ATMYAPP_API_KEY=your-public-api-key
ATMYAPP_BASE_URL=https://api.atmyapp.com
```

2. Add the head component once in your base layout:

```astro
---
import { AtMyAppHead } from "@atmyapp/astro/components";
---

<html>
  <head>
    <AtMyAppHead />
  </head>
  <body>
    <slot />
  </body>
</html>
```

3. Optional: track page views automatically:

```astro
<AtMyAppHead trackPageView />
```

## Send custom events from the browser

```ts
import { getClient } from "@atmyapp/astro/client";

await getClient().analytics.trackEvent("button_click");
await getClient().analytics.trackCustomEvent("form_submit", {
  form_id: "contact",
});
```

## Environment variables

- `ATMYAPP_API_KEY` (required in build mode)
- `ATMYAPP_BASE_URL` (optional, defaults to `https://api.atmyapp.com`)
- `DEV_MODE` (`0` enables build-time head fetch; any other value skips it)

The Astro integration reads the framework-managed `website.metadata` System Configuration File from the configured AtMyApp project API URL.

## Dev mode behavior

- Build-time head API fetch is skipped.
- Missing credentials only warn (no hard failure).
- `window.__ATMYAPP__` is still injected so browser-side `getClient()` works when credentials are present.

## Head configuration source of truth

After setup, all SEO and head metadata can be managed from Storage content in the AtMyApp dashboard through `Website Configuration - Astro Metadata`. No additional code changes are needed for normal metadata updates.
