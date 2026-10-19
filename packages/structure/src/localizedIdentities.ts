import type {
  SchemaDocument,
  Definition,
  FieldDefinition,
  ValidationIssue,
} from "./types";
import { contentIssue, assertNever } from "./valueValidation";
export function isObjectArrayItem(field: FieldDefinition): boolean {
  return (
    field.kind === "object" ||
    (field.kind === "union" &&
      field.variants.length > 0 &&
      field.variants.every((variant) => variant.kind === "object"))
  );
}
/** Translations may change fields on existing items, never introduce or replace source identities. */
export function validateLocalizedItemIdentities(
  value: unknown,
  definition: Definition,
  base: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const object = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const visit = (
    value: unknown,
    field: FieldDefinition,
    base: unknown,
    path: string,
  ): void => {
    if (value === undefined || value === null) return;
    switch (field.kind) {
      case "object":
        for (const [name, child] of Object.entries(field.fields))
          visit(
            object(value)?.[name],
            child,
            object(base)?.[name],
            path ? `${path}.${name}` : name,
          );
        return;
      case "array": {
        if (!Array.isArray(value)) return;
        const previous = Array.isArray(base) ? base : [];
        const identity =
          field.identityField ||
          (isObjectArrayItem(field.items) ? "_key" : undefined);
        value.forEach((item, index) => {
          const key = identity ? object(item)?.[identity] : undefined;
          const matched = identity
            ? previous.find(
                (old) => key !== undefined && object(old)?.[identity] === key,
              )
            : previous[index];
          if (identity && !matched)
            issues.push(
              contentIssue(
                "invalid-identity",
                `${path}.${index}.${identity}`,
                "This translation does not identify an existing source item. Refresh the source and preserve its item identity.",
              ),
            );
          visit(item, field.items, matched, `${path}.${index}`);
        });
        return;
      }
      case "union":
        field.variants.forEach((variant) => visit(value, variant, base, path));
        return;
      case "scalar":
      case "enum":
      case "asset":
      case "reference":
      case "mdx":
      case "slug":
      case "order":
        return;
      default:
        assertNever(field);
    }
  };
  if ("fields" in definition)
    visit(value, { kind: "object", fields: definition.fields }, base, "");
  return issues;
}

/** Explicit identity fields remain an integrity contract during a rollout rollback. */
export function hasDeclaredItemIdentities(schema: SchemaDocument): boolean {
  const visit = (field: FieldDefinition): boolean => {
    switch (field.kind) {
      case "array":
        return !!field.identityField || visit(field.items);
      case "object":
        return Object.values(field.fields).some(visit);
      case "union":
        return field.variants.some(visit);
      case "scalar":
      case "enum":
      case "asset":
      case "reference":
      case "mdx":
      case "slug":
      case "order":
        return false;
      default:
        return assertNever(field);
    }
  };
  return Object.values(schema.definitions).some(
    (definition) =>
      "fields" in definition && Object.values(definition.fields).some(visit),
  );
}
