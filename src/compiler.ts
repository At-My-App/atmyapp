import type {
  CompiledDefinition,
  CompiledField,
  CompiledSchema,
  Definition,
  EventDefinition,
  FieldDefinition,
  LegacyStructureDocument,
  SchemaDocument,
} from './types';
import { compileLegacyStructure, materializeSystemFields, toLegacyStructure } from './legacy';
import { ensureDocumentPath, normalizePath, stripExtension } from './utils';

function isLegacyStructure(input: any): input is LegacyStructureDocument {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }
  const definitions = input.definitions;
  if (!definitions || typeof definitions !== 'object') {
    return false;
  }
  return Object.values(definitions).every((definition) => {
    return Boolean(definition && typeof definition === 'object' && 'type' in (definition as Record<string, unknown>));
  });
}

function normalizeField(field: FieldDefinition): FieldDefinition {
  const normalizedOptional =
    typeof field.optional === 'boolean'
      ? field.optional
      : typeof field.required === 'boolean'
      ? !field.required
      : false;

  switch (field.kind) {
    case 'scalar':
      return {
        ...field,
        optional: normalizedOptional,
        required: undefined,
        minLength:
          field.scalar === 'string'
            ? (field.minLength ?? field.min)
            : field.minLength,
        maxLength:
          field.scalar === 'string'
            ? (field.maxLength ?? field.max)
            : field.maxLength,
        minimum:
          field.scalar === 'number'
            ? (field.minimum ?? field.min)
            : field.minimum,
        maximum:
          field.scalar === 'number'
            ? (field.maximum ?? field.max)
            : field.maximum,
        format:
          field.scalar === 'number' && field.integer === true
            ? (field.format ?? 'integer')
            : field.format,
        step:
          field.scalar === 'number' && field.integer === true
            ? (field.step ?? 1)
            : field.step,
      };
    case 'object': {
      const fields: Record<string, FieldDefinition> = {};
      for (const [name, child] of Object.entries(field.fields)) {
        fields[name] = normalizeField(child);
      }
      return {
        ...field,
        optional: normalizedOptional,
        required: undefined,
        fields,
      };
    }
    case 'array':
      return {
        ...field,
        optional: normalizedOptional,
        required: undefined,
        items: normalizeField(field.items),
      };
    case 'union':
      return {
        ...field,
        optional: normalizedOptional,
        required: undefined,
        variants: field.variants.map(normalizeField),
      };
    case 'reference':
      return {
        ...field,
        optional: normalizedOptional,
        required: undefined,
        by: field.by || 'id',
      };
    default:
      return {
        ...field,
        optional: normalizedOptional,
        required: undefined,
      };
  }
}

function normalizeDefinition(name: string, definition: Definition): Definition {
  if (definition.kind === 'collection') {
    const fields: Record<string, FieldDefinition> = {};
    for (const [fieldName, field] of Object.entries(definition.fields || {})) {
      fields[fieldName] = normalizeField(field);
    }
    return {
      ...definition,
      name,
      fields,
      indexes: Array.isArray(definition.indexes) ? definition.indexes : [],
    };
  }

  if (definition.kind === 'document') {
    const fields: Record<string, FieldDefinition> = {};
    for (const [fieldName, field] of Object.entries(definition.fields || {})) {
      fields[fieldName] = normalizeField(field);
    }
    return {
      ...definition,
      name,
      path: ensureDocumentPath(definition.path || name),
      fields,
    };
  }

  return {
    ...definition,
    name,
    path: normalizePath(definition.path || name),
  };
}

export function parseSchema(input: string | SchemaDocument | LegacyStructureDocument): SchemaDocument {
  const parsed =
    typeof input === 'string'
      ? (JSON.parse(input) as SchemaDocument | LegacyStructureDocument)
      : input;

  if (isLegacyStructure(parsed)) {
    return compileLegacyStructure(parsed);
  }

  return normalizeSchema(parsed as SchemaDocument);
}

export function normalizeSchema(input: SchemaDocument): SchemaDocument {
  const definitions: Record<string, Definition> = {};
  for (const [name, definition] of Object.entries(input.definitions || {})) {
    definitions[name] = normalizeDefinition(name, definition);
  }

  const events: Record<string, EventDefinition> = {};
  for (const [name, event] of Object.entries(input.events || {})) {
    events[name] = {
      description:
        typeof event.description === 'string' ? event.description : undefined,
      columns: Array.isArray(event.columns)
        ? event.columns.filter(
            (entry: unknown): entry is string => typeof entry === 'string'
          )
        : [],
    };
  }

  return {
    version: 1,
    description: input.description,
    definitions,
    events,
    args:
      input.args && typeof input.args === 'object'
        ? input.args
        : {},
    mdx:
      input.mdx && typeof input.mdx === 'object'
        ? input.mdx
        : {},
    submissions:
      input.submissions && typeof input.submissions === 'object'
        ? input.submissions
        : {},
  };
}

function collectFieldIndexes(
  definitionName: string,
  prefix: string,
  field: FieldDefinition,
  fieldsByPath: Record<string, CompiledField>,
  referenceFields: CompiledField[],
  assetFields: CompiledField[]
) {
  const compiledField: CompiledField = {
    definitionName,
    path: prefix,
    field,
    description: field.description,
  };
  fieldsByPath[prefix] = compiledField;

  if (field.kind === 'reference') {
    referenceFields.push(compiledField);
  }
  if (field.kind === 'asset') {
    assetFields.push(compiledField);
  }

  if (field.kind === 'object') {
    for (const [name, child] of Object.entries(field.fields)) {
      collectFieldIndexes(
        definitionName,
        `${prefix}.${name}`,
        child,
        fieldsByPath,
        referenceFields,
        assetFields
      );
    }
  } else if (field.kind === 'array') {
    collectFieldIndexes(
      definitionName,
      `${prefix}[]`,
      field.items,
      fieldsByPath,
      referenceFields,
      assetFields
    );
  } else if (field.kind === 'union') {
    field.variants.forEach((variant, index) => {
      collectFieldIndexes(
        definitionName,
        `${prefix}|${index}`,
        variant,
        fieldsByPath,
        referenceFields,
        assetFields
      );
    });
  }
}

function buildPathAliases(name: string, definition: Definition): string[] {
  const aliases = new Set<string>([normalizePath(name), stripExtension(name)]);
  if (definition.kind === 'document') {
    const documentPath = ensureDocumentPath(definition.path || name);
    aliases.add(normalizePath(documentPath));
    aliases.add(stripExtension(documentPath));
  } else if (definition.kind === 'file' || definition.kind === 'image') {
    aliases.add(normalizePath(definition.path));
    aliases.add(stripExtension(definition.path));
  } else {
    aliases.add(stripExtension(name));
  }
  return Array.from(aliases).filter(Boolean);
}

export function compileSchema(
  input: string | SchemaDocument | LegacyStructureDocument
): CompiledSchema {
  const document = parseSchema(input);
  const legacyStructure = toLegacyStructure(document);
  const definitionsByName: Record<string, CompiledDefinition> = {};
  const definitionsByPath: Record<string, CompiledDefinition> = {};
  const definitionKindsByPath: Record<string, CompiledSchema['definitionKindsByPath'][string]> = {};
  const fieldsByPath: Record<string, CompiledField> = {};
  const referenceFields: CompiledField[] = [];
  const assetFields: CompiledField[] = [];

  for (const [name, definition] of Object.entries(document.definitions)) {
    const pathAliases = buildPathAliases(name, definition);
    const compiledDefinition: CompiledDefinition = {
      definition,
      name,
      kind: definition.kind,
      pathAliases,
      systemFields: materializeSystemFields(definition),
      description: definition.description,
    };
    definitionsByName[name] = compiledDefinition;

    for (const alias of pathAliases) {
      definitionsByPath[alias] = compiledDefinition;
      definitionKindsByPath[alias] = definition.kind;
    }

    if (definition.kind === 'collection' || definition.kind === 'document') {
      for (const [fieldName, field] of Object.entries(definition.fields)) {
        collectFieldIndexes(
          name,
          `${name}.${fieldName}`,
          field,
          fieldsByPath,
          referenceFields,
          assetFields
        );
      }
    }
  }

  return {
    document,
    legacyStructure,
    definitionsByName,
    definitionsByPath,
    definitionKindsByPath,
    fieldsByPath,
    referenceFields,
    assetFields,
    events: document.events || {},
    configs: document.mdx || {},
  };
}
