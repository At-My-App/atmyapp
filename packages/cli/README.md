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

The session is saved to `.ama/session.json`, which is added to `.gitignore`. A CLI key can change your schema: keep it out of your repository and out of browser code.

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
| `atmyapp entries ls\|get` | Read collection entries, with cursors |
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

With `--json`, a command prints one `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "code", "message", "fix" } }` document on stdout and logs on stderr. Exit codes say what went wrong (`3` auth or scope, `4` validation, `5` conflict, `6` needs confirmation); `atmyapp help --json` describes every command. Without a terminal, commands never wait for input; plans that change stored content need `--yes`. Review them first.

Use `atmyapp help content get --json` to get the output JSON Schema for a command.

## License

ISC
