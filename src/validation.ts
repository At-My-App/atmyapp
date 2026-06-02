import type {
  CompiledSchema,
  Definition,
  FieldDefinition,
  MdxConfigDefinition,
  SchemaDocument,
  SubmissionDefinition,
  ValidationIssue,
  ValidationResult,
} from './types';
import { compileSchema, parseSchema } from './compiler';
import { resolveDefinitionForPath } from './introspection';
import { isFieldOptional } from './utils';

function valueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function pushIssue(issues: ValidationIssue[], path: string, message: string) {
  issues.push({ path, message });
}

function validateField(
  value: unknown,
  field: FieldDefinition,
  path: string,
  issues: ValidationIssue[],
  configs: Record<string, MdxConfigDefinition>
) {
  switch (field.kind) {
    case 'scalar': {
      const expected =
        field.scalar === 'date' ||
        field.scalar === 'datetime' ||
        field.scalar === 'timestamp'
          ? 'string'
          : field.scalar;
      if (valueType(value) !== expected) {
        pushIssue(issues, path, `Expected ${expected}, got ${valueType(value)}`);
        return;
      }
      if (field.scalar === 'string' && typeof value === 'string') {
        if (field.minLength !== undefined && value.length < field.minLength) {
          pushIssue(
            issues,
            path,
            `String shorter than minLength ${field.minLength}`
          );
        }
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          pushIssue(
            issues,
            path,
            `String longer than maxLength ${field.maxLength}`
          );
        }
        if (field.pattern) {
          const regex = new RegExp(field.pattern);
          if (!regex.test(value)) {
            pushIssue(issues, path, `Value does not match pattern ${field.pattern}`);
          }
        }
      }
      if (field.scalar === 'number' && typeof value === 'number') {
        if (field.minimum !== undefined && value < field.minimum) {
          pushIssue(issues, path, `Number less than minimum ${field.minimum}`);
        }
        if (field.maximum !== undefined && value > field.maximum) {
          pushIssue(issues, path, `Number greater than maximum ${field.maximum}`);
        }
      }
      if (field.enumValues && !field.enumValues.includes(value as any)) {
        pushIssue(issues, path, 'Value not in enum');
      }
      return;
    }
    case 'enum':
      if (!field.values.includes(value as any)) {
        pushIssue(issues, path, 'Value not in enum');
      }
      return;
    case 'slug':
      if (typeof value !== 'string') {
        pushIssue(issues, path, `Expected string, got ${valueType(value)}`);
      }
      return;
    case 'reference':
      if (field.multiple) {
        if (!Array.isArray(value)) {
          pushIssue(issues, path, `Expected array, got ${valueType(value)}`);
          return;
        }
        value.forEach((entry, index) => {
          if (typeof entry !== 'string') {
            pushIssue(
              issues,
              `${path}.${index}`,
              `Expected string, got ${valueType(entry)}`
            );
          }
        });
        return;
      }
      if (typeof value !== 'string') {
        pushIssue(issues, path, `Expected string, got ${valueType(value)}`);
      }
      return;
    case 'mdx':
      if (typeof value !== 'string') {
        pushIssue(issues, path, `Expected string, got ${valueType(value)}`);
      } else if (!configs[field.config]) {
        pushIssue(issues, path, `Unknown mdx config "${field.config}"`);
      }
      return;
    case 'asset':
      if (field.multiple) {
        if (!Array.isArray(value)) {
          pushIssue(issues, path, `Expected array, got ${valueType(value)}`);
          return;
        }
        value.forEach((entry, index) => {
          if (typeof entry !== 'string') {
            pushIssue(
              issues,
              `${path}.${index}`,
              `Expected string, got ${valueType(entry)}`
            );
          }
        });
        return;
      }
      if (typeof value !== 'string') {
        pushIssue(issues, path, `Expected string, got ${valueType(value)}`);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        pushIssue(issues, path, `Expected array, got ${valueType(value)}`);
        return;
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        pushIssue(issues, path, `Array shorter than minItems ${field.minItems}`);
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        pushIssue(issues, path, `Array longer than maxItems ${field.maxItems}`);
      }
      value.forEach((entry, index) => {
        validateField(entry, field.items, `${path}.${index}`, issues, configs);
      });
      return;
    case 'union': {
      const variantResults = field.variants.map((variant) => {
        const variantIssues: ValidationIssue[] = [];
        validateField(value, variant, path, variantIssues, configs);
        return variantIssues;
      });
      if (!variantResults.some((entry) => entry.length === 0)) {
        pushIssue(issues, path, 'Value does not match any union variant');
      }
      return;
    }
    case 'object':
      if (valueType(value) !== 'object') {
        pushIssue(issues, path, `Expected object, got ${valueType(value)}`);
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return;
      }
      for (const [childName, childField] of Object.entries(field.fields)) {
        const childValue = (value as Record<string, unknown>)[childName];
        if (childValue === undefined) {
          if (!isFieldOptional(childField)) {
            pushIssue(issues, `${path}.${childName}`, 'Required field is missing');
          }
          continue;
        }
        validateField(
          childValue,
          childField,
          `${path}.${childName}`,
          issues,
          configs
        );
      }
      if (field.additionalProperties === false) {
        const allowed = new Set(Object.keys(field.fields));
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (!allowed.has(key)) {
            pushIssue(issues, `${path}.${key}`, 'Unexpected property');
          }
        }
      }
      return;
  }
}

function validateStructuredObject(
  data: unknown,
  definition: Definition,
  configs: Record<string, MdxConfigDefinition>
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (
    definition.kind !== 'collection' &&
    definition.kind !== 'document' &&
    definition.kind !== 'system_config'
  ) {
    return { valid: true, issues };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      issues: [{ path: 'root', message: 'Expected object' }],
    };
  }

  const record = data as Record<string, unknown>;
  for (const [fieldName, field] of Object.entries(definition.fields)) {
    const value = record[fieldName];
    if (value === undefined) {
      if (!isFieldOptional(field)) {
        pushIssue(issues, fieldName, 'Required field is missing');
      }
      continue;
    }
    validateField(value, field, fieldName, issues, configs);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function validateContent(
  compiled: CompiledSchema,
  definitionName: string,
  data: unknown
): ValidationResult {
  const definition = compiled.definitionsByName[definitionName]?.definition;
  if (!definition) {
    return {
      valid: false,
      issues: [{ path: 'root', message: `Unknown definition "${definitionName}"` }],
    };
  }
  return validateStructuredObject(data, definition, compiled.configs);
}

export function validateContentAtPath(
  input: string | CompiledSchema,
  path: string,
  content: string,
  mimeType?: string | null
): ValidationResult {
  const compiled = typeof input === 'string' ? compileSchema(JSON.parse(input)) : input;
  const definition = resolveDefinitionForPath(compiled, path, mimeType);
  if (!definition) {
    return { valid: true, issues: [] };
  }
  if (
    definition.kind !== 'collection' &&
    definition.kind !== 'document' &&
    definition.kind !== 'system_config'
  ) {
    return { valid: true, issues: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          path: 'root',
          message:
            error instanceof Error ? error.message : 'Invalid JSON content',
        },
      ],
    };
  }
  return validateStructuredObject(parsed, definition.definition, compiled.configs);
}

function validateDefinitionSchema(
  definitionName: string,
  definition: Definition,
  issues: ValidationIssue[],
  schema: SchemaDocument
) {
  if (definition.localize === true) {
    if (schema.localization?.enabled !== true) {
      pushIssue(
        issues,
        `definitions.${definitionName}.localize`,
        'Resource localization requires localization.enabled'
      );
    }
    if (definition.kind === 'image' || definition.kind === 'system_config') {
      pushIssue(
        issues,
        `definitions.${definitionName}.localize`,
        `Localized ${definition.kind} definitions are not supported`
      );
    }
    if (
      definition.kind === 'file' &&
      !/\.(md|markdown|txt)$/i.test(definition.path)
    ) {
      pushIssue(
        issues,
        `definitions.${definitionName}.localize`,
        'Only Markdown and text files can be localized'
      );
    }
  }

  if (
    definition.kind === 'collection' ||
    definition.kind === 'document' ||
    definition.kind === 'system_config'
  ) {
    for (const reserved of ['id', 'createdAt', 'updatedAt'] as const) {
      if (reserved in definition.fields) {
        pushIssue(
          issues,
          `definitions.${definitionName}.fields.${reserved}`,
          `Reserved system field "${reserved}" cannot be declared as a normal field`
        );
      }
    }

    for (const [fieldName, field] of Object.entries(definition.fields)) {
      validateFieldSchema(
        field,
        `definitions.${definitionName}.fields.${fieldName}`,
        issues,
        schema
      );
    }
  }
}

function validateFieldSchema(
  field: FieldDefinition,
  path: string,
  issues: ValidationIssue[],
  schema: SchemaDocument
) {
  if (field.localize === true && !isLocalizableLeaf(field)) {
    pushIssue(
      issues,
      `${path}.localize`,
      'Only string and MDX leaf fields can be localized'
    );
  }

  if (field.kind === 'reference' && !schema.definitions[field.target]) {
    pushIssue(issues, path, `Reference target "${field.target}" does not exist`);
  }

  if (field.kind === 'reference' && field.by === 'slug') {
    const targetDefinition = schema.definitions[field.target];
    const hasSlugSupport =
      targetDefinition &&
      ((targetDefinition.kind === 'collection' ||
        targetDefinition.kind === 'document' ||
        targetDefinition.kind === 'system_config') &&
        (Boolean(targetDefinition.systemFields?.slug) ||
          'slug' in targetDefinition.fields));
    if (!hasSlugSupport) {
      pushIssue(
        issues,
        path,
        `Reference "${path.split('.').pop()}" resolves by slug, but target "${field.target}" does not expose a slug`
      );
    }
  }

  if (field.kind === 'mdx' && !schema.mdx?.[field.config]) {
    pushIssue(issues, path, `MDX config "${field.config}" does not exist`);
  }

  if (field.kind === 'object') {
    for (const [childName, childField] of Object.entries(field.fields)) {
      validateFieldSchema(childField, `${path}.${childName}`, issues, schema);
    }
  } else if (field.kind === 'array') {
    if (
      hasLocalizedDescendant(field.items) &&
      field.items.kind === 'object'
    ) {
      const identityField = field.identityField;
      const identity = identityField
        ? field.items.fields[identityField]
        : undefined;
      if (!identityField) {
        pushIssue(
          issues,
          `${path}.identityField`,
          'Arrays of objects with localized descendants require identityField'
        );
      } else if (
        !identity ||
        identity.kind !== 'scalar' ||
        identity.localize === true
      ) {
        pushIssue(
          issues,
          `${path}.identityField`,
          'identityField must reference a non-localized scalar field'
        );
      }
    }
    validateFieldSchema(field.items, `${path}[]`, issues, schema);
  } else if (field.kind === 'union') {
    field.variants.forEach((variant, index) => {
      validateFieldSchema(variant, `${path}|${index}`, issues, schema);
    });
  }
}

function isLocalizableLeaf(field: FieldDefinition): boolean {
  return (
    (field.kind === 'scalar' && field.scalar === 'string') ||
    field.kind === 'mdx'
  );
}

function hasLocalizedDescendant(field: FieldDefinition): boolean {
  if (field.localize === true && isLocalizableLeaf(field)) {
    return true;
  }
  if (field.kind === 'object') {
    return Object.values(field.fields).some(hasLocalizedDescendant);
  }
  if (field.kind === 'array') {
    return hasLocalizedDescendant(field.items);
  }
  if (field.kind === 'union') {
    return field.variants.some(hasLocalizedDescendant);
  }
  return false;
}

function validateSubmissionSchema(
  submissionName: string,
  submission: SubmissionDefinition,
  issues: ValidationIssue[],
  schema: SchemaDocument
) {
  if (!submission.fields || typeof submission.fields !== 'object') {
    pushIssue(
      issues,
      `submissions.${submissionName}.fields`,
      'Submission fields must be an object'
    );
    return;
  }

  for (const [fieldName, field] of Object.entries(submission.fields)) {
    validateFieldSchema(
      field,
      `submissions.${submissionName}.fields.${fieldName}`,
      issues,
      schema
    );
  }
}

function validateEventSchema(
  eventName: string,
  event: { columns: string[] },
  issues: ValidationIssue[]
) {
  const seen = new Set<string>();

  event.columns.forEach((column, index) => {
    if (!column || typeof column !== 'string') {
      pushIssue(
        issues,
        `events.${eventName}.columns.${index}`,
        'Event column names must be non-empty strings'
      );
      return;
    }

    if (seen.has(column)) {
      pushIssue(
        issues,
        `events.${eventName}.columns.${index}`,
        `Duplicate event column "${column}"`
      );
      return;
    }

    seen.add(column);
  });
}

export function validateSchemaDocument(
  input: string | SchemaDocument | Record<string, unknown>
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
        'root',
        'At least one definition, event, or submission is required'
      );
    }

    for (const [name, definition] of Object.entries(schema.definitions || {})) {
      validateDefinitionSchema(name, definition, issues, schema);
    }

    for (const [name, event] of Object.entries(schema.events || {})) {
      validateEventSchema(name, event, issues);
    }

    for (const [name, submission] of Object.entries(schema.submissions || {})) {
      validateSubmissionSchema(name, submission as SubmissionDefinition, issues, schema);
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
          path: 'root',
          message: error instanceof Error ? error.message : 'Invalid schema document',
        },
      ],
    };
  }
}
