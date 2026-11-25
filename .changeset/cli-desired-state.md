---
"@atmyapp/cli": minor
---

The project as a file: `atmyapp export` writes `atmyapp.project.json` (secrets by name, never values), `atmyapp plan` shows what differs and `atmyapp apply` makes the project match, asking for one approval for the whole plan. Nothing is deleted without `--prune`, and sections the file leaves out aren't touched. Team from the CLI: `members invite|role|rm` and `invitations ls|revoke`. Requires the matching AtMyApp server release.
