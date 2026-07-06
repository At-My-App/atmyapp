# __PROJECT_DISPLAY_NAME__

An Astro + Tailwind CSS starter wired for AtMyApp. It ships with a small "Joke of the Day" site so you can see the intended project structure before replacing the sample content with your own.

## Commands

```bash
__PACKAGE_MANAGER_RUN__ dev
__PACKAGE_MANAGER_RUN__ build
__PACKAGE_MANAGER_RUN__ preview
__PACKAGE_MANAGER_RUN__ check
__PACKAGE_MANAGER_RUN__ atmyapp:dry-run
__PACKAGE_MANAGER_RUN__ atmyapp:migrate
```

## Project Structure

```txt
src/
  components/
    JokeCard.astro
  data/
    jokes.ts
  layouts/
    BaseLayout.astro
  pages/
    index.astro
    archive.astro
  styles/
    global.css
atmyapp.schema.ts
```

## AtMyApp Setup

The root `atmyapp.schema.ts` file is the source of truth for the content model. The CLI discovers this name automatically, so you can validate or upload schema changes with:

```bash
__PACKAGE_MANAGER_RUN__ atmyapp:dry-run
__PACKAGE_MANAGER_RUN__ atmyapp:migrate
```

The sample schema contains:

- `siteSettings`, a document for site-level copy
- `jokes`, a collection for joke cards

Local sample data lives in `src/data/jokes.ts`. Once your AtMyApp project has data, replace that file with calls to `@atmyapp/core` or your preferred AtMyApp data-loading pattern.

## Environment

Copy `.env.example` to `.env` when you are ready to connect the site to AtMyApp:

```env
ATMYAPP_API_KEY=your-public-api-key
ATMYAPP_BASE_URL=https://api.atmyapp.com
```

The layout uses `@atmyapp/astro` when `ATMYAPP_API_KEY` is present. Without credentials, the starter still builds as a static Astro site.
