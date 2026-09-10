import {
  defineCollection,
  defineSchema,
  s,
  compileSchema,
  validateSchemaDocument,
  normalizeSlug,
  generateUniqueSlug,
  placeEntry,
  prepareCollectionMutation,
  validateCollectionSnapshot,
} from "../src";

const schema = defineSchema({
  definitions: {
    categories: defineCollection({
      fields: {
        name: s.string(),
        slug: s.slug({ source: "name" }),
        order: s.order(),
      },
    }),
    dishes: defineCollection({
      fields: {
        category: s.reference("categories", { by: "slug" }),
        order: s.order({ groupBy: "category" }),
        featured: s.order(),
      },
    }),
  },
});

test("normalizes international labels and generates bounded collision suffixes", () => {
  expect(normalizeSlug("Żółć & Crème brûlée")).toBe("zolc-creme-brulee");
  expect(generateUniqueSlug("Pizza", new Set(["pizza", "pizza-2"]))).toBe(
    "pizza-3",
  );
  expect(
    generateUniqueSlug("a".repeat(96), new Set(["a".repeat(96)])),
  ).toHaveLength(96);
  expect(() => generateUniqueSlug("🍕", new Set())).toThrow();
});

test("round trips ordering and infers independent groups", () => {
  const compiled = compileSchema(schema);
  expect(compiled.definitionsByName.dishes.definition).toMatchObject({
    fields: { order: { kind: "order", groupBy: "category" } },
  });
  expect(
    compileSchema(compiled.legacyStructure).definitionsByName.dishes.definition,
  ).toMatchObject({
    fields: { order: { kind: "order", groupBy: "category" } },
  });
  expect(validateSchemaDocument(schema).valid).toBe(true);
});

test.each([
  s.string(),
  s.reference("categories", { multiple: true }),
  s.number(),
])("rejects unsupported grouping", (group) => {
  expect(
    validateSchemaDocument(
      defineSchema({
        definitions: {
          ...schema.definitions,
          dishes: defineCollection({
            fields: {
              category: group,
              order: s.order({ groupBy: "category" }),
            },
          }),
        },
      }),
    ).valid,
  ).toBe(false);
});

test("rebalances exhausted gaps, handles fresh entries and rejects invalid anchors", () => {
  expect(
    placeEntry(
      [
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
        { id: "c", rank: 3 },
      ],
      "c",
      { position: "after", entryId: "a" },
    ),
  ).toEqual({ a: 1024, c: 2048, b: 3072 });
  expect(
    placeEntry([{ id: "a", rank: 1024 }, { id: "b" }], "b", {
      position: "last",
    }),
  ).toEqual({ b: 2048 });
  expect(
    placeEntry([{ id: "a", rank: 1024 }], "a", { position: "first" }),
  ).toEqual({});
  expect(() =>
    placeEntry([{ id: "a", rank: 1 }], "a", {
      position: "after",
      entryId: "missing",
    }),
  ).toThrow();
  expect(() =>
    placeEntry([{ id: "a", rank: 1 }], "a", {
      position: "after",
      entryId: "a",
    }),
  ).toThrow();
});

test("allows unpublished targets, restricts deletion and locks saved slugs", () => {
  const categories = prepareCollectionMutation(
    schema,
    {},
    { collection: "categories", entryId: "c", data: { name: "Pasta" } },
  );
  const dishes = prepareCollectionMutation(schema, categories, {
    collection: "dishes",
    entryId: "d",
    data: { category: "pasta" },
  });
  expect(dishes.dishes.d).toEqual({
    category: "pasta",
    order: 1024,
    featured: 1024,
  });
  expect(() =>
    prepareCollectionMutation(schema, dishes, {
      collection: "categories",
      entryId: "c",
    }),
  ).toThrow(/missing/);
  expect(() =>
    prepareCollectionMutation(schema, dishes, {
      collection: "categories",
      entryId: "c",
      data: { ...dishes.categories.c, slug: "other" },
    }),
  ).toThrow(/cannot change/);
  expect(validateCollectionSnapshot(schema, { dishes: dishes.dishes })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "invalid-reference" }),
    ]),
  );
  expect(categories.dishes).toBeUndefined();
});

test("supports deletion followed by slug reuse and rejects raw ranks", () => {
  let state = prepareCollectionMutation(
    schema,
    {},
    { collection: "categories", entryId: "a", data: { name: "Pasta" } },
  );
  state = prepareCollectionMutation(schema, state, {
    collection: "categories",
    entryId: "a",
  });
  state = prepareCollectionMutation(schema, state, {
    collection: "categories",
    entryId: "b",
    data: { name: "Pasta" },
  });
  expect(state.categories.b.slug).toBe("pasta");
  expect(() =>
    prepareCollectionMutation(schema, state, {
      collection: "categories",
      entryId: "b",
      data: { ...state.categories.b, order: 99 },
    }),
  ).toThrow(/managed/);
});

test("validates nested references and optional lists without losing list order", () => {
  const nested = defineSchema({
    definitions: {
      people: defineCollection({ fields: { name: s.string() } }),
      books: defineCollection({
        fields: {
          credits: s.object({
            fields: {
              authors: s.reference("people", {
                multiple: true,
                optional: true,
              }),
            },
          }),
        },
      }),
    },
  });
  const state = {
    people: { a: { name: "A" }, b: { name: "B" } },
    books: { book: { credits: { authors: ["b", "a"] } } },
  };
  expect(validateCollectionSnapshot(nested, state)).toEqual([]);
  expect(
    validateCollectionSnapshot(nested, {
      ...state,
      books: { book: { credits: { authors: [] } } },
    }),
  ).toEqual([]);
  expect(
    validateCollectionSnapshot(nested, {
      ...state,
      books: { book: { credits: { authors: ["a", "a"] } } },
    })[0].code,
  ).toBe("duplicate-reference");
  expect(
    validateCollectionSnapshot(nested, {
      ...state,
      books: { book: { credits: { authors: ["missing"] } } },
    })[0].field,
  ).toBe("credits.authors");
  const roundTrip = compileSchema(compileSchema(nested).legacyStructure);
  expect(roundTrip.document.definitions.books).toMatchObject({
    fields: {
      credits: { fields: { authors: { kind: "reference", multiple: true } } },
    },
  });
});

test.each([
  s.reference("missing"),
  s.reference("categories", { by: "title" } as any),
  s.reference("categories", { onDelete: "cascade" } as any),
  s.reference("categories", { localize: true }),
  s.slug({ localize: true }),
  s.slug({ immutable: false }),
  s.order({ localize: true }),
])("rejects invalid managed declarations", (field) => {
  expect(
    validateSchemaDocument(
      defineSchema({
        definitions: {
          ...schema.definitions,
          invalid: defineCollection({
            fields: { field: field as import("../src").FieldDefinition },
          }),
        },
      }),
    ).valid,
  ).toBe(false);
});

test("requires a native target slug and rejects conflicting system slug configuration", () => {
  const invalid = defineSchema({
    definitions: {
      categories: defineCollection({ fields: { slug: s.string() } }),
      dishes: defineCollection({
        fields: { category: s.reference("categories", { by: "slug" }) },
      }),
    },
  });
  expect(validateSchemaDocument(invalid).valid).toBe(false);
  expect(() =>
    compileSchema(
      defineSchema({
        definitions: {
          categories: defineCollection({
            fields: { slug: s.slug({ source: "name" }) },
            systemFields: { slug: { enabled: true, source: "title" } },
          }),
        },
      }),
    ),
  ).toThrow();
});

test("appends changed groups independently and preserves primary slugs after title changes", () => {
  let state = prepareCollectionMutation(
    schema,
    {},
    { collection: "categories", entryId: "c1", data: { name: "Pasta" } },
  );
  state = prepareCollectionMutation(schema, state, {
    collection: "categories",
    entryId: "c2",
    data: { name: "Pizza" },
  });
  state = prepareCollectionMutation(schema, state, {
    collection: "dishes",
    entryId: "a",
    data: { category: "pasta" },
  });
  state = prepareCollectionMutation(schema, state, {
    collection: "dishes",
    entryId: "b",
    data: { category: "pizza" },
  });
  const featured = state.dishes.a.featured;
  state = prepareCollectionMutation(schema, state, {
    collection: "dishes",
    entryId: "a",
    data: { ...state.dishes.a, category: "pizza" },
  });
  expect(state.dishes.a.order).toBeGreaterThan(state.dishes.b.order as number);
  expect(state.dishes.a.featured).toBe(featured);
  state = prepareCollectionMutation(schema, state, {
    collection: "categories",
    entryId: "c1",
    data: { ...state.categories.c1, name: "New title" },
  });
  expect(state.categories.c1.slug).toBe("pasta");
  expect(() =>
    prepareCollectionMutation(schema, state, {
      collection: "categories",
      entryId: "c3",
      data: { name: "Other", slug: "pasta" },
    }),
  ).toThrow(/already used/);
});
