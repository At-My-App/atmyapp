import {
  compileSchema,
  type DefinitionType,
  defineCollection,
  defineEvent,
  defineDocument,
  defineSystemConfig,
  defineSubmission,
  defineSchema,
  frameworkPresets,
  frameworkSystemConfigs,
  getEvent,
  getCollection,
  getDocument,
  getField,
  getSubmission,
  listAssetFields,
  listEvents,
  listSubmissions,
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
              author: s.reference({
                target: "authors",
                description: "Reference to the author profile",
                by: "slug",
              }),
              seo: s.object({
                description: "Nested SEO metadata",
                fields: {
                  title: s.string(),
                  ogImages: s.array({
                    items: s.image({
                      description: "Open Graph image",
                    }),
                    description: "List of OG images",
                    optional: true,
                  }),
                },
              }),
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
      localize: true,
    });
    expect(body).toMatchObject({
      kind: "scalar",
      scalar: "string",
      format: "markdown",
      preferredLength: 1200,
      localize: true,
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

  it("preserves localization metadata through canonical and legacy compilation", () => {
    const schema = defineSchema({
      localization: { enabled: true },
      definitions: {
        menu: defineDocument({
          localize: true,
          fields: {
            title: s.shortText(),
            rawCode: s.string(),
            items: s.array({
              identityField: "id",
              items: s.object({
                fields: {
                  id: s.string(),
                  label: s.longText(),
                },
              }),
            }),
          },
        }),
      },
    });

    const compiled = compileSchema(schema);
    const legacy = toLegacyStructure(schema);
    const roundTrip = compileSchema(legacy);

    expect(compiled.document.localization).toEqual({ enabled: true });
    expect(getDocument(compiled, "menu")?.definition.localize).toBe(true);
    expect(getField(compiled, "menu.title")?.localize).toBe(true);
    expect(getField(compiled, "menu.rawCode")?.localize).toBeUndefined();
    expect(getField(compiled, "menu.items")).toMatchObject({
      kind: "array",
      identityField: "id",
    });
    expect(legacy.localization).toEqual({ enabled: true });
    expect(legacy.definitions.menu.localize).toBe(true);
    expect(roundTrip.document.localization).toEqual({ enabled: true });
    expect(getField(roundTrip, "menu.items")).toMatchObject({
      kind: "array",
      identityField: "id",
    });
  });

  it("supports DX-friendly composite field inputs on s", () => {
    const schema = defineSchema({
      mdx: {
        blog: {
          components: {},
        },
      },
      events: {
        signup: defineEvent({
          columns: ["email"],
          description: "Signup event",
        }),
      },
      definitions: {
        authors: defineCollection({
          fields: {
            name: s.string(),
          },
          systemFields: {
            slug: {
              enabled: true,
              source: "name",
            },
          },
        }),
        posts: defineCollection({
          fields: {
            title: s.string(),
            seo: s.object({
              description: "SEO block",
              optional: true,
              fields: {
                summary: s.string({
                  optional: true,
                  description: "SEO summary",
                }),
                tags: s.array({
                  description: "SEO tags",
                  optional: true,
                  items: s.string(),
                }),
              },
            }),
            status: s.enum({
              values: ["draft", "published"] as const,
              optional: true,
              description: "Publishing status",
            }),
            body: s.union({
              description: "Flexible body content",
              variants: [s.markdown(), s.mdx({ config: "blog" })],
            }),
            author: s.reference({
              target: "authors",
              by: "slug",
              optional: true,
              description: "Author lookup",
            }),
          },
        }),
      },
    });

    type PostEntry = DefinitionType<(typeof schema)["definitions"]["posts"]>;

    const validPost: PostEntry = {
      title: "Hello",
      body: "# Hello",
      seo: {
        tags: ["launch"],
      },
    };

    expect(validPost.seo?.tags).toEqual(["launch"]);

    // @ts-expect-error body is required
    const invalidPost: PostEntry = {
      title: "Missing body",
    };

    void invalidPost;

    const compiled = compileSchema(schema);
    const legacy = toLegacyStructure(schema);

    expect(getField(compiled, "posts.seo")?.description).toBe("SEO block");
    expect(getField(compiled, "posts.seo")?.optional).toBe(true);
    expect(getField(compiled, "posts.seo.tags")?.description).toBe("SEO tags");
    expect(getField(compiled, "posts.status")?.optional).toBe(true);
    expect(getField(compiled, "posts.author")?.description).toBe("Author lookup");
    expect(getEvent(compiled, "signup")?.description).toBe("Signup event");
    expect(legacy.definitions.posts.structure?.properties?.seo?.description).toBe(
      "SEO block"
    );
    expect(legacy.definitions.posts.structure?.properties?.seo?.properties?.tags?.description).toBe(
      "SEO tags"
    );
    expect(legacy.definitions.posts.structure?.required).toEqual([
      "title",
      "body",
    ]);
  });

  it("normalizes first-class submissions and preserves legacy compatibility output", () => {
    const schema = defineSchema({
      definitions: {
        settings: defineDocument({
          fields: {
            title: s.string(),
          },
        }),
      },
      submissions: {
        contact: defineSubmission({
          description: "Main contact form",
          fields: {
            name: s.string(),
            email: s.email(),
            message: s.longText({
              optional: true,
            }),
            resume: s.file({
              optional: true,
            }),
          },
          captcha: {
            required: true,
            provider: "hcaptcha",
            secret: "secret",
          },
        }),
      },
    });

    const compiled = compileSchema(schema);
    const legacy = toLegacyStructure(schema);

    expect(getSubmission(compiled, "contact")).toEqual({
      description: "Main contact form",
      fields: {
        name: expect.objectContaining({ kind: "scalar", scalar: "string" }),
        email: expect.objectContaining({
          kind: "scalar",
          scalar: "string",
          format: "email",
        }),
        message: expect.objectContaining({ optional: true }),
        resume: expect.objectContaining({ kind: "asset", assetKind: "file" }),
      },
      captcha: {
        required: true,
        provider: "hcaptcha",
        secret: "secret",
      },
    });
    expect(listSubmissions(compiled).contact?.captcha?.required).toBe(true);
    expect(legacy.submissions?.contact).toMatchObject({
      description: "Main contact form",
      requiresCaptcha: true,
      captchaProvider: "hcaptcha",
      hcaptchaSecret: "secret",
    });
  });

  it("compiles framework-managed system config definitions", () => {
    const schema = defineSchema({
      definitions: {
        astroWebsiteMetadata: frameworkSystemConfigs.astro.websiteMetadata,
        customSystemConfig: defineSystemConfig({
          framework: "astro",
          systemKey: "custom.config",
          displayName: "Custom System Config",
          path: "_SystemConfig/astro/custom.json",
          managedBy: "framework_preset",
          fields: {
            label: s.string({ optional: true, default: "" }),
          },
        }),
      },
    });

    const compiled = compileSchema(schema);
    const resolved = resolveDefinitionForPath(
      compiled,
      "_SystemConfig/astro/website-metadata.json",
      "application/json"
    );
    const legacy = toLegacyStructure(schema);

    expect(frameworkPresets.astro.systemConfigDefinitions).toEqual([
      "astroWebsiteMetadata",
    ]);
    expect(resolved?.kind).toBe("system_config");
    expect(resolved?.definition).toMatchObject({
      framework: "astro",
      systemKey: "website.metadata",
      displayName: "Website Configuration - Astro Metadata",
      managedBy: "framework_preset",
    });
    expect(getField(compiled, "astroWebsiteMetadata.title")?.optional).toBe(
      true
    );
    expect(legacy.definitions.astroWebsiteMetadata).toMatchObject({
      type: "system_config",
      framework: "astro",
      systemKey: "website.metadata",
      displayName: "Website Configuration - Astro Metadata",
      path: "_SystemConfig/astro/website-metadata.json",
      managedBy: "framework_preset",
    });
  });
});
