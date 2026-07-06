# AtMyApp Docs

This package contains the AtMyApp documentation site served at
`https://docs.atmyapp.com`.

It is an Astro Starlight app inside the monorepo. The package is intentionally
private so it participates in workspace builds and CI but is never published to
npm.

## Run Locally

Run commands from the repository root:

```sh
npx --yes pnpm@10.28.2 --filter @atmyapp/docs dev
```

Useful scripts:

```sh
npx --yes pnpm@10.28.2 --filter @atmyapp/docs build
npx --yes pnpm@10.28.2 --filter @atmyapp/docs test
npx --yes pnpm@10.28.2 --filter @atmyapp/docs preview
```

The `build` script runs `astro check` and `astro build`. The `test` script runs
`astro check`.

## Project Structure

- `src/content/docs/` contains docs pages. Each `.mdx` file becomes a route.
- `src/components/home/` contains custom home page components.
- `src/components/shell/` contains Starlight shell overrides.
- `src/styles/custom.css` contains the branded light and dark theme styling.
- `src/assets/` contains docs-only assets, including the logo.
- `public/CNAME` configures the GitHub Pages custom domain.
- `astro.config.mjs` configures Starlight, navigation, sidebars, component
  overrides, and LLM outputs.

## Add Or Update Content

Create or edit MDX files in `src/content/docs/`.

Example:

```mdx
---
title: New Guide
description: A short description for search, SEO, and generated indexes.
---

# New Guide

Write the guide content here.
```

Routes are based on file paths:

- `src/content/docs/quick-start.mdx` -> `/quick-start/`
- `src/content/docs/guides/cli.mdx` -> `/guides/cli/`
- `src/content/docs/reference/core.mdx` -> `/reference/core/`

After adding a new page, update `sidebar` in `astro.config.mjs` if the page
should appear in the Starlight sidebar.

If the page belongs in the custom left sidebar or top nav, also update the shell
components:

- `src/components/shell/Sidebar.astro`
- `src/components/shell/Header.astro`

## Expand The Home Page

The docs home route is `src/content/docs/index.mdx`, but most of the custom
layout lives in `src/components/home/DocsHome.astro`.

Use that component for home-specific sections such as:

- getting started cards
- guide groups
- product-specific callouts
- links to examples and references

Keep long-form documentation in MDX pages instead of putting it directly in the
home component.

## Customize The Shell

The docs use Starlight component overrides configured in `astro.config.mjs`.

Current overrides:

- `Header`
- `PageFrame`
- `PageSidebar`
- `PageTitle`
- `Sidebar`
- `TwoColumnContent`

Prefer small, focused changes to these components. Use `custom.css` for visual
styling and keep component markup as simple as possible.

When changing layout, check both desktop and mobile widths. The custom shell has
separate behavior for:

- desktop sidebar and right rail
- mobile top bar
- mobile menu toggle
- article action buttons
- code block overflow

## LLM-Friendly Outputs

The site uses `@wave-rf/starlight-llm-tools`.

Build output includes:

- `/llms.txt`
- `/llms-full.txt`
- `/llms-small.txt`
- per-page Markdown twins such as `/quick-start.md`

The plugin is configured with `injectInto: false` because `PageTitle.astro`
renders the copy/open-with-AI controls manually. If you remove the custom page
title, revisit that setting.

After changing docs content, run a build and verify the generated files exist:

```sh
npx --yes pnpm@10.28.2 --filter @atmyapp/docs build
test -f docs/dist/llms.txt
test -f docs/dist/llms-full.txt
test -f docs/dist/llms-small.txt
```

## Deployment

Docs deploy separately from npm package publishing.

The GitHub Pages workflow is `.github/workflows/deploy-docs.yml`. It builds this
package and deploys `docs/dist`.

Deployment assumptions:

- GitHub Pages source is set to GitHub Actions.
- `docs/public/CNAME` contains `docs.atmyapp.com`.
- DNS has a `docs.atmyapp.com` CNAME pointing to the GitHub Pages host.

## Before Merging

Run:

```sh
npx --yes pnpm@10.28.2 --filter @atmyapp/docs build
npx --yes pnpm@10.28.2 --filter @atmyapp/docs test
npx --yes pnpm@10.28.2 run ci
```

For visual changes, also preview locally and check:

- home page on desktop and mobile
- an article page on desktop and mobile
- light and dark themes
- mobile menu
- search button
- generated LLM action buttons
- long code blocks on mobile
