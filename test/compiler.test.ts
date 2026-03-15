import {
  compileSchema,
  defineCollection,
  defineDocument,
  defineSchema,
  getCollection,
  getDocument,
  getField,
  listAssetFields,
  listReferences,
  listSystemFields,
  resolveDefinitionForPath,
  s,
  toLegacyStructure,
} from "../src";

describe("@atmyapp/structure compiler", () => {
  it("compiles canonical schema and preserves descriptions for definitions and fields", () => {
    const compiled = compileSchema(
      defineSchema({
        description: "Project schema",
        mdx: {
          blog: {
            description: "Blog MDX config",
            components: {
              Callout: {
                description: "Highlighted callout block",
                props: {
                  title: "string",
                },
              },
            },
          },
        },
        definitions: {
          posts: defineCollection({
            description: "Blog posts collection",
            fields: {
              title: s.string({
                description: "Public title for the post",
              }),
              cover: s.image({
                description: "Associated hero image",
                config: {
                  optimizeFormat: "webp",
                  maxSize: {
                    width: 1600,
                    height: 900,
                  },
                },
              }),
              author: s.reference("authors", {
                description: "Reference to the author profile",
                by: "slug",
              }),
              seo: s.object(
                {
                  title: s.string(),
                  ogImages: s.array(
                    s.image({
                      description: "Open Graph image",
                    }),
                    {
                      description: "List of OG images",
                      optional: true,
                    }
                  ),
                },
                {
                  description: "Nested SEO metadata",
                }
              ),
            },
            systemFields: {
              slug: {
                enabled: true,
                source: "title",
              },
            },
            indexes: ["title"],
          }),
          settings: defineDocument({
            description: "Single settings document",
            fields: {
              theme: s.string({
                description: "Theme selected for the site",
              }),
            },
          }),
        },
      })
    );

    expect(compiled.document.description).toBe("Project schema");
    expect(getCollection(compiled, "posts")?.description).toBe(
      "Blog posts collection"
    );
    expect(getDocument(compiled, "settings")?.description).toBe(
      "Single settings document"
    );
    const settingsDocument = getDocument(compiled, "settings");
    expect(settingsDocument?.definition.kind).toBe("document");
    expect(settingsDocument?.definition.path).toBe("settings.json");
    expect(getField(compiled, "posts.title")?.description).toBe(
      "Public title for the post"
    );
    expect(getField(compiled, "posts.seo.ogImages[]")?.description).toBe(
      "Open Graph image"
    );
    expect(resolveDefinitionForPath(compiled, "settings.json")?.kind).toBe(
      "document"
    );
    expect(resolveDefinitionForPath(compiled, "settings")?.kind).toBe("document");
    expect(listAssetFields(compiled, "posts")).toHaveLength(2);
    expect(listReferences(compiled)).toHaveLength(1);
    expect(listSystemFields(compiled, "posts").some((field) => field.name === "slug")).toBe(true);
  });

  it("compiles legacy .structure input into canonical collection and document definitions", () => {
    const compiled = compileSchema({
      description: "Legacy schema",
      definitions: {
        posts: {
          type: "collection",
          description: "Blog posts",
          structure: {
            description: "Blog posts",
            properties: {
              title: { type: "string", description: "Post title" },
              cover: { type: "string", format: "image" },
            },
            required: ["title"],
            indexes: ["title"],
          },
        },
        settings: {
          type: "jsonx",
          description: "Settings file",
          structure: {
            type: "object",
            properties: {
              theme: { type: "string", description: "Theme value" },
              accent: { type: "string", description: "Accent color" },
            },
            required: ["theme"],
          },
        },
      },
    });

    expect(getCollection(compiled, "posts")).toBeDefined();
    expect(getDocument(compiled, "settings")).toBeDefined();
    expect(getField(compiled, "posts.title")?.description).toBe("Post title");
    expect(getField(compiled, "settings.accent")?.optional).toBe(true);
  });

  it("emits legacy .structure compatibility output", () => {
    const schema = defineSchema({
      definitions: {
        settings: defineDocument({
          description: "Settings",
          fields: {
            theme: s.string({ description: "Theme" }),
            accent: s.string({ description: "Accent", optional: true }),
          },
        }),
      },
    });

    const legacy = toLegacyStructure(schema);

    expect(legacy.definitions.settings.type).toBe("jsonx");
    expect(legacy.definitions.settings.description).toBe("Settings");
    expect(legacy.definitions.settings.structure?.properties?.theme?.description).toBe(
      "Theme"
    );
    expect(legacy.definitions.settings.structure?.required).toEqual(["theme"]);
  });
});
