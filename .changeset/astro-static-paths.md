---
"@atmyapp/astro": minor
---

`getAtMyApp()` can be called without Astro's context, for build-time code such as `getStaticPaths()`: `getAtMyApp({ schema }).collections.list("posts")`. It works in static builds; in dynamic mode it throws, because previews need the request.
