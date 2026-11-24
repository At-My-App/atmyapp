---
"@atmyapp/cli": minor
---

One contract for agents and scripts:

- Exit code `6` now means "needs a person", and `error.details.reason` says why (`confirmation`, `dns`, `browser`, `approval`, `review` or `dashboard`). New exit code `8` means a `--wait` reached its `--timeout` while the work is still running; `details.resume` keeps waiting. `hosting deploy`, `stage preview` and `domains check` use them, and `domains check --wait` reports a missing DNS change as `needs_person`.
- Every `--timeout` accepts `90s`, `5m` or `1h`, with per-command defaults and limits.
- `domains add` is safe to run twice (`unchanged: true`) and reports a domain connected to another website as `already_exists`. `domains rm --if-exists` succeeds when there's nothing to remove.
- `--project <id>` replaces `--project-id` (which still works).
- Requests carry an `X-AtMyApp-Agent` label when Claude Code runs the CLI, or as set with `ATMYAPP_AGENT`.
- `snapshot` takes the standard connection options and `--json`; `-t`, `-u` and `-p` still work for now. `snapshot download` no longer deletes its own download before extracting it.
- `migrate` and `migrate-status` take `--project`, `--url` and `--token`, and use a browser login for the same project.
- `upload` and `generate` are deprecated in favour of `files put` and the content commands.
