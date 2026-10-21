import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema(),
  }),
  // Package changelogs written by Changesets, rendered on /changelog/.
  changelogs: defineCollection({
    loader: glob({ pattern: "*/CHANGELOG.md", base: "../packages" }),
  }),
};
