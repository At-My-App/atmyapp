---
"@atmyapp/core": patch
"@atmyapp/astro": patch
"@atmyapp/cli": patch
---

Local mode images and files now load in the browser: the Astro dev server serves `.ama/content` at `/__atmyapp/content/`, and the client returns URLs on that route (set `ATMYAPP_LOCAL_ASSET_BASE` with other frameworks) instead of `file://` URLs, which browsers refuse on web pages. `$file` values that point outside the local store are no longer turned into URLs. Incremental `content pull` now hard-links unchanged files instead of copying the whole local copy.
