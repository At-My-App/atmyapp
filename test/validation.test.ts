import {
  compileSchema,
  defineCollection,
  defineDocument,
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
        definitions: {
          settings: defineDocument({
            fields: {
              theme: s.string(),
              retries: s.number({ optional: true }),
              body: s.mdx("blog"),
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
  });
});
