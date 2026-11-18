---
"@atmyapp/core": minor
"@atmyapp/astro": minor
---

The client reads the local copy written by `atmyapp content pull` (`.ama/content`): `clientMode: "local"` shows it, including drafts in the active space, and `"with-fallback"` falls back to its published content only. Translations and image URLs come out in the same shape as from the API. `ATMYAPP_CLIENT_MODE` overrides `clientMode`; with `@atmyapp/astro`, local mode needs no API key and the dev server reloads when the copy changes.

Fixes local mode reading no files in a normal Node process: the file system was loaded through a global `require` that only exists in a REPL.
