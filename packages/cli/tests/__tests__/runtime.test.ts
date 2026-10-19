import {
  compileCanonicalSource,
  runCanonicalMigrate,
  uploadStructure,
} from "../../src/index";
import { uploadDefinitions } from "../../src/cli/utils/upload";

describe("CLI runtime canonical APIs", () => {
  it("uploads the canonical contract without a lossy legacy conversion or audit timestamp", async () => {
    const schema = {
      version: 1 as const,
      definitions: {
        home: {
          kind: "document" as const,
          path: "content/home.json",
          fields: {
            title: {
              kind: "scalar" as const,
              scalar: "string" as const,
              unique: true,
              preferredLength: 70,
              ui: { label: "Headline" },
            },
          },
        },
      },
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true }),
      });
    const result = await runCanonicalMigrate({
      schema,
      upload: true,
      url: "https://atmyapp.test",
      fetchImplementation: fetchMock,
    });
    const persisted = JSON.parse(
      JSON.parse(fetchMock.mock.calls[0][1].body).content,
    );
    expect(persisted.version).toBe(1);
    expect(persisted.definitions.home).toMatchObject(schema.definitions.home);
    expect(persisted.metadata).toBeUndefined();
    expect(persisted.definitions.home.type).toBeUndefined();
    const repeated = await runCanonicalMigrate({ schema, dryRun: true });
    expect(repeated.output).toEqual(result.output);
  });
  const code = `
    import { defineDocument, defineSchema, s } from "@atmyapp/structure";

    export default defineSchema({
      definitions: {
        settings: defineDocument({
          fields: {
            theme: s.string(),
          },
        }),
      },
    });
  `;

  it("compiles canonical source without the command layer", () => {
    const result = compileCanonicalSource({
      filename: "atmyapp.schema.ts",
      code,
    });

    expect(result.schema?.definitions.settings.kind).toBe("document");
    expect(result.compiled?.definitionsByName.settings.kind).toBe("document");
    expect(result.output?.definitions.settings.kind).toBe("document");
    expect(result.validation.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("supports named schema exports", () => {
    const result = compileCanonicalSource({
      filename: "atmyapp.schema.ts",
      code: `
        import { defineDocument, defineSchema, s } from "@atmyapp/structure";

        export const schema = defineSchema({
          definitions: {
            settings: defineDocument({
              fields: {
                theme: s.string(),
              },
            }),
          },
        });
      `,
    });

    expect(result.schema?.definitions.settings.kind).toBe("document");
    expect(result.errors).toEqual([]);
  });

  it("supports the DX-friendly composite s namespace in canonical source files", () => {
    const result = compileCanonicalSource({
      filename: "atmyapp.schema.ts",
      code: `
        import { defineDocument, defineSchema, s } from "@atmyapp/structure";

        export default defineSchema({
          definitions: {
            settings: defineDocument({
              fields: {
                seo: s.object({
                  optional: true,
                  description: "SEO settings",
                  fields: {
                    title: s.string(),
                    tags: s.array({
                      optional: true,
                      items: s.string(),
                    }),
                  },
                }),
              },
            }),
          },
        });
      `,
    });

    expect(result.schema?.definitions.settings.kind).toBe("document");
    expect(result.compiled?.fieldsByPath["settings.seo"]?.field.optional).toBe(
      true,
    );
    expect(
      result.compiled?.fieldsByPath["settings.seo.tags"]?.description,
    ).toBe(undefined);
    expect(result.errors).toEqual([]);
  });

  it("runs canonical migrate in dry-run mode", async () => {
    const compiled = compileCanonicalSource({
      filename: "atmyapp.schema.ts",
      code,
    });

    if (!compiled.schema) {
      throw new Error("Expected schema to compile");
    }

    const result = await runCanonicalMigrate({
      schema: compiled.schema,
      config: { description: "Runtime migrate test" },
      dryRun: true,
    });

    expect(result.output.description).toBe("Runtime migrate test");
    expect(result.output.definitions.settings).toBeDefined();
    expect(result.errors).toEqual([]);
  });

  it("includes submissions in generated canonical output", () => {
    const result = compileCanonicalSource({
      filename: "atmyapp.schema.ts",
      code: `
        import { defineSchema, defineSubmission, s } from "@atmyapp/structure";

        export default defineSchema({
          definitions: {},
          submissions: {
            contact: defineSubmission({
              description: "Main contact form",
              fields: {
                email: s.email(),
              },
              captcha: {
                required: true,
                provider: "hcaptcha",
                  },
            }),
          },
        });
      `,
    });

    expect(result.output?.submissions).toEqual({
      contact: {
        description: "Main contact form",
        fields: {
          email: expect.objectContaining({
            kind: "scalar",
            scalar: "string",
            format: "email",
          }),
        },
        captcha: { required: true, provider: "hcaptcha" },
      },
    });
  });

  it("preserves project localization in generated and uploaded structure output", async () => {
    const result = compileCanonicalSource({
      filename: "atmyapp.schema.ts",
      code: `
        import { defineSchema } from "@atmyapp/structure";

        export default defineSchema({
          definitions: {},
          localization: {
            enabled: true,
          },
        });
      `,
    });

    expect(result.output?.localization).toEqual({ enabled: true });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    });

    await uploadStructure({
      output: result.output!,
      url: "https://edge.atmyapp.test",
      fetchImplementation: fetchMock as unknown as typeof fetch,
    });

    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(JSON.parse(body.content).localization).toEqual({ enabled: true });
  });

  it("parses destructive migration conflicts from upload responses", async () => {
    const result = await uploadStructure({
      output: {
        version: 1,
        description: "Runtime migrate test",
        definitions: {},
        events: {},
        args: {},
      },
      url: "https://edge.atmyapp.test",
      token: "cli-ama-valid",
      fetchImplementation: jest.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({
            success: false,
            data: {
              code: "DESTRUCTIVE_STRUCTURE_CHANGE_REQUIRES_CLEAR",
              branch: "main",
              issues: [
                {
                  kind: "column_removal",
                  collectionName: "posts",
                  columnName: "seoTitle",
                  message:
                    "Column posts.seoTitle still contains data and cannot be removed yet.",
                },
              ],
              suggestedClear: {
                collections: [],
                contentFiles: [],
                columns: [
                  {
                    collection: "posts",
                    columns: ["seoTitle"],
                  },
                ],
              },
              migration: {
                changes: [],
                actions: [],
                prompts: [
                  {
                    title: "Clear posts.seoTitle first",
                    message:
                      "Remove or clear stored values before deleting the field from the schema.",
                    actionType: "clear_column",
                    fieldPath: "posts.seoTitle",
                  },
                ],
                blocking: true,
              },
            },
            error:
              "Structure update blocked because it would hide existing collection data.",
          }),
      }) as unknown as typeof fetch,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toContain("Structure update blocked");
    expect(result.conflict?.code).toBe(
      "DESTRUCTIVE_STRUCTURE_CHANGE_REQUIRES_CLEAR",
    );
    expect(result.conflict?.branch).toBe("main");
    expect(result.conflict?.suggestedClear.columns).toEqual([
      {
        collection: "posts",
        columns: ["seoTitle"],
      },
    ]);
  });

  it("includes the clear payload when uploading a structure", async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await uploadStructure({
        output: {
          version: 1,
          description: "Runtime migrate test",
          definitions: {},
          events: {},
          args: {},
          submissions: {
            contact: {
              description: "Contact form",
              fields: {},
              requiresCaptcha: true,
            },
          },
        },
        url: "https://edge.atmyapp.test",
        token: "cli-ama-valid",
        clear: {
          collections: ["posts"],
          contentFiles: ["homepage"],
          columns: [
            {
              collection: "authors",
              columns: ["bio"],
            },
          ],
        },
      });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://edge.atmyapp.test/storage/structure",
        expect.objectContaining({
          body: JSON.stringify({
            content: JSON.stringify({
              version: 1,
              description: "Runtime migrate test",
              definitions: {},
              events: {},
              args: {},
              submissions: {
                contact: {
                  description: "Contact form",
                  fields: {},
                  requiresCaptcha: true,
                },
              },
            }),
            clear: {
              collections: ["posts"],
              contentFiles: ["homepage"],
              columns: [
                {
                  collection: "authors",
                  columns: ["bio"],
                },
              ],
            },
          }),
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns the conflict result unchanged from uploadDefinitions", async () => {
    const originalFetch = global.fetch;

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          success: false,
          data: {
            code: "DESTRUCTIVE_STRUCTURE_CHANGE_REQUIRES_CLEAR",
            branch: "preview",
            issues: [],
            suggestedClear: {
              collections: ["posts"],
              contentFiles: [],
              columns: [],
            },
          },
          error:
            "Structure update blocked because it would hide existing collection data.",
        }),
    }) as unknown as typeof fetch;

    try {
      const result = await uploadDefinitions(
        {
          version: 1,
          description: "Runtime migrate test",
          definitions: {},
          events: {},
          args: {},
          submissions: {
            contact: {
              description: "Contact form",
              fields: {},
              requiresCaptcha: true,
            },
          },
        },
        {
          url: "https://edge.atmyapp.test",
          token: "cli-ama-valid",
        },
        {
          info: jest.fn(),
          success: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          verbose_log: jest.fn(),
        } as any,
        {
          collections: ["posts"],
          contentFiles: [],
          columns: [],
        },
      );

      expect(result.success).toBe(false);
      expect(result.conflict?.branch).toBe("preview");
      expect(result.conflict?.suggestedClear.collections).toEqual(["posts"]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
