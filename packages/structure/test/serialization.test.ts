import {
  compileSchema,
  parseSchema,
  serializeSchema,
  type SchemaDocument,
} from "../src";

const schema: SchemaDocument = {
  version: 1,
  definitions: {
    home: {
      kind: "document",
      path: "content/home.json",
      fields: {
        title: {
          kind: "scalar",
          scalar: "string",
          unique: true,
          preferredLength: 80,
          ui: { label: "Headline" },
        },
        price: { kind: "scalar", scalar: "number", integer: true, step: 5 },
        sections: {
          kind: "array",
          identityField: "uid",
          items: {
            kind: "object",
            fields: { uid: { kind: "scalar", scalar: "string" } },
          },
        },
        image: {
          kind: "asset",
          assetKind: "image",
          deletePolicy: "detach",
          orphanPolicy: "allow",
        },
      },
    },
    logo: { kind: "image", path: "branding/logo.png", config: { width: 200 } },
  },
};

describe("canonical schema serialization", () => {
  it("imports the historical implicit string slug without creating conflicting canonical declarations", () => {
    const legacy = {
      definitions: {
        posts: {
          type: "collection" as const,
          structure: { properties: { slug: { type: "string" } } },
        },
      },
    };
    const converted = parseSchema(legacy);
    expect(
      converted.definitions.posts.kind === "collection" &&
        converted.definitions.posts.fields.slug,
    ).toMatchObject({ kind: "slug", generated: true, immutable: true });
    expect(serializeSchema(converted)).toBe(serializeSchema(legacy));
  });
  it("preserves canonical semantics through persisted JSON and recompilation", () => {
    const normalized = parseSchema(schema);
    const stored = JSON.parse(serializeSchema(schema));
    expect(compileSchema(stored).document).toEqual(normalized);
    expect(stored.definitions.home.path).toBe("content/home.json");
    expect(stored.definitions.home.fields.title).toMatchObject(
      schema.definitions.home.kind === "document"
        ? schema.definitions.home.fields.title
        : {},
    );
    expect(stored.definitions.logo.path).toBe("branding/logo.png");
  });

  it("ignores envelope metadata and object key order, but keeps UI and value changes significant", () => {
    expect(
      serializeSchema({
        ...schema,
        metadata: { generatedAt: "later" },
      } as SchemaDocument),
    ).toBe(serializeSchema(schema));
    expect(
      serializeSchema({ definitions: schema.definitions, version: 1 }),
    ).toBe(serializeSchema(schema));
    const changed = JSON.parse(JSON.stringify(schema));
    changed.definitions.home.fields.title.ui.label = "Changed";
    expect(serializeSchema(changed)).not.toBe(serializeSchema(schema));
  });

  it("gives legacy input and its normalized canonical conversion the same contract identity", () => {
    const legacy = {
      definitions: {
        home: {
          type: "jsonx" as const,
          structure: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
      metadata: { generatedAt: "before" },
    };
    expect(serializeSchema(legacy)).toBe(serializeSchema(parseSchema(legacy)));
  });

  it("reads stored legacy artifacts that carry version 1", () => {
    const stored = {
      version: 1,
      definitions: {
        home: {
          type: "jsonx" as const,
          structure: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      },
    };
    expect(parseSchema(stored as any).definitions.home.kind).toBe("document");
    expect(() =>
      parseSchema({
        version: 1,
        definitions: { home: { type: "jsonx", kind: "document", fields: {} } },
      } as any),
    ).toThrow();
  });
  it("rejects unsupported versions and colliding aliases before persistence", () => {
    expect(() =>
      parseSchema({ ...schema, version: 99 } as unknown as SchemaDocument),
    ).toThrow("Unsupported schema version");
    expect(() =>
      compileSchema({
        version: 1,
        definitions: {
          a: { kind: "document", path: "same.json", fields: {} },
          b: { kind: "document", path: "same.json", fields: {} },
        },
      }),
    ).toThrow("shared");
  });

  it("rejects public submission secrets in canonical and legacy input", () => {
    expect(() =>
      parseSchema({
        version: 1,
        definitions: {},
        submissions: {
          contact: {
            fields: {},
            captcha: { required: true, secret: "private" },
          },
        },
      } as unknown as SchemaDocument),
    ).toThrow("configured on the server");
    expect(() =>
      parseSchema({
        definitions: {},
        submissions: { contact: { fields: {}, hcaptchaSecret: "private" } },
      } as unknown as SchemaDocument),
    ).toThrow("configured on the server");
  });
});
