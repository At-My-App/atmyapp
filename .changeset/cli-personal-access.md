---
"@atmyapp/cli": minor
---

Personal access across projects:

- `atmyapp login` can reach all your projects, chosen organisations or chosen projects, as you pick on the browser page. `--preset everything|developer|editor|read-only` asks for a preset; without one the login is read-only. Logins last 90 days, renew while in use (the CLI saves the new expiry), and end after a year at most.
- New `projects ls`, `projects show`, `projects use <id|name>`, `projects create <name> --org <org> [--use]` (safe to run twice) and `orgs ls [--can-create]`.
- New `atmyapp status`: websites, domains needing attention, open drafts and next steps; parts the credential can't read are marked unavailable.
- Commands choose their project from `--project`, `ATMYAPP_PROJECT_ID`, `.ama/session.json`, then the project last chosen with `projects use`.
- Personal tokens (`ama_pt_…`, from Account → Personal tokens) work like a login when set as `ATMYAPP_CLI_KEY`.
- `whoami` shows the credential kind, its reach and expiry, even before a project is chosen.
- `keys create --preset ci-deploy|ci-content|forms-feed|read-only`.
