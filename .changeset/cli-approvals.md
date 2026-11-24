---
"@atmyapp/cli": minor
---

Approvals: with a browser login or personal token, risky actions wait for your approval on your phone, in the dashboard or at a link, then continue on their own. Running the same command again finds the same request, and an action that already ran is reported with `replayed: true` instead of repeating. New common options `--no-wait` and `--approval-timeout`, `hosting deploy --no-promote` for build-only releases, and `keys create --replace` to replace a key whose secret was lost.
