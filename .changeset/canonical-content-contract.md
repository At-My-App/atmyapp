---
"@atmyapp/structure": minor
"@atmyapp/cli": minor
---

Persist the normalized canonical schema directly from the CLI. Preserve paths and field metadata, remove generated audit timestamps from schema output, reject colliding aliases and unsupported versions, and expose deterministic contract serialization. Public submission schemas no longer accept secret literals; configure those on the server. The CLI includes TypeScript as a runtime dependency and accurately reports that removed-column values are retained.
