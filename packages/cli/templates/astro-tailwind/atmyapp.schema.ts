import {
  defineCollection,
  defineDocument,
  defineSchema,
  s,
} from "@atmyapp/structure";

export default defineSchema({
  definitions: {
    siteSettings: defineDocument({
      fields: {
        title: s.string({ default: "Joke of the Day" }),
        description: s.string({
          format: "long",
          default: "A tiny Astro site powered by AtMyApp structure.",
        }),
      },
    }),
    jokes: defineCollection({
      fields: {
        number: s.number({ min: 1 }),
        setup: s.string({ min: 3 }),
        punchline: s.string({ format: "long" }),
        image: s.image({ optional: true }),
        publishedAt: s.date({ optional: true }),
      },
    }),
  },
});
