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

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const arrayIdentity = (field: Extract<FieldDefinition, { kind: "array" }>) =>
  field.identityField || (isObjectArrayItem(field.items) ? "_key" : undefined);
const keysOf = (items: unknown, identity: string) =>
  new Set(
    (Array.isArray(items) ? items : []).flatMap((item) => {
      const key = record(item)?.[identity];
      return key === undefined ? [] : [key];
    }),
  );

/**
 * Removes translated fragments of source items that the new source deleted.
 * A fragment is removed only when its identity existed in the previous source
 * and the previous translation already held it. A new translation of a
 * deleted item is left alone, so `validateLocalizedItemIdentities` still
 * rejects it.
 */
export function pruneDeletedItemTranslations(
  overlay: unknown,
  definition: Definition,
  sources: { previous: unknown; next: unknown },
  previousOverlay: unknown,
): { value: unknown; changed: boolean } {
  let changed = false;
  const visit = (
    value: unknown,
    field: FieldDefinition,
    previous: unknown,
    next: unknown,
    held: unknown,
  ): unknown => {
    if (value === undefined || value === null) return value;
    switch (field.kind) {
      case "object": {
        const object = record(value);
        if (!object) return value;
        const result = { ...object };
        for (const [name, child] of Object.entries(field.fields)) {
          if (!(name in object)) continue;
          result[name] = visit(
            object[name],
            child,
            record(previous)?.[name],
            record(next)?.[name],
            record(held)?.[name],
          );
        }
        return result;
      }
      case "array": {
        const identity = arrayIdentity(field);
        if (!Array.isArray(value) || !identity) return value;
        const before = keysOf(previous, identity);
        const after = keysOf(next, identity);
        const alreadyHeld = keysOf(held, identity);
        const find = (items: unknown, key: unknown) =>
          (Array.isArray(items) ? items : []).find(
            (item) => record(item)?.[identity] === key,
          );
        return value.flatMap((item) => {
          const key = record(item)?.[identity];
          if (
            key !== undefined &&
            before.has(key) &&
            !after.has(key) &&
            alreadyHeld.has(key)
          ) {
            changed = true;
            return [];
          }
          return [
            visit(
              item,
              field.items,
              find(previous, key),
              find(next, key),
              find(held, key),
            ),
          ];
        });
      }
      case "union":
        return field.variants.reduce<unknown>(
          (current, variant) => visit(current, variant, previous, next, held),
          value,
        );
      case "scalar":
      case "enum":
      case "asset":
      case "reference":
      case "mdx":
      case "slug":
      case "order":
        return value;
      default:
        return assertNever(field);
    }
  };
  if (!("fields" in definition)) return { value: overlay, changed: false };
  const value = visit(
    overlay,
    { kind: "object", fields: definition.fields },
    sources.previous,
    sources.next,
    previousOverlay,
  );
  return { value: changed ? value : overlay, changed };
}

/**
 * A translation may only vary localized fields. Item identities are allowed,
 * since they address the source item a translated field belongs to.
 */
export function validateLocalizedOverlayFields(
  overlay: unknown,
  definition: Definition,
): ValidationIssue[] {
  /** Paths in `value` that `field` does not allow a translation to set. */
  const rejected = (
    value: unknown,
    field: FieldDefinition,
    path: string,
  ): string[] => {
    if (value === undefined || field.localize === true) return [];
    switch (field.kind) {
      case "object": {
        const object = record(value);
        if (!object) return [path];
        return Object.entries(object).flatMap(([name, child]) => {
          const childPath = path ? `${path}.${name}` : name;
          const childField = field.fields[name];
          return childField ? rejected(child, childField, childPath) : [childPath];
        });
      }
      case "array": {
        const identity = arrayIdentity(field);
        if (!Array.isArray(value)) return [path];
        if (!identity) return field.items.localize === true ? [] : [path];
        return value.flatMap((item, index) => {
          const object = record(item);
          if (!object) return [`${path}.${index}`];
          const { [identity]: _identity, ...rest } = object;
          return rejected(rest, field.items, `${path}.${index}`);
        });
      }
      case "union": {
        // Allowed when some alternative allows every translated field.
        const results = field.variants.map((variant) =>
          rejected(value, variant, path),
        );
        return results.find((paths) => !paths.length) ?? results[0] ?? [path];
      }
      case "scalar":
      case "enum":
      case "asset":
      case "reference":
      case "mdx":
      case "slug":
      case "order":
        return [path];
      default:
        return assertNever(field);
    }
  };
  if (!("fields" in definition)) return [];
  return rejected(
    overlay,
    { kind: "object", fields: definition.fields },
    "",
  ).map((path) =>
    contentIssue(
      "not-localizable",
      path || "root",
      "This field is not translated. Remove it from the translation; the source value is used.",
    ),
  );
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
