import {
  applyMigrationOperations,
  diffSchemas,
  planMigration,
  validateMigrationOperations,
  type FieldDefinition,
  type SchemaDocument,
} from "../src";

const text: FieldDefinition = { kind: "scalar", scalar: "string" };
const schema = (
  fields: Record<string, FieldDefinition>,
  kind: "collection" | "document" = "collection",
  path?: string,
): SchemaDocument => ({
  version: 1,
  definitions: {
    posts:
      kind === "collection"
        ? { kind, fields }
        : { kind, fields, ...(path ? { path } : {}) },
  },
});
const kinds = (current: SchemaDocument, next: SchemaDocument) =>
  diffSchemas(current, next).map((change) => change.kind);

describe("migration planner: changes that depend on stored content", () => {
  it("reports an optional field becoming required", () => {
    const plan = planMigration(
      schema({ title: { ...text, optional: true } }),
      schema({ title: text }),
    );
    expect(plan.changes.map((change) => change.kind)).toContain(
      "field_requirement_changed",
    );
    expect(plan.actions.map((action) => action.type)).toContain(
      "verify_existing_content",
    );
  });

  it("reports removed enum values, not only changed value types", () => {
    expect(
      kinds(
        schema({ status: { kind: "enum", values: ["draft", "live"] } }),
        schema({ status: { kind: "enum", values: ["draft", "gone"] } }),
      ),
    ).toContain("field_constraint_changed");
  });

  it("reports a smaller maximum length", () => {
    expect(
      kinds(
        schema({ title: { ...text, maxLength: 80 } }),
        schema({ title: { ...text, maxLength: 20 } }),
      ),
    ).toContain("field_constraint_changed");
  });

  it("does not report presentation-only changes", () => {
    expect(
      kinds(
        schema({ title: { ...text, description: "Old" } }),
        schema({ title: { ...text, description: "New", ui: { label: "T" } } }),
      ),
    ).toEqual([]);
  });

  it("requires existing content to supply a new required field without a default", () => {
    const plan = planMigration(schema({}), schema({ title: text }));
    expect(plan.changes[0]).toMatchObject({
      kind: "field_added",
      compatibility: "confirmable_convert",
    });
    expect(plan.actions[0].type).toBe("verify_existing_content");
    expect(
      planMigration(schema({}), schema({ title: { ...text, optional: true } }))
        .actions,
    ).toEqual([]);
  });

  it("blocks a collection that becomes a document", () => {
    const plan = planMigration(
      schema({ title: text }),
      schema({ title: text }, "document"),
    );
    expect(plan.actions[0].type).toBe("require_manual_migration");
    expect(plan.blocking).toBe(true);
  });

  it("blocks a document whose storage path changes", () => {
    const plan = planMigration(
      schema({ title: text }, "document", "content/home.json"),
      schema({ title: text }, "document", "pages/home.json"),
    );
    expect(plan.changes.map((change) => change.kind)).toContain(
      "definition_path_changed",
    );
    expect(plan.blocking).toBe(true);
  });
});

describe("migration operations", () => {
  const current = schema({ title: text });
  const next = schema({ headline: text, summary: text });

  it("turns a declared rename into one rename instead of a removal and an addition", () => {
    const plan = planMigration(current, next, [
      { type: "renameField", definition: "posts", from: "title", to: "headline" },
    ]);
    const changeKinds = plan.changes.map((change) => change.kind);
    expect(changeKinds).toContain("field_renamed");
    expect(changeKinds).not.toContain("field_removed");
    expect(
      plan.changes.find((change) => change.fieldPath === "posts.headline"),
    ).toMatchObject({ kind: "field_renamed" });
  });

  it("never infers a rename", () => {
    expect(kinds(current, next)).toEqual(
      expect.arrayContaining(["field_added", "field_removed"]),
    );
  });

  it("rejects operations that do not match both schemas", () => {
    expect(
      validateMigrationOperations(current, next, [
        { type: "renameField", definition: "posts", from: "missing", to: "headline" },
        { type: "renameField", definition: "posts", from: "title", to: "title" },
        { type: "backfillField", definition: "posts", field: "summary", value: 3 },
        { type: "backfillField", definition: "nope", field: "summary", value: "x" },
      ]).map((issue) => issue.operation),
    ).toEqual(expect.arrayContaining([0, 1, 2, 3]));
    expect(
      validateMigrationOperations(current, next, [
        { type: "renameField", definition: "posts", from: "title", to: "headline" },
        { type: "backfillField", definition: "posts", field: "summary", value: "x" },
      ]),
    ).toEqual([]);
  });

  it("moves values, fills only missing values, and never overwrites a retained target", () => {
    const operations = [
      { type: "renameField", definition: "posts", from: "title", to: "headline" },
      { type: "backfillField", definition: "posts", field: "summary", value: "TBD" },
    ] as const;
    expect(
      applyMigrationOperations({ title: "Hi" }, "posts", [...operations]),
    ).toEqual({
      value: { headline: "Hi", summary: "TBD" },
      changed: true,
      conflicts: [],
    });
    expect(
      applyMigrationOperations({ summary: "Kept" }, "posts", [...operations])
        .value,
    ).toEqual({ summary: "Kept" });
    expect(
      applyMigrationOperations({ title: "New", headline: "Old" }, "posts", [
        operations[0],
      ]),
    ).toMatchObject({ changed: false, conflicts: ["headline"] });
    expect(
      applyMigrationOperations({ title: "Hi" }, "other", [...operations]),
    ).toMatchObject({ changed: false });
  });
});
