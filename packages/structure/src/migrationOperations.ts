import type {
  Definition,
  FieldDefinition,
  MigrationOperation,
  SchemaDocument,
} from "./types";
import { assertNever, validateFieldValue } from "./valueValidation";

export interface MigrationOperationIssue {
  operation: number;
  message: string;
}

const fieldsOf = (
  definition: Definition | undefined,
): Record<string, FieldDefinition> | undefined =>
  definition && "fields" in definition ? definition.fields : undefined;

/**
 * Checks declared operations against both schemas before any content is read.
 * Renames are never inferred: a field that disappears and another that appears
 * are a removal plus an addition unless an operation says otherwise.
 */
export function validateMigrationOperations(
  current: SchemaDocument,
  next: SchemaDocument,
  operations: MigrationOperation[],
): MigrationOperationIssue[] {
  const issues: MigrationOperationIssue[] = [];
  const claimed = new Set<string>();
  operations.forEach((operation, index) => {
    const add = (message: string) =>
      issues.push({ operation: index, message });
    const before = current.definitions[operation.definition];
    const after = next.definitions[operation.definition];
    const beforeFields = fieldsOf(before);
    const afterFields = fieldsOf(after);
    if (!afterFields) {
      add(`Definition "${operation.definition}" has no fields in the new schema.`);
      return;
    }
    if (before && before.kind !== after.kind) {
      add(`Definition "${operation.definition}" changes kind; operations cannot apply across kinds.`);
      return;
    }
    const claim = (field: string) => {
      const key = `${operation.definition}.${field}`;
      if (claimed.has(key)) add(`Field "${key}" is used by more than one operation.`);
      claimed.add(key);
    };
    switch (operation.type) {
      case "renameField":
        claim(operation.from);
        claim(operation.to);
        if (operation.from === operation.to)
          add("A rename needs different source and target names.");
        if (!beforeFields?.[operation.from])
          add(`Field "${operation.definition}.${operation.from}" does not exist in the current schema.`);
        if (afterFields[operation.from])
          add(`Field "${operation.definition}.${operation.from}" still exists in the new schema.`);
        if (!afterFields[operation.to])
          add(`Field "${operation.definition}.${operation.to}" does not exist in the new schema.`);
        if (beforeFields?.[operation.to])
          add(`Field "${operation.definition}.${operation.to}" already exists in the current schema.`);
        return;
      case "backfillField": {
        claim(operation.field);
        const field = afterFields[operation.field];
        if (!field) {
          add(`Field "${operation.definition}.${operation.field}" does not exist in the new schema.`);
          return;
        }
        if (operation.value === undefined) {
          add("A backfill needs a value.");
          return;
        }
        const invalid = validateFieldValue(
          operation.value,
          field,
          operation.field,
          "publish",
          next.mdx,
        ).filter((issue) => issue.severity === "hard");
        if (invalid.length)
          add(`Backfill value for "${operation.definition}.${operation.field}" is invalid: ${invalid[0].message}`);
        return;
      }
      default:
        return assertNever(operation);
    }
  });
  return issues;
}

export interface TransformResult {
  value: Record<string, unknown>;
  changed: boolean;
  /** A rename target that already holds a retained value would be overwritten. */
  conflicts: string[];
}

/** Pure: applies the operations for one definition to one stored value. */
export function applyMigrationOperations(
  value: Record<string, unknown>,
  definition: string,
  operations: MigrationOperation[],
): TransformResult {
  const next = { ...value };
  const conflicts: string[] = [];
  let changed = false;
  for (const operation of operations) {
    if (operation.definition !== definition) continue;
    switch (operation.type) {
      case "renameField":
        if (!(operation.from in next)) break;
        if (next[operation.to] !== undefined) {
          conflicts.push(operation.to);
          break;
        }
        next[operation.to] = next[operation.from];
        delete next[operation.from];
        changed = true;
        break;
      case "backfillField":
        if (next[operation.field] !== undefined) break;
        next[operation.field] = structuredClone(operation.value);
        changed = true;
        break;
      default:
        return assertNever(operation);
    }
  }
  return { value: next, changed, conflicts };
}
