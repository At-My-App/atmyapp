import type {
  CompiledSchema,
  Definition,
  FieldDefinition,
  MdxConfigDefinition,
  SchemaDocument,
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
  if (definition.kind !== 'collection' && definition.kind !== 'document') {
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
  if (definition.kind !== 'collection' && definition.kind !== 'document') {
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
  if (definition.kind === 'collection' || definition.kind === 'document') {
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
      if (field.kind === 'reference' && !schema.definitions[field.target]) {
        pushIssue(
          issues,
          `definitions.${definitionName}.fields.${fieldName}`,
          `Reference target "${field.target}" does not exist`
        );
      }
      if (field.kind === 'reference' && field.by === 'slug') {
        const targetDefinition = schema.definitions[field.target];
        const hasSlugSupport =
          targetDefinition &&
          ((targetDefinition.kind === 'collection' || targetDefinition.kind === 'document') &&
            (Boolean(targetDefinition.systemFields?.slug) || 'slug' in targetDefinition.fields));
        if (!hasSlugSupport) {
          pushIssue(
            issues,
            `definitions.${definitionName}.fields.${fieldName}`,
            `Reference "${fieldName}" resolves by slug, but target "${field.target}" does not expose a slug`
          );
        }
      }
      if (field.kind === 'mdx' && !schema.mdx?.[field.config]) {
        pushIssue(
          issues,
          `definitions.${definitionName}.fields.${fieldName}`,
          `MDX config "${field.config}" does not exist`
        );
      }
    }
  }
}

export function validateSchemaDocument(
  input: string | SchemaDocument | Record<string, unknown>
): ValidationResult {
  try {
    const schema = parseSchema(input as any);
    const issues: ValidationIssue[] = [];

    if (!schema.definitions || Object.keys(schema.definitions).length === 0) {
      pushIssue(issues, 'definitions', 'At least one definition is required');
    }

    for (const [name, definition] of Object.entries(schema.definitions || {})) {
      validateDefinitionSchema(name, definition, issues, schema);
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
