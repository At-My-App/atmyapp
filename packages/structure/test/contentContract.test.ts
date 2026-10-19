import { contentContractCorpus } from "../src/contractCorpus";
import {
  normalizeContent,
  FIELD_KINDS,
  createItemKey,
  isAssignedOnSave,
  legacyFieldToCanonical,
  validate,
  validateFieldValue,
  parseSchema,
  validateLocalizedItemIdentities,
  type DocumentDefinition,
  type FieldDefinition,
} from "../src";
const scalar: FieldDefinition = { kind: "scalar", scalar: "string" };
const definition: DocumentDefinition = {
  kind: "document",
  fields: {
    title: { ...scalar, default: "Default" },
    items: {
      kind: "array",
      items: {
        kind: "object",
        additionalProperties: false,
        fields: {
          name: scalar,
          visible: { kind: "scalar", scalar: "boolean", default: false },
        },
      },
    },
  },
};
const normalize = (value: unknown, base?: unknown, createKey = () => "n_new") =>
  normalizeContent(value, definition, {
    base,
    resourceIdentity: "site/home",
    createKey,
  });
describe("shared content contract", () => {
  test.each(contentContractCorpus)(
    "$kind accepts valid values and rejects invalid values",
    ({ field, valid, invalid }) => {
      expect(
        validateFieldValue(valid, field, "", "publish", {
          article: { components: {} },
        }),
      ).toEqual([]);
      expect(
        validateFieldValue(invalid, field, "", "publish", {
          article: { components: {} },
        }).length,
      ).toBeGreaterThan(0);
    },
  );
  it("covers all declared kinds", () =>
    expect(contentContractCorpus.map((fixture) => fixture.kind).sort()).toEqual(
      [...FIELD_KINDS].sort(),
    ));

  it("allows incomplete drafts, never invalid supplied values or missing published defaults", () => {
    expect(validate({}, definition, "draft").valid).toBe(true);
    expect(
      validate({}, definition, "publish").issues.map((i) => i.code),
    ).toEqual(["required", "required"]);
    expect(
      validate({ title: null }, definition, "draft").issues[0].severity,
    ).toBe("hard");
  });
  it("distinguishes null, absent, empty, false and zero", () => {
    expect(validateFieldValue(null, { ...scalar, nullable: true })).toEqual([]);
    expect(
      validateFieldValue(null, { ...scalar, optional: true })[0].code,
    ).toBe("invalid-type");
    expect(normalize({ title: "", items: [] }).value).toEqual({
      title: "",
      items: [],
    });
    expect(
      normalize({ items: [{ name: "new", visible: false }] }).value,
    ).toEqual({
      title: "Default",
      items: [{ _key: "n_new", name: "new", visible: false }],
    });
  });
  it("applies defaults only on creation, including a newly added list item", () => {
    expect(normalize({ items: [] }, { items: [] }).value).toEqual({
      items: [],
    });
    expect(
      normalize({ items: [{ name: "new" }] }, { items: [] }).value,
    ).toEqual({ items: [{ _key: "n_new", name: "new", visible: false }] });
  });
  it("assigns identical legacy keys to concurrent drafts from one immutable base", () => {
    const base = { title: "A", items: [{ name: "one" }, { name: "two" }] };
    const first = normalize(base, base);
    expect(normalize(base, base)).toEqual(first);
    expect(base.items[0]).toEqual({ name: "one" });
    expect(normalize(first.value, first.value).changed).toBe(false);
  });
  it("recovers omitted keys by exact base matching across reorder", () => {
    const base = {
      items: [
        { _key: "one", name: "one" },
        { _key: "two", name: "two" },
      ],
    };
    const result = normalize(
      { items: [{ name: "two" }, { name: "one" }] },
      base,
    );
    expect(result.issues).toEqual([]);
    expect((result.value as any).items.map((i: any) => i._key)).toEqual([
      "two",
      "one",
    ]);
  });
  it("rejects ambiguous dropped identities rather than guessing by position", () => {
    const base = {
      items: [
        { _key: "one", name: "same" },
        { _key: "two", name: "same" },
      ],
    };
    expect(
      normalize(
        { items: [{ name: "same" }, { name: "changed" }] },
        base,
      ).issues.every((i) => i.code === "ambiguous-identity"),
    ).toBe(true);
    expect(
      normalize({ items: [{ name: "changed" }, { name: "same" }] }, base).issues
        .length,
    ).toBeGreaterThan(0);
  });
  it("preserves explicit identities and lets declared identityField take precedence", () => {
    const schema: DocumentDefinition = {
      kind: "document",
      fields: {
        items: {
          kind: "array",
          identityField: "id",
          items: { kind: "object", fields: { id: scalar } },
        },
      },
    };
    const result = normalizeContent({ items: [{ id: "one" }] }, schema, {
      resourceIdentity: "home",
      createKey: () => {
        throw new Error("No generated key");
      },
    });
    expect(result.value).toEqual({ items: [{ id: "one" }] });
  });
  it("rejects duplicate keys and invalid JSON values", () => {
    expect(
      validate(
        {
          title: "A",
          items: [
            { _key: "a", name: "A" },
            { _key: "a", name: "B" },
          ],
        },
        definition,
      ).issues.some(
        (i) => i.code === "duplicate-identity" && i.severity === "hard",
      ),
    ).toBe(true);
    expect(
      validateFieldValue(NaN, { kind: "scalar", scalar: "number" })[0].severity,
    ).toBe("hard");
  });
  test.each(["2025-02-29", "2024-13-01", "2024-01-00"])(
    "rejects invalid calendar date %s",
    (value) =>
      expect(
        validateFieldValue(value, { kind: "scalar", scalar: "date" })[0].code,
      ).toBe("invalid-date"),
  );
  it("validates date-time, email, integer, regex and defaults", () => {
    expect(
      validateFieldValue("2024-02-29", { kind: "scalar", scalar: "date" }),
    ).toEqual([]);
    expect(
      validateFieldValue("2024-01-01T25:00:00Z", {
        kind: "scalar",
        scalar: "datetime",
      })[0].code,
    ).toBe("invalid-date");
    expect(
      validateFieldValue("nope", { ...scalar, format: "email" })[0].code,
    ).toBe("invalid-format");
    for (const field of [
      { ...scalar, pattern: "[" },
      { ...scalar, default: 5 },
      { kind: "future" },
      { ...scalar, future: true },
    ])
      expect(() =>
        parseSchema({
          version: 1,
          definitions: { home: { kind: "document", fields: { value: field } } },
        } as any),
      ).toThrow();
  });
  it("rejects collisions from the injected key generator", () => {
    expect(
      normalize({ items: [{ name: "One" }, { name: "Two" }] }).issues.some(
        (issue) => issue.code === "duplicate-identity",
      ),
    ).toBe(true);
  });
  it("keys object union arrays and checks localized source membership", () => {
    const schema: DocumentDefinition = {
      kind: "document",
      fields: {
        blocks: {
          kind: "array",
          items: {
            kind: "union",
            variants: [{ kind: "object", fields: { title: scalar } }],
          },
        },
      },
    };
    const base = {
      blocks: [
        { _key: "one", title: "One" },
        { _key: "two", title: "Two" },
      ],
    };
    expect(
      normalizeContent({ blocks: [{ title: "New" }] }, schema, {
        resourceIdentity: "home",
        createKey: () => "new",
      }).value,
    ).toEqual({ blocks: [{ _key: "new", title: "New" }] });
    expect(
      validateLocalizedItemIdentities(
        { blocks: [{ _key: "two", title: "Dwa" }] },
        schema,
        base,
      ),
    ).toEqual([]);
    expect(
      validateLocalizedItemIdentities(
        { blocks: [{ _key: "missing", title: "Oops" }] },
        schema,
        base,
      )[0].code,
    ).toBe("invalid-identity");
  });
  it("rejects unknown schema properties, versions, system fields, reserved names and invalid bounds", () => {
    for (const field of [
      { ...scalar, future: true },
      { ...scalar, minLength: -1 },
      { ...scalar, minLength: 4, maxLength: 2 },
    ])
      expect(() =>
        parseSchema({
          version: 1,
          definitions: { home: { kind: "document", fields: { value: field } } },
        } as any),
      ).toThrow();
    expect(() => parseSchema({ version: 2, definitions: {} } as any)).toThrow(
      "Unsupported schema version",
    );
    expect(() =>
      parseSchema({
        version: 1,
        definitions: { home: { kind: "document", fields: { _key: scalar } } },
      }),
    ).toThrow("reserved");
    expect(() =>
      parseSchema({
        version: 1,
        definitions: {
          home: {
            kind: "document",
            fields: {},
            systemFields: { future: true },
          },
        },
      } as any),
    ).toThrow("unknown system field");
  });
  it("rejects old draft keys after a different base established identities", () => {
    const old = normalize(
      { items: [{ name: "Before" }] },
      { items: [{ name: "Before" }] },
    ).value;
    const published = normalize(
      { items: [{ name: "After" }] },
      { items: [{ name: "After" }] },
    ).value;
    expect(
      normalize(old, published).issues.some(
        (issue) => issue.code === "invalid-identity",
      ),
    ).toBe(true);
  });
  it("selects a complete union alternative before applying creation defaults", () => {
    const schema: DocumentDefinition = {
      kind: "document",
      fields: {
        choice: {
          kind: "union",
          variants: [
            {
              kind: "object",
              fields: {
                title: scalar,
                subtitle: { ...scalar, optional: true, default: "first" },
              },
            },
            {
              kind: "object",
              fields: { count: { kind: "scalar", scalar: "number" } },
            },
          ],
        },
      },
    };
    const result = normalizeContent({ choice: { count: 1 } }, schema, {
      resourceIdentity: "home",
      createKey: () => "key",
    });
    expect(result.value).toEqual({ choice: { count: 1 } });
    expect(result.issues).toEqual([]);
  });
  it("rejects overlapping union alternatives with different creation defaults", () => {
    const schema: DocumentDefinition = {
      kind: "document",
      fields: {
        choice: {
          kind: "union",
          variants: [
            {
              kind: "object",
              fields: { color: { ...scalar, optional: true, default: "red" } },
            },
            {
              kind: "object",
              fields: { color: { ...scalar, optional: true, default: "blue" } },
            },
          ],
        },
      },
    };
    const input = { choice: {} };
    const result = normalizeContent(input, schema, {
      resourceIdentity: "home",
      createKey: () => "key",
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "ambiguous-union", severity: "hard" }),
    );
    expect(input).toEqual({ choice: {} });
  });
  it("compares list business values independently of their stable internal identities", () => {
    const field: FieldDefinition = {
      kind: "array",
      uniqueItems: true,
      items: { kind: "object", fields: { name: scalar } },
    };
    expect(
      validateFieldValue(
        [
          { _key: "a", name: "same" },
          { _key: "b", name: "same" },
        ],
        field,
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "unique-items",
        severity: "overridable",
      }),
    );
    expect(
      validateFieldValue("bad email", { ...scalar, format: "email" }),
    ).toContainEqual(
      expect.objectContaining({
        code: "invalid-format",
        severity: "overridable",
      }),
    );
    expect(validateFieldValue("Bad slug", { kind: "slug" })).toContainEqual(
      expect.objectContaining({ code: "invalid-slug", severity: "hard" }),
    );
  });
});

describe("isAssignedOnSave", () => {
  it("covers order ranks and sourced slugs only", () => {
    expect(isAssignedOnSave({ kind: "order" })).toBe(true);
    expect(isAssignedOnSave({ kind: "slug", source: "name" })).toBe(true);
    expect(isAssignedOnSave({ kind: "slug" })).toBe(false);
    expect(isAssignedOnSave({ kind: "scalar", scalar: "string" })).toBe(false);
  });
});

describe("legacy field adapter", () => {
  it("reads JSON Schema integer columns as whole numbers", () => {
    const field = legacyFieldToCanonical("count", { type: "integer" });
    expect(field).toMatchObject({ kind: "scalar", scalar: "number", integer: true });
    expect(validateFieldValue(2, field)).toEqual([]);
    expect(validateFieldValue(1.5, field)[0]?.code).toBe("invalid-integer");
    expect(validateFieldValue("2", field)[0]?.code).toBe("invalid-type");
  });
});
