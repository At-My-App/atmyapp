import {
  defineCollection,
  defineDocument,
  defineSchema,
  diffSchemas,
  planMigration,
  renderMigrationPrompts,
  s,
} from "../src";

describe("@atmyapp/structure migration", () => {
  it("plans confirmable conversions for scalar changes", () => {
    const current = defineSchema({
      definitions: {
        settings: defineDocument({
          fields: {
            retries: s.number(),
          },
        }),
      },
    });
    const next = defineSchema({
      definitions: {
        settings: defineDocument({
          fields: {
            retries: s.string(),
          },
        }),
      },
    });

    const plan = planMigration(current, next);

    expect(plan.actions.some((action) => action.type === "confirm_convert")).toBe(
      true
    );
    expect(plan.blocking).toBe(false);
  });

  it("creates backfill and unique-index actions when enabling slug system fields", () => {
    const current = defineSchema({
      definitions: {
        posts: defineCollection({
          fields: {
            title: s.string(),
          },
        }),
      },
    });
    const next = defineSchema({
      definitions: {
        posts: defineCollection({
          fields: {
            title: s.string(),
          },
          systemFields: {
            slug: {
              enabled: true,
              source: "title",
            },
          },
        }),
      },
    });

    const plan = planMigration(current, next);
    const prompts = renderMigrationPrompts(plan);

    expect(
      plan.actions.some((action) => action.type === "backfill_generated_field")
    ).toBe(true);
    expect(
      plan.actions.some((action) => action.type === "create_unique_index")
    ).toBe(true);
    expect(prompts.length).toBeGreaterThan(0);
  });

  it("marks incompatible field removals as blocking", () => {
    const current = defineSchema({
      definitions: {
        settings: defineDocument({
          fields: {
            title: s.string(),
            retries: s.number(),
          },
        }),
      },
    });
    const next = defineSchema({
      definitions: {
        settings: defineDocument({
          fields: {
            title: s.string(),
          },
        }),
      },
    });

    const changes = diffSchemas(current, next);
    const plan = planMigration(current, next);

    expect(changes.some((change) => change.kind === "field_removed")).toBe(true);
    expect(plan.blocking).toBe(true);
  });
});
