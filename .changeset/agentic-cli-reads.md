---
"@atmyapp/cli": minor
---

Read the project from the terminal or a coding agent: `atmyapp whoami`, `doctor`, `schema show`, `content ls|get|pull`, `entries ls|get`, `assets get` and `locales status`. Content is named the same way everywhere (`doc:home@de#/hero/title`, `entry:posts/8f2a`), reads show the stored, delivered, overlay or effective view, and `content pull` keeps a local copy in `.ama/content` that later pulls update with only what changed.

Every command now reads `ATMYAPP_CLI_URL` and `ATMYAPP_CLI_KEY`, prints `{ ok, data }` or `{ ok, error: { code, message, fix } }` with `--json`, uses documented exit codes, and never waits for input without a terminal. `atmyapp help --json` describes every command.

Fixes: `atmyapp snapshot` used a fixed server instead of the session's; `atmyapp init` no longer tries to create a website API key with the CLI key (it prints where to create one).
