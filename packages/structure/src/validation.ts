import type {
  CompiledSchema,
  Definition,
  FieldDefinition,
  MdxConfigDefinition,
  SchemaDocument,
  SubmissionDefinition,
  ValidationIssue,
  ValidationResult,
} from "./types";
import { compileSchema, parseSchema } from "./compiler";
import { resolveDefinitionForPath } from "./introspection";
import {
  contentIssue,
  validate,
  validateFieldValue,
  type ValidationMode,
} from "./valueValidation";
export { validate, validateFieldValue } from "./valueValidation";
function pushIssue(issues: ValidationIssue[], path: string, message: string) {
  issues.push(contentIssue("invalid-schema", path, message));
}
export function matchesFieldValue(
  value: unknown,
  field: FieldDefinition,
  configs: Record<string, MdxConfigDefinition> = {},
): boolean {
  return !validateFieldValue(value, field, "", "publish", configs).some(
    (issue) => issue.severity === "hard",
  );
}
export function validateContent(
  compiled: CompiledSchema,
  definitionName: string,
  data: unknown,
  mode: ValidationMode = "publish",
): ValidationResult {
  const definition = compiled.definitionsByName[definitionName]?.definition;
  if (!definition)
    return {
      valid: false,
      issues: [
        contentIssue(
          "invalid-schema",
          "root",
          `Unknown definition "${definitionName}"`,
        ),
      ],
    };
  return validate(data, definition, mode, compiled.configs);
}
export function validateContentAtPath(
  input: string | CompiledSchema,
  path: string,
  content: string,
  mimeType?: string | null,
  mode: ValidationMode = "publish",
): ValidationResult {
  let compiled: CompiledSchema;
  try {
    compiled = typeof input === "string" ? compileSchema(input) : input;
  } catch (error) {
    return {
      valid: false,
      issues: [
        contentIssue(
          "invalid-schema",
          "root",
          error instanceof Error ? error.message : "Invalid schema",
        ),
      ],
    };
  }
  const definition = resolveDefinitionForPath(compiled, path, mimeType);
  if (!definition) return { valid: true, issues: [] };
  if (!("fields" in definition.definition)) return { valid: true, issues: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      valid: false,
      issues: [contentIssue("invalid-json", "root", "Invalid JSON content")],
    };
  }
  return validate(parsed, definition.definition, mode, compiled.configs);
}

function validateDefinitionSchema(
  definitionName: string,
  definition: Definition,
  issues: ValidationIssue[],
  schema: SchemaDocument,
) {
  if (definition.localize === true) {
    if (schema.localization?.enabled !== true) {
      pushIssue(
        issues,
        `definitions.${definitionName}.localize`,
        "Resource localization requires localization.enabled",
      );
    }
    if (definition.kind === "image" || definition.kind === "system_config") {
      pushIssue(
        issues,
        `definitions.${definitionName}.localize`,
        `Localized ${definition.kind} definitions are not supported`,
      );
    }
    if (
      definition.kind === "file" &&
      !/\.(md|markdown|txt)$/i.test(definition.path)
    ) {
      pushIssue(
        issues,
        `definitions.${definitionName}.localize`,
        "Only Markdown and text files can be localized",
      );
    }
  }

  if (
    definition.kind === "collection" ||
    definition.kind === "document" ||
    definition.kind === "system_config"
  ) {
    for (const reserved of ["id", "createdAt", "updatedAt", "_key"] as const) {
      if (reserved in definition.fields) {
        pushIssue(
          issues,
          `definitions.${definitionName}.fields.${reserved}`,
          `Reserved system field "${reserved}" cannot be declared as a normal field`,
        );
      }
    }

    for (const [fieldName, field] of Object.entries(definition.fields)) {
      validateFieldSchema(
        field,
        `definitions.${definitionName}.fields.${fieldName}`,
        issues,
        schema,
      );
    }
  }
}

function validateFieldSchema(
  field: FieldDefinition,
  path: string,
  issues: ValidationIssue[],
  schema: SchemaDocument,
) {
  if (field.unique && field.kind !== "slug") {
    const parts = path.split(".");
    const owner = schema.definitions[parts[1]];
    if (
      parts.length !== 4 ||
      owner?.kind !== "collection" ||
      hasLocalizedDescendant(field)
    )
      pushIssue(
        issues,
        path,
        "Generic unique is supported only on non-localized top-level collection fields. Use uniqueItems for list values.",
      );
  }
  if (field.localize === true && !isLocalizableLeaf(field)) {
    pushIssue(
      issues,
      `${path}.localize`,
      "Only string and MDX leaf fields can be localized",
    );
  }

  if (
    field.kind === "slug" &&
    (field.unique === false ||
      field.immutable === false ||
      field.updatePolicy === "on_change")
  ) {
    pushIssue(issues, path, "Slugs must be unique and immutable");
  }
  if (field.kind === "order") {
    const parts = path.split(".");
    const owner = schema.definitions[parts[1]];
    if (parts.length !== 4 || owner?.kind !== "collection")
      pushIssue(
        issues,
        path,
        "Order fields must be top-level collection fields",
      );
    if (field.groupBy !== undefined) {
      const group =
        owner && "fields" in owner ? owner.fields[field.groupBy] : undefined;
      if (!group || group.kind !== "reference" || group.multiple)
        pushIssue(
          issues,
          path,
          "groupBy must name a top-level single-value reference in the same collection",
        );
    }
  }
  if (field.kind === "reference") {
    const target = schema.definitions[field.target];
    if (target?.kind === "collection") {
      if (field.by && field.by !== "id" && field.by !== "slug")
        pushIssue(
          issues,
          path,
          "Collection references support only id or slug",
        );
      if (field.targetField)
        pushIssue(
          issues,
          path,
          "Custom reference target fields are not supported",
        );
      if (field.onDelete && field.onDelete !== "restrict")
        pushIssue(
          issues,
          path,
          "Collection references require onDelete: restrict",
        );
    }
  }
  if (field.kind === "reference" && !schema.definitions[field.target]) {
    pushIssue(
      issues,
      path,
      `Reference target "${field.target}" does not exist`,
    );
  }

  if (field.kind === "reference" && field.by === "slug") {
    const targetDefinition = schema.definitions[field.target];
    const hasSlugSupport =
      targetDefinition &&
      (targetDefinition.kind === "collection" ||
        targetDefinition.kind === "document" ||
        targetDefinition.kind === "system_config") &&
      targetDefinition.fields.slug?.kind === "slug";
    if (!hasSlugSupport) {
      pushIssue(
        issues,
        path,
        `Reference "${path.split(".").pop()}" resolves by slug, but target "${
          field.target
        }" does not expose a slug`,
      );
    }
  }

  if (field.kind === "mdx" && !schema.mdx?.[field.config]) {
    pushIssue(issues, path, `MDX config "${field.config}" does not exist`);
  }

  if (field.kind === "object") {
    for (const [childName, childField] of Object.entries(field.fields)) {
      validateFieldSchema(childField, `${path}.${childName}`, issues, schema);
    }
  } else if (field.kind === "array") {
    if (hasLocalizedDescendant(field.items) && field.items.kind === "object") {
      const identityField = field.identityField;
      const identity = identityField
        ? field.items.fields[identityField]
        : undefined;
      if (
        identityField &&
        (!identity || identity.kind !== "scalar" || identity.localize === true)
      ) {
        pushIssue(
          issues,
          `${path}.identityField`,
          "identityField must reference a non-localized scalar field",
        );
      }
    }
    validateFieldSchema(field.items, `${path}[]`, issues, schema);
  } else if (field.kind === "union") {
    field.variants.forEach((variant, index) => {
      validateFieldSchema(variant, `${path}|${index}`, issues, schema);
    });
  }
}

function isLocalizableLeaf(field: FieldDefinition): boolean {
  return (
    (field.kind === "scalar" && field.scalar === "string") ||
    field.kind === "mdx"
  );
}

function hasLocalizedDescendant(field: FieldDefinition): boolean {
  if (field.localize === true && isLocalizableLeaf(field)) {
    return true;
  }
  if (field.kind === "object") {
    return Object.values(field.fields).some(hasLocalizedDescendant);
  }
  if (field.kind === "array") {
    return hasLocalizedDescendant(field.items);
  }
  if (field.kind === "union") {
    return field.variants.some(hasLocalizedDescendant);
  }
  return false;
}

function validateSubmissionSchema(
  submissionName: string,
  submission: SubmissionDefinition,
  issues: ValidationIssue[],
  schema: SchemaDocument,
) {
  if (!submission.fields || typeof submission.fields !== "object") {
    pushIssue(
      issues,
      `submissions.${submissionName}.fields`,
      "Submission fields must be an object",
    );
    return;
  }

  for (const [fieldName, field] of Object.entries(submission.fields)) {
    validateFieldSchema(
      field,
      `submissions.${submissionName}.fields.${fieldName}`,
      issues,
      schema,
    );
  }
}

function validateEventSchema(
  eventName: string,
  event: { columns: string[] },
  issues: ValidationIssue[],
) {
  const seen = new Set<string>();

  event.columns.forEach((column, index) => {
    if (!column || typeof column !== "string") {
      pushIssue(
        issues,
        `events.${eventName}.columns.${index}`,
        "Event column names must be non-empty strings",
      );
      return;
    }

    if (seen.has(column)) {
      pushIssue(
        issues,
        `events.${eventName}.columns.${index}`,
        `Duplicate event column "${column}"`,
      );
      return;
    }

    seen.add(column);
  });
}

export function validateSchemaDocument(
  input: string | SchemaDocument | Record<string, unknown>,
): ValidationResult {
  try {
    const schema = parseSchema(input as any);
    const issues: ValidationIssue[] = [];

    if (
      Object.keys(schema.definitions || {}).length === 0 &&
      Object.keys(schema.events || {}).length === 0 &&
      Object.keys(schema.submissions || {}).length === 0
    ) {
      pushIssue(
        issues,
        "root",
        "At least one definition, event, or submission is required",
      );
    }

    for (const [name, definition] of Object.entries(schema.definitions || {})) {
      validateDefinitionSchema(name, definition, issues, schema);
    }

    for (const [name, event] of Object.entries(schema.events || {})) {
      validateEventSchema(name, event, issues);
    }

    for (const [name, submission] of Object.entries(schema.submissions || {})) {
      validateSubmissionSchema(
        name,
        submission as SubmissionDefinition,
        issues,
        schema,
      );
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          code: "invalid-schema",
          severity: "hard",
          path: "root",
          message:
            error instanceof Error ? error.message : "Invalid schema document",
        },
      ],
    };
  }
}
