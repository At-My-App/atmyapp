---
"@atmyapp/cli": patch
"create-atmyapp": patch
---

The `astro-tailwind` starter registers the `atmyapp()` integration (without it, builds failed to resolve `virtual:atmyapp/config`), depends on the current `@atmyapp/astro`, `@atmyapp/core` and `@atmyapp/structure`, and its `.env.example` uses `ATMYAPP_API_URL` with the content host. `atmyapp init` now prints `ATMYAPP_API_URL` with the content (`edge`) host instead of the CLI URL, and the generated client prefers it. `atmyapp --version` reports the installed version.
