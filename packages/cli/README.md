# @atmyapp/cli

[![npm](https://img.shields.io/npm/v/@atmyapp/cli.svg)](https://www.npmjs.com/package/@atmyapp/cli)

The `atmyapp` command for [AtMyApp](https://atmyapp.com) projects. Create a website, connect it to a project, upload your schema safely, and watch form submissions arrive.

**Documentation: [docs.atmyapp.com](https://docs.atmyapp.com) · [Full CLI reference](https://docs.atmyapp.com/reference/cli/)**

## Install

```sh
npm install --save-dev @atmyapp/cli
```

Or start a new Astro website, without installing anything first:

```sh
npm create atmyapp@latest
```

## Connect a project

Copy the command from **Settings → CLI keys** in the dashboard:

```sh
npx atmyapp use --url https://api.atmyapp.com/v0/projects/<project-id> --token <cli-key>
```

The connection is saved to `.ama/session.json`, which is added to `.gitignore`. Keep CLI keys out of your repository and out of browser code. **Stage content for review** grants access to named drafts and `members`. Publishing from the CLI requires an explicit `content.publish` scope. Use `atmyapp login` to connect with a browser login.

## Edit and review content

```sh
npx atmyapp content pull
npx atmyapp space create homepage
npx atmyapp space use homepage
npx atmyapp content set doc:home#/title "Spring menu"
npx atmyapp content validate
npx atmyapp stage push --dry-run
npx atmyapp stage push
npx atmyapp stage preview
npx atmyapp stage review --to reviewer@example.com --message "Check the homepage title"
```

Run your website with `ATMYAPP_CLIENT_MODE=local` to see the active space. A reviewer can open the draft from the dashboard notification or from **Website → Drafts**.

| Command | Purpose |
| --- | --- |
| `space create/use/ls/rm/gc` | Manage local spaces and unused stored objects |
| `content edit/rm/set/patch` | Edit a local document, file or entry |
| `content status/diff/grep/validate` | Inspect and validate a space |
| `entries create/update/delete/move` | Change collection entries in a space |
| `stage push/status/ls/diff` | Upload changes and inspect named drafts |
| `stage preview/review/extend/undo/discard` | Preview and manage a draft |
| `stage commit -m <message>` | Publish the named draft with `content.publish` |
| `members ls --can content.edit` | Find people who can review |
| `content pull --session` | Import saved reviewer edits into the space |
| `init --agents` | Add the workflow to `AGENTS.md` |

Use `stage push --operation-id <id>` to resume an interrupted push. Exit code `7` indicates a draft state such as review or expiry. After publication, run `content pull` to refresh the published copy and clear staged changes that the pull confirms were published.

## Browser login, hosting and keys

| Command | Purpose |
| --- | --- |
| `login [--project <id>] [--scopes <list>]` | Approve a scoped project session in your browser |
| `logout` | Revoke the login saved on this computer |
| `hosting status`, `hosting releases ls` | Inspect website deployments, live releases, domains and publication |
| `hosting deploy [--deployment <id>] [--wait] [--timeout 15m]` | Start a build with the deployment's configured preset |
| `hosting logs <releaseId> [--follow]` | Read or follow build logs. `--json` emits NDJSON |
| `hosting promote <releaseId>` | Make a ready release live |
| `keys ls`, `keys create --name <name> --scopes <list>`, `keys revoke <id>` | Manage project keys with a login granted `keys.manage` |

Login defaults to `schema.read,content.read` and expires after 30 days. The CLI uses your OS keychain when available. The fallback is an owner-only credentials file. Command options override environment variables, then the browser login, then `.ama/session.json`.

Publishing requires an explicit `content.publish` scope. Run `stage commit -m "Update website copy" --dry-run` to inspect the draft. If publication returns warnings, exit `6` asks for a person to review them. With `--accept-warnings` in an interactive terminal, the CLI shows the warnings and asks for confirmation. A successful commit prints its SHA and projection status.

Hosting reads use `hosting.read`. Build logs also require current developer access. Deploying and promoting use `hosting.deploy`, which includes hosting reads. With `--wait`, `build_failed` and `deploy_timeout` both exit `1`. Build failures include the last accessible log lines.

`keys create` saves `ATMYAPP_CLI_KEY` to `.env.local` by default. Use `--env-file` to choose the destination. The command returns the key's hint and file path. `keys ls` displays project key hints and the existing content API key values.

## Upload your schema

Write `atmyapp.schema.ts` in the project root (or run `npx atmyapp init` for a starter), then:

```sh
npx atmyapp migrate --dry-run   # compile and validate locally
npx atmyapp migrate             # plan against the project, confirm, apply
```

`migrate` compares your schema with the content already stored and shows a plan. It asks before it changes stored content, and refuses changes that would leave content invalid. Renames and backfills are declared in an operations file:

```json
[
  { "type": "renameField", "definition": "posts", "from": "title", "to": "headline" },
  { "type": "backfillField", "definition": "posts", "field": "summary", "value": "" }
]
```

```sh
npx atmyapp migrate --operations migrations/2026-10-rename.json
```

Guide: [Change a live schema](https://docs.atmyapp.com/guides/schema-changes/).

## Commands

| Command | Does |
| --- | --- |
| `atmyapp create [name]` | Create an Astro + Tailwind website wired to AtMyApp |
| `atmyapp use` | Connect this folder to a project |
| `atmyapp whoami`, `atmyapp doctor` | Show the key and what it may do; check the whole setup |
| `atmyapp init` | Write a starter schema (`--template empty\|minimal\|blog`) |
| `atmyapp schema show [ref]` | Read the project's published schema (`--for-editing`) |
| `atmyapp content ls\|get` | List and read documents, files and entries (`doc:home@de#/hero/title`) |
| `atmyapp content pull` | Keep a local copy in `.ama/content` for offline use and local editing |
| `atmyapp entries ls\|get` | Read collection entries with cursors and repeatable `--where` filters |
| `atmyapp assets get`, `atmyapp locales status` | Download an image or file; see which translations are outdated |
| `atmyapp migrate` | Plan and apply schema changes (`--dry-run`, `--operations`, `--yes`, `--json`) |
| `atmyapp migrate-status [id]` | Check a migration whose result was lost (`--reconcile`) |
| `atmyapp submissions tail [form]` | Follow form submissions live, including rejected ones |
| `atmyapp snapshot create\|download` | Download content for offline fallback |
| `atmyapp upload`, `atmyapp generate` | Write files to project storage directly (advanced) |

Every option is documented in the [CLI reference](https://docs.atmyapp.com/reference/cli/).

## Use in CI and with coding agents

Every command reads `ATMYAPP_CLI_URL` and `ATMYAPP_CLI_KEY`, so CI and agent shells don't need `atmyapp use`:

```sh
export ATMYAPP_CLI_URL=https://api.atmyapp.com/v0/projects/<id>
export ATMYAPP_CLI_KEY=<cli-key>
npx atmyapp migrate --yes --json
npx atmyapp content get doc:home --json
```

With `--json`, commands print one `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "code", "message", "fix" } }` document on stdout and logs on stderr. `submissions tail` and `hosting logs` stream one JSON record per line. Exit codes include `3` for auth or scope, `4` for validation, `5` for conflict, and `6` for required confirmation. `atmyapp help --json` describes every command.

Use `atmyapp help content get --json` to get the output JSON Schema for a command.

## License

ISC


## Merging and assets

Run `atmyapp content refresh doc:home` to pull and merge against your saved base. If a field conflicts, run `atmyapp content resolve doc:home --take theirs --pointer /title`. The working file keeps your version until you resolve its conflicts. Run `atmyapp stage conflicts` to check the linked draft against the published head.

| Command | Purpose |
| --- | --- |
| `assets put doc:home#/hero cover.jpg --alt "Cover"` | Attach a file to an asset field |
| `files put media/menu.pdf menu.pdf` | Stage a regular storage file |
| `files put public:logo.svg logo.svg` | Stage a project public asset |
| `content rm public:logo.svg` | Stage removal of a project public asset |
| `locales export --locale de --space --status outdated -o de.json` | Export segments from the space |
| `locales import de.json` | Import translations that still match their sources |
| `content edit doc:home --locale de` and `content save doc:home@de` | Edit and save the merged translation |

`stage push` sends related content and attachments together, using 8 MiB parts for large named uploads. A pending push retains its operation ID and captured bytes. Rerun with `stage push --operation-id <id>` after an interruption. `content pull --media` also downloads public assets and gives the merge a local copy of remote binary edits.
