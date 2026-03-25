import {
  compileSchema,
  defineCollection,
  defineEvent,
  defineDocument,
  defineSchema,
  getEvent,
  getCollection,
  getDocument,
  getField,
  listAssetFields,
  listEvents,
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
        events: {
          page_view: defineEvent(["page", "referrer", "timestamp"], {
            description: "Tracked page view analytics event",
          }),
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
    expect(getEvent(compiled, "page_view")?.description).toBe(
      "Tracked page view analytics event"
    );
    expect(listEvents(compiled).page_view?.columns).toEqual([
      "page",
      "referrer",
      "timestamp",
    ]);
    expect(listAssetFields(compiled, "posts")).toHaveLength(2);
    expect(listReferences(compiled)).toHaveLength(1);
    expect(listSystemFields(compiled, "posts").some((field) => field.name === "slug")).toBe(true);
  });

  it("compiles legacy .structure input into canonical collection and document definitions", () => {
    const compiled = compileSchema({
      description: "Legacy schema",
      events: {
        purchase: {
          description: "Purchase tracking event",
          columns: ["product_id", "amount"],
        },
      },
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
    expect(getEvent(compiled, "purchase")?.columns).toEqual([
      "product_id",
      "amount",
    ]);
    expect(getField(compiled, "posts.title")?.description).toBe("Post title");
    expect(getField(compiled, "settings.accent")?.optional).toBe(true);
  });

  it("emits legacy .structure compatibility output", () => {
    const schema = defineSchema({
      events: {
        signup: defineEvent(["email"], {
          description: "Signup event",
        }),
      },
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
    expect(legacy.events?.signup).toEqual({
      description: "Signup event",
      columns: ["email"],
    });
    expect(legacy.definitions.settings.description).toBe("Settings");
    expect(legacy.definitions.settings.structure?.properties?.theme?.description).toBe(
      "Theme"
    );
    expect(legacy.definitions.settings.structure?.required).toEqual(["theme"]);
  });

  it("normalizes DX-friendly scalar aliases and builder shortcuts", () => {
    const compiled = compileSchema(
      defineSchema({
        definitions: {
          settings: defineDocument({
            path: "content/site",
            fields: {
              summary: s.shortText({
                min: 10,
                max: 120,
                default: "Welcome",
              }),
              body: s.markdown({
                optional: true,
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

    const summary = getField(compiled, "settings.summary");
    const body = getField(compiled, "settings.body");
    const retries = getField(compiled, "settings.retries");

    expect(summary).toMatchObject({
      kind: "scalar",
      scalar: "string",
      format: "short",
      minLength: 10,
      maxLength: 120,
      preferredLength: 80,
      default: "Welcome",
    });
    expect(body).toMatchObject({
      kind: "scalar",
      scalar: "string",
      format: "markdown",
      preferredLength: 1200,
      optional: true,
    });
    expect(retries).toMatchObject({
      kind: "scalar",
      scalar: "number",
      format: "integer",
      minimum: 1,
      maximum: 5,
      step: 1,
      default: 3,
    });
    expect(getDocument(compiled, "settings")?.definition.path).toBe(
      "content/site.json"
    );
  });
});
