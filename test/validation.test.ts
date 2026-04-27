import {
  compileSchema,
  defineCollection,
  defineEvent,
  defineDocument,
  defineSystemConfig,
  defineSubmission,
  defineSchema,
  s,
  validateContent,
  validateContentAtPath,
  validateSchemaDocument,
} from "../src";

describe("@atmyapp/structure validation", () => {
  it("validates content for documents and collections", () => {
    const compiled = compileSchema(
      defineSchema({
        mdx: {
          blog: {
            components: {},
          },
        },
        events: {
          page_view: defineEvent(["page", "timestamp"]),
        },
        definitions: {
          settings: defineDocument({
            fields: {
              theme: s.string(),
              retries: s.number({ optional: true }),
              body: s.mdx({ config: "blog" }),
            },
          }),
          posts: defineCollection({
            fields: {
              title: s.string(),
              cover: s.image({ optional: true }),
            },
          }),
        },
      })
    );

    expect(
      validateContent(compiled, "settings", {
        theme: "dark",
        retries: 3,
        body: "# Hello",
      }).valid
    ).toBe(true);

    expect(
      validateContent(compiled, "posts", {
        cover: 123,
      }).valid
    ).toBe(false);

    expect(
      validateContentAtPath(
        compiled,
        "settings.json",
        JSON.stringify({ theme: "dark", retries: 2, body: "# Ok" })
      ).valid
    ).toBe(true);
  });

  it("rejects invalid schema documents including reserved field collisions and bad references", () => {
    const result = validateSchemaDocument({
      version: 1,
      definitions: {
        authors: {
          kind: "collection",
          fields: {
            name: { kind: "scalar", scalar: "string" },
          },
        },
        posts: {
          kind: "collection",
          fields: {
            id: { kind: "scalar", scalar: "string" },
            author: { kind: "reference", target: "authors", by: "slug" },
          },
        },
      },
      events: {
        page_view: {
          columns: ["page", "page"],
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.message.includes('Reserved system field "id"')
      )
    ).toBe(true);
    expect(
      result.issues.some((issue) =>
        issue.message.includes('does not expose a slug')
      )
    ).toBe(true);
    expect(
      result.issues.some((issue) =>
        issue.message.includes('Duplicate event column "page"')
      )
    ).toBe(true);
  });

  it("treats fields with defaults as optional during validation", () => {
    const compiled = compileSchema(
      defineSchema({
        definitions: {
          settings: defineDocument({
            fields: {
              theme: s.string({
                default: "sunrise",
              }),
              retries: s.integer({
                min: 1,
                max: 5,
                default: 3,
              }),
            },
          }),
        },
      })
    );

    expect(
      validateContent(compiled, "settings", {}).valid
    ).toBe(true);
  });

  it("validates submission schema fields and allows schemas without content definitions", () => {
    const result = validateSchemaDocument(
      defineSchema({
        definitions: {},
        submissions: {
          contact: defineSubmission({
            fields: {
              authorSlug: {
                kind: "reference",
                target: "authors",
                by: "slug",
              },
              body: {
                kind: "mdx",
                config: "missing",
              },
            },
          }),
        },
      })
    );

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.message.includes('Reference target "authors" does not exist')
      )
    ).toBe(true);
    expect(
      result.issues.some((issue) =>
        issue.message.includes('MDX config "missing" does not exist')
      )
    ).toBe(true);
  });

  it("validates system config content as structured document content", () => {
    const compiled = compileSchema(
      defineSchema({
        definitions: {
          astroWebsiteMetadata: defineSystemConfig({
            framework: "astro",
            systemKey: "website.metadata",
            displayName: "Website Configuration - Astro Metadata",
            path: "_SystemConfig/astro/website-metadata.json",
            managedBy: "framework_preset",
            fields: {
              title: s.string({ optional: true, default: "" }),
              jsonLd: s.object({
                optional: true,
                default: {},
                additionalProperties: true,
                fields: {},
              }),
            },
          }),
        },
      })
    );

    expect(
      validateContentAtPath(
        compiled,
        "_SystemConfig/astro/website-metadata.json",
        JSON.stringify({ title: "Hello", jsonLd: {} }),
        "application/json"
      ).valid
    ).toBe(true);

    const invalid = validateContentAtPath(
      compiled,
      "_SystemConfig/astro/website-metadata.json",
      JSON.stringify({ title: 123 }),
      "application/json"
    );

    expect(invalid.valid).toBe(false);
    expect(invalid.issues[0]?.message).toContain("Expected string");
  });
});
