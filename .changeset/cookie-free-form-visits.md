---
"@atmyapp/core": minor
"@atmyapp/astro": minor
---

Attach cookie-free current-tab visit context to form submissions. The Astro integration captures the landing source before navigation; native forms, enhanced forms and SDK submissions preserve it without cookies, persistent visitor identifiers or raw advertising click IDs. Context expires after 30 minutes of inactivity and gracefully falls back when session storage is unavailable.
