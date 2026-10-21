# create-atmyapp

Start a new website for an [AtMyApp](https://atmyapp.com) project.

```sh
npm create atmyapp@latest
npm create atmyapp@latest my-site
```

You get an Astro + Tailwind CSS site with [`@atmyapp/astro`](https://www.npmjs.com/package/@atmyapp/astro) installed, a starter `atmyapp.schema.ts`, two pages, and scripts for uploading the schema.

Then:

1. Copy `.env.example` to `.env` and fill in the Project API URL and API key from **Settings → API keys**.
2. Connect the CLI with the command from **Settings → CLI keys**.
3. Run `npm run atmyapp:migrate` and `npm run dev`.

Options such as `--pm pnpm`, `--no-git` and `--yes` are listed in the [CLI reference](https://docs.atmyapp.com/reference/cli/#atmyapp-create). For a guided walkthrough, follow the [Astro tutorial](https://docs.atmyapp.com/guides/astro/).
