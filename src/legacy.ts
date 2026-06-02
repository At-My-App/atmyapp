import type {
  ArrayFieldDefinition,
  AssetFieldDefinition,
  CollectionDefinition,
  Definition,
  DocumentDefinition,
  EventDefinition,
  FieldDefinition,
  LegacySingleDefinition,
  LegacyStructureDocument,
  MdxFieldDefinition,
  SchemaDocument,
  ScalarFieldDefinition,
  SlugFieldDefinition,
  SystemConfigDefinition,
  SystemFieldDefinition,
} from './types';
import { ensureDocumentPath, isFieldOptional, normalizePath } from './utils';

const ASSET_FORMATS = new Set([
  'image',
  'file',
  'video',
  'audio',
  'document',
]);

function legacyFieldToCanonical(
  name: string,
  schema: any,
  required = false
): FieldDefinition {
  const optional = !required;
  if (!schema || typeof schema !== 'object') {
    return {
      kind: 'scalar',
      scalar: 'string',
      optional,
    };
  }

  const description =
    typeof schema.description === 'string' ? schema.description : undefined;
  const localization =
    typeof schema.localize === 'boolean' ? { localize: schema.localize } : {};

  // COMPAT(legacy-structure): support legacy __amatype markers while older
  // generated .structure payloads still rely on them.
  if (schema.__amatype === 'AmaMdxDef' || schema.format === 'mdx') {
    return {
      kind: 'mdx',
      config: String(schema.mdxConfig || schema.mdx_config || 'default'),
      description,
      optional,
      ...localization,
    };
  }

  // COMPAT(legacy-structure): AmaImageDef/AmaFileDef are preserved so the
  // canonical compiler can ingest old raw structures and CLI outputs.
  if (
    schema.__amatype === 'AmaImageDef' ||
    schema.__amatype === 'AmaFileDef'
  ) {
    return {
      kind: 'asset',
      assetKind: schema.__amatype === 'AmaImageDef' ? 'image' : 'file',
      multiple: false,
      description,
      optional,
      ...localization,
      config:
        schema.config && typeof schema.config === 'object'
          ? schema.config
          : schema.__config && typeof schema.__config === 'object'
          ? schema.__config
          : undefined,
      legacy: {
        __amatype: schema.__amatype,
      },
    };
  }

  if (schema.type === 'array' && schema.items) {
    const item = legacyFieldToCanonical(`${name}[]`, schema.items, true);
    if (item.kind === 'asset') {
      const assetKind = item.assetKind === 'image' ? 'gallery' : item.assetKind;
      return {
        ...item,
        assetKind,
        multiple: true,
        optional,
        description,
      };
    }
    return {
      kind: 'array',
      items: item,
      description,
      optional,
      ...localization,
      minItems:
        typeof schema.minItems === 'number' ? schema.minItems : undefined,
      maxItems:
        typeof schema.maxItems === 'number' ? schema.maxItems : undefined,
      uniqueItems:
        typeof schema.uniqueItems === 'boolean'
          ? schema.uniqueItems
          : undefined,
      identityField:
        typeof schema.identityField === 'string'
          ? schema.identityField
          : undefined,
      ...localization,
    };
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return {
      kind: 'union',
      variants: schema.oneOf.map((entry: any, index: number) =>
        legacyFieldToCanonical(`${name}.${index}`, entry, required)
      ),
      description,
      optional,
      ...localization,
    };
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return {
      kind: 'union',
      variants: schema.anyOf.map((entry: any, index: number) =>
        legacyFieldToCanonical(`${name}.${index}`, entry, required)
      ),
      description,
      optional,
    };
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return {
      kind: 'enum',
      values: schema.enum,
      description,
      optional,
      default: schema.default,
      ...localization,
    };
  }

  if (schema.type === 'object') {
    const requiredNames = new Set<string>(
      Array.isArray(schema.required)
        ? schema.required.filter((entry: unknown): entry is string => typeof entry === 'string')
        : []
    );
    const fields: Record<string, FieldDefinition> = {};
    for (const [childName, childSchema] of Object.entries<any>(
      schema.properties || {}
    )) {
      fields[childName] = legacyFieldToCanonical(
        childName,
        childSchema,
        requiredNames.has(childName)
      );
    }
    return {
      kind: 'object',
      fields,
      description,
      optional,
      additionalProperties:
        typeof schema.additionalProperties === 'boolean'
          ? schema.additionalProperties
          : undefined,
      default: schema.default,
      ...localization,
    };
  }

  if (
    schema.type === 'string' &&
    (schema.format === 'slug' || schema.semanticType === 'slug')
  ) {
    return {
      kind: 'slug',
      description,
      optional,
      unique: schema.unique !== false,
      generated: true,
      immutable: true,
      source:
        typeof schema.source === 'string' ? schema.source : undefined,
      updatePolicy:
        schema.updatePolicy === 'on_change' ? 'on_change' : 'immutable',
      ...localization,
    };
  }

  if (
    schema.type === 'string' &&
    typeof schema.format === 'string' &&
    ASSET_FORMATS.has(schema.format)
  ) {
    return {
      kind: 'asset',
      assetKind: schema.format === 'image' ? 'image' : 'file',
      multiple: false,
      description,
      optional,
      config:
        schema.config && typeof schema.config === 'object'
          ? schema.config
          : schema.imageOptions && typeof schema.imageOptions === 'object'
          ? schema.imageOptions
          : undefined,
      imageOptions:
        schema.imageOptions && typeof schema.imageOptions === 'object'
          ? schema.imageOptions
          : undefined,
      accept: Array.isArray(schema.accept)
        ? schema.accept.filter((entry: unknown): entry is string => typeof entry === 'string')
        : undefined,
      ...localization,
    };
  }

  if (
    schema.type === 'string' &&
    typeof schema.format === 'string' &&
    schema.format === 'reference'
  ) {
    return {
      kind: 'reference',
      target: String(schema.target || ''),
      description,
      optional,
      by:
        schema.by === 'slug' || schema.by === 'path' ? schema.by : 'id',
      targetField:
        typeof schema.targetField === 'string' ? schema.targetField : undefined,
      onDelete:
        schema.onDelete === 'nullify' || schema.onDelete === 'cascade'
          ? schema.onDelete
          : schema.onDelete === 'restrict'
          ? 'restrict'
          : undefined,
      ...localization,
    };
  }

  const scalar: ScalarFieldDefinition = {
    kind: 'scalar',
    scalar:
      schema.type === 'number' || schema.type === 'boolean' || schema.type === 'null'
        ? schema.type
        : schema.format === 'date'
        ? 'date'
        : schema.format === 'datetime'
        ? 'datetime'
        : schema.format === 'timestamp'
        ? 'timestamp'
        : 'string',
    description,
    optional,
    default: schema.default,
    minLength:
      typeof schema.minLength === 'number' ? schema.minLength : undefined,
    maxLength:
      typeof schema.maxLength === 'number' ? schema.maxLength : undefined,
    minimum: typeof schema.minimum === 'number' ? schema.minimum : undefined,
    maximum: typeof schema.maximum === 'number' ? schema.maximum : undefined,
    pattern: typeof schema.pattern === 'string' ? schema.pattern : undefined,
    format: typeof schema.format === 'string' ? schema.format : undefined,
    ...localization,
  };

  return scalar;
}

function canonicalFieldToLegacy(field: FieldDefinition): any {
  const base: Record<string, unknown> = {};
  if (field.description) {
    base['description'] = field.description;
  }
  if (field.default !== undefined) {
    base['default'] = field.default;
  }
  if (typeof field.localize === 'boolean') {
    base['localize'] = field.localize;
  }

  switch (field.kind) {
    case 'scalar':
      return {
        ...base,
        type:
          field.scalar === 'date' ||
          field.scalar === 'datetime' ||
          field.scalar === 'timestamp'
            ? 'string'
            : field.scalar,
        ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
        ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
        ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
        ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
        ...(field.pattern ? { pattern: field.pattern } : {}),
        ...(field.format ? { format: field.format } : {}),
      };
    case 'enum':
      return {
        ...base,
        type: typeof field.values[0] === 'number' ? 'number' : 'string',
        enum: field.values,
      };
    case 'object': {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [name, child] of Object.entries(field.fields)) {
        properties[name] = canonicalFieldToLegacy(child);
        if (!isFieldOptional(child)) {
          required.push(name);
        }
      }
      return {
        ...base,
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(field.additionalProperties !== undefined
          ? { additionalProperties: field.additionalProperties }
          : {}),
      };
    }
    case 'array':
      return {
        ...base,
        type: 'array',
        items: canonicalFieldToLegacy(field.items),
        ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
        ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
        ...(field.uniqueItems !== undefined
          ? { uniqueItems: field.uniqueItems }
          : {}),
        ...(field.identityField ? { identityField: field.identityField } : {}),
      };
    case 'union':
      return {
        ...base,
        oneOf: field.variants.map(canonicalFieldToLegacy),
      };
    case 'reference':
      return {
        ...base,
        type: 'string',
        format: 'reference',
        target: field.target,
        ...(field.by ? { by: field.by } : {}),
        ...(field.targetField ? { targetField: field.targetField } : {}),
        ...(field.onDelete ? { onDelete: field.onDelete } : {}),
      };
    case 'mdx':
      return {
        ...base,
        type: 'string',
        format: 'mdx',
        storeInBlob: true,
        __amatype: 'AmaMdxDef',
        mdxConfig: field.config,
      };
    case 'slug':
      return {
        ...base,
        type: 'string',
        format: 'slug',
        unique: field.unique !== false,
        source: field.source,
        updatePolicy: field.updatePolicy || 'immutable',
      };
    case 'asset':
      if (field.multiple) {
        return {
          ...base,
          type: 'array',
          items: canonicalFieldToLegacy({
            ...field,
            multiple: false,
            assetKind: field.assetKind === 'gallery' ? 'image' : field.assetKind,
          } as AssetFieldDefinition),
        };
      }
      return {
        ...base,
        __amatype:
          field.assetKind === 'image' || field.assetKind === 'gallery'
            ? 'AmaImageDef'
            : 'AmaFileDef',
        ...(field.config ? { config: field.config } : {}),
        ...(field.accept ? { accept: field.accept } : {}),
        ...(field.imageOptions ? { imageOptions: field.imageOptions } : {}),
      };
  }
}

function defaultCollectionSystemFields(): SystemFieldDefinition[] {
  return [
    {
      name: 'id',
      enabled: true,
      readable: true,
      queryable: true,
      generated: true,
      immutable: true,
      unique: true,
      settable: false,
      requiredInStoredShape: true,
    },
    {
      name: 'createdAt',
      enabled: true,
      readable: true,
      queryable: true,
      generated: true,
      immutable: true,
      unique: false,
      settable: false,
      requiredInStoredShape: true,
    },
    {
      name: 'updatedAt',
      enabled: true,
      readable: true,
      queryable: true,
      generated: true,
      immutable: false,
      unique: false,
      settable: false,
      requiredInStoredShape: true,
    },
    {
      name: 'slug',
      enabled: false,
      readable: true,
      queryable: true,
      generated: true,
      immutable: true,
      unique: true,
      settable: false,
      requiredInStoredShape: false,
    },
  ];
}

function defaultDocumentSystemFields(): SystemFieldDefinition[] {
  return [
    {
      name: 'updatedAt',
      enabled: true,
      readable: true,
      queryable: false,
      generated: true,
      immutable: false,
      unique: false,
      settable: false,
      requiredInStoredShape: true,
    },
  ];
}

export function materializeSystemFields(
  definition: Definition
): SystemFieldDefinition[] {
  const defaults =
    definition.kind === 'collection'
      ? defaultCollectionSystemFields()
      : definition.kind === 'document'
      ? defaultDocumentSystemFields()
      : [];
  const overrides = definition.systemFields || {};

  return defaults
    .map((entry) => {
      const override = overrides[entry.name];
      if (override === false) {
        return { ...entry, enabled: false };
      }
      if (override && typeof override === 'object') {
        return {
          ...entry,
          ...override,
          enabled: override.enabled ?? entry.enabled,
        };
      }
      if (override === true) {
        return { ...entry, enabled: true };
      }
      return entry;
    })
    .filter((entry) => entry.enabled);
}

function compileLegacyDefinition(
  name: string,
  definition: LegacySingleDefinition
): Definition {
  if (definition.type === 'collection') {
    const structure = definition.structure || {};
    const requiredNames = new Set<string>(
      Array.isArray(structure.required)
        ? structure.required.filter((entry: unknown): entry is string => typeof entry === 'string')
        : []
    );
    const fields: Record<string, FieldDefinition> = {};

    for (const [fieldName, fieldSchema] of Object.entries<any>(
      structure.properties || {}
    )) {
      fields[fieldName] = legacyFieldToCanonical(
        fieldName,
        fieldSchema,
        requiredNames.has(fieldName)
      );
    }

    const collection: CollectionDefinition = {
      kind: 'collection',
      name,
      description:
        typeof definition.description === 'string'
          ? definition.description
          : typeof structure.description === 'string'
          ? structure.description
          : undefined,
      localize: definition.localize,
      fields,
      indexes: Array.isArray(structure.indexes)
        ? structure.indexes.filter(
            (entry: unknown) =>
              typeof entry === 'string' ||
              (Array.isArray(entry) &&
                entry.every((item) => typeof item === 'string'))
          )
        : [],
    };

    if ('slug' in fields) {
      collection.systemFields = {
        slug: {
          enabled: true,
          source:
            fields['slug'].kind === 'slug' ? fields['slug'].source : undefined,
          unique: fields['slug'].unique !== false,
        },
      };
    }

    return collection;
  }

  // COMPAT(legacy-structure): accept both the legacy `jsonx` label and the
  // canonical `document` label when parsing persisted/generated structures.
  if (
    definition.type === 'jsonx' ||
    definition.type === 'document' ||
    definition.type === 'system_config'
  ) {
    const structure = definition.structure || {};
    const requiredNames = new Set<string>(
      Array.isArray(structure.required)
        ? structure.required.filter((entry: unknown): entry is string => typeof entry === 'string')
        : []
    );
    const fields: Record<string, FieldDefinition> = {};

    for (const [fieldName, fieldSchema] of Object.entries<any>(
      structure.properties || {}
    )) {
      fields[fieldName] = legacyFieldToCanonical(
        fieldName,
        fieldSchema,
        requiredNames.has(fieldName)
      );
    }

    if (definition.type === 'system_config') {
      return {
        kind: 'system_config',
        name,
        path: normalizePath(definition.path || name),
        framework: String(definition.framework || ''),
        systemKey: String(definition.systemKey || name),
        displayName: String(definition.displayName || definition.description || name),
        managedBy:
          definition.managedBy === 'framework_preset'
            ? 'framework_preset'
            : 'framework_preset',
        description:
          typeof definition.description === 'string'
            ? definition.description
            : typeof structure.description === 'string'
            ? structure.description
            : undefined,
        localize: definition.localize,
        fields,
      };
    }

    return {
      kind: 'document',
      name,
      path: ensureDocumentPath(name),
      description:
        typeof definition.description === 'string'
          ? definition.description
          : typeof structure.description === 'string'
          ? structure.description
          : undefined,
      localize: definition.localize,
      fields,
    };
  }

  return {
    kind: definition.type === 'image' ? 'image' : 'file',
    name,
    path: normalizePath(name),
    description: definition.description,
    localize: definition.localize,
    config:
      definition.structure && typeof definition.structure === 'object'
        ? definition.structure
        : {},
  };
}

export function compileLegacyStructure(
  raw: LegacyStructureDocument
): SchemaDocument {
  const definitions: Record<string, Definition> = {};
  const events: Record<string, EventDefinition> = {};

  for (const [name, definition] of Object.entries(raw.definitions || {})) {
    definitions[name] = compileLegacyDefinition(name, definition);
  }

  for (const [name, event] of Object.entries(raw.events || {})) {
    events[name] = {
      description:
        typeof event?.description === 'string' ? event.description : undefined,
      columns: Array.isArray(event?.columns)
        ? event.columns.filter(
            (entry: unknown): entry is string => typeof entry === 'string'
          )
        : [],
    };
  }

  return {
    version: 1,
    description: raw.description,
    localization:
      raw.localization && typeof raw.localization === 'object'
        ? { enabled: raw.localization.enabled === true }
        : { enabled: false },
    definitions,
    events,
    args:
      raw.args && typeof raw.args === 'object'
        ? raw.args
        : {},
    mdx:
      raw.mdx && typeof raw.mdx === 'object'
        ? raw.mdx
        : {},
    submissions:
      raw.submissions && typeof raw.submissions === 'object'
        ? raw.submissions
        : {},
  };
}

export function toLegacyStructure(
  schema: SchemaDocument
): LegacyStructureDocument {
  const definitions: Record<string, LegacySingleDefinition> = {};
  const events: Record<string, EventDefinition> = {};

  for (const [name, definition] of Object.entries(schema.definitions)) {
    if (definition.kind === 'collection') {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [fieldName, field] of Object.entries(definition.fields)) {
        properties[fieldName] = canonicalFieldToLegacy(field);
        if (!isFieldOptional(field)) {
          required.push(fieldName);
        }
      }
      const slugField = materializeSystemFields(definition).find(
        (entry) => entry.name === 'slug'
      );
      if (slugField) {
        properties['slug'] = canonicalFieldToLegacy({
          kind: 'slug',
          unique: slugField.unique,
          generated: slugField.generated,
          immutable: slugField.immutable,
          source: slugField.source,
          updatePolicy: slugField.updatePolicy,
        } as SlugFieldDefinition);
      }
      definitions[name] = {
        type: 'collection',
        localize: definition.localize,
        description: definition.description,
        structure: {
          description: definition.description || '',
          properties,
          ...(required.length > 0 ? { required } : {}),
          ...(definition.indexes && definition.indexes.length > 0
            ? { indexes: definition.indexes }
            : {}),
        },
      };
      continue;
    }

    if (definition.kind === 'document' || definition.kind === 'system_config') {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [fieldName, field] of Object.entries(definition.fields)) {
        properties[fieldName] = canonicalFieldToLegacy(field);
        if (!isFieldOptional(field)) {
          required.push(fieldName);
        }
      }
      if (definition.kind === 'system_config') {
        const systemConfig = definition as SystemConfigDefinition;
        definitions[name] = {
          type: 'system_config',
          localize: systemConfig.localize,
          description: systemConfig.description,
          framework: systemConfig.framework,
          systemKey: systemConfig.systemKey,
          displayName: systemConfig.displayName,
          path: systemConfig.path,
          managedBy: systemConfig.managedBy,
          structure: {
            type: 'object',
            description: systemConfig.description || systemConfig.displayName || '',
            properties,
            ...(required.length > 0 ? { required } : {}),
          },
        };
      } else {
        // COMPAT(legacy-structure): `.structure.json` still persists documents as
        // `jsonx` during rollout so existing services and projects keep working.
        definitions[name] = {
          type: 'jsonx',
          localize: definition.localize,
          description: definition.description,
          structure: {
            type: 'object',
            description: definition.description || '',
            properties,
            ...(required.length > 0 ? { required } : {}),
          },
        };
      }
      continue;
    }

    definitions[name] = {
      type: definition.kind,
      localize: definition.localize,
      description: definition.description,
      structure:
        definition.config && typeof definition.config === 'object'
          ? definition.config
          : {},
    };
  }

  for (const [name, event] of Object.entries(schema.events || {})) {
    events[name] = {
      ...(typeof event.description === 'string'
        ? { description: event.description }
        : {}),
      columns: Array.isArray(event.columns)
        ? event.columns.filter(
            (entry: unknown): entry is string => typeof entry === 'string'
          )
        : [],
    };
  }

  return {
    description: schema.description,
    localization: schema.localization,
    definitions,
    events,
    args: schema.args || {},
    mdx: schema.mdx,
    submissions: Object.fromEntries(
      Object.entries(schema.submissions || {}).map(([name, submission]) => [
        name,
        (() => {
          const submissionInput = submission as {
            description?: string;
            fields?: Record<string, FieldDefinition>;
            captcha?: {
              required?: boolean;
              provider?: string;
              secret?: string;
            };
            requiresCaptcha?: boolean;
            captchaProvider?: string;
            hcaptchaSecret?: string;
          };

          return {
            ...(typeof submissionInput.description === 'string'
              ? { description: submissionInput.description }
              : {}),
            fields:
              submissionInput.fields && typeof submissionInput.fields === 'object'
                ? submissionInput.fields
                : {},
            requiresCaptcha:
              submissionInput.captcha?.required ??
              submissionInput.requiresCaptcha ??
              false,
            captchaProvider:
              submissionInput.captcha?.provider ??
              submissionInput.captchaProvider,
            hcaptchaSecret:
              submissionInput.captcha?.secret ??
              submissionInput.hcaptchaSecret,
          };
        })(),
      ])
    ),
  };
}
