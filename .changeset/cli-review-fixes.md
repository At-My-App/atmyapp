---
"@atmyapp/cli": patch
---

Safer retries and downloads: inbox changes and deploys get their own operation IDs, so an interrupted run resumes the same action while the next run is a new one (read, unread, read again all apply; `--command-id` replaces `--note-id`). Erasing asks one approval per form and keeps the approval link (exit 6). Resume instructions never include a `--token`. `snapshot download` refuses unsafe folders and keeps the previous snapshot when extraction fails. `projects create` finds a project an interrupted run created, even on the last free slot.
