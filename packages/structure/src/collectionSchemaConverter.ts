import { z } from 'zod';

const CollectionFieldSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('object'),
        description: z.string().optional().default(''),
        required: z.array(z.string()).optional(),
        properties: z.record(z.string(), CollectionFieldSchema).optional(),
      })
      .extend({ default: z.any().optional() }),
    z
      .object({
        type: z.literal('array'),
        description: z.string().optional().default(''),
        items: CollectionFieldSchema,
      })
      .extend({ default: z.any().optional() }),
    z
      .object({
        type: z.enum(['string', 'number', 'boolean', 'null']),
        description: z.string().optional().default(''),
        maxLength: z.number().optional(),
        minLength: z.number().optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        enum: z.array(z.any()).optional(),
        format: z
          .enum([
            'image',
            'file',
            'markdown',
            'mdx',
            'text_long',
            'video',
            'audio',
            'document',
            'boolean',
            'date',
            'datetime',
            'timestamp',
          ])
          .optional(),
        semanticType: z
          .enum([
            'image',
            'file',
            'markdown',
            'mdx',
            'text_long',
            'video',
            'audio',
            'document',
            'boolean',
            'date',
            'datetime',
            'timestamp',
          ])
          .optional(),
        storeInBlob: z.boolean().optional(),
        imageOptions: z
          .object({
            height: z.number().positive().optional(),
            width: z.number().positive().optional(),
            optimization: z.enum(['fast', 'optimal']).optional(),
            ratio: z.string().optional(),
            faceFocus: z.boolean().optional(),
          })
          .optional(),
      })
      .extend({ default: z.any().optional() }),
  ])
);

export const CollectionSchema = z.object({
  description: z.string(),
  properties: z.record(z.string(), CollectionFieldSchema),
  required: z.array(z.string()).optional(),
  indexes: z
    .array(
      z.union([
        z.string().describe('Single column index'),
        z.array(z.string()).min(1).describe('Composite index on multiple columns'),
      ])
    )
    .max(10)
    .optional(),
});

export type CollectionSchema = z.infer<typeof CollectionSchema>;
export type CollectionField = z.infer<typeof CollectionFieldSchema>;

export function convertCollectionSchemaToSqlite(schema: CollectionSchema): {
  columns: Record<string, string>;
  indexes: (string | string[])[];
  enhancedSchema: CollectionSchema;
} {
  const columns: Record<string, string> = {};
  const indexes: (string | string[])[] = schema.indexes || [];
  const enhancedProperties: Record<
    string,
    CollectionField & { storeInBlob?: boolean }
  > = {};

  columns['id'] = 'text';
  columns['created_at'] = 'datetime';

  for (const [fieldName, fieldDef] of Object.entries(schema.properties) as [
    string,
    CollectionField
  ][]) {
    const typedFieldDef = fieldDef as CollectionField;
    let normalizedField: CollectionField = { ...typedFieldDef };

    if (typeof typedFieldDef.type === 'string') {
      const normalized = normalizeFieldType(typedFieldDef.type);
      normalizedField = {
        ...typedFieldDef,
        type: normalized.type as any,
        ...(normalized.format && { format: normalized.format }),
        ...(normalized.items && { items: normalized.items }),
      };
    }

    const sqliteType = getSqliteTypeForField(normalizedField);
    columns[fieldName] = sqliteType;
    enhancedProperties[fieldName] = enhanceFieldForBlobStorage(normalizedField);
  }

  const enhancedSchema: CollectionSchema = {
    ...schema,
    properties: enhancedProperties,
  };

  return { columns, indexes, enhancedSchema };
}

export function shouldStoreAsBlob(fieldDef: CollectionField): boolean {
  if (fieldDef.storeInBlob === true) {
    return true;
  }

  if (
    fieldDef.type === 'string' ||
    fieldDef.type === 'number' ||
    fieldDef.type === 'boolean' ||
    fieldDef.type === 'null'
  ) {
    const format = fieldDef.format?.toLowerCase();
    const semanticType = fieldDef.semanticType?.toLowerCase();
    const blobTypes = [
      'image',
      'file',
      'markdown',
      'mdx',
      'text_long',
      'video',
      'audio',
      'document',
    ];

    return (
      blobTypes.includes(format || '') || blobTypes.includes(semanticType || '')
    );
  }

  if (fieldDef.type === 'array' && fieldDef.items) {
    return shouldStoreAsBlob(fieldDef.items);
  }

  return false;
}

export function enhanceFieldForBlobStorage(
  fieldDef: CollectionField
): CollectionField & { storeInBlob?: boolean } {
  const enhanced = { ...fieldDef };
  if (shouldStoreAsBlob(fieldDef)) {
    enhanced.storeInBlob = true;
  }
  return enhanced;
}

export function normalizeFieldType(
  fieldType: string,
  description?: string
): { type: string; format?: string; items?: any; description?: string } {
  if (fieldType.endsWith('[]')) {
    const itemType = fieldType.slice(0, -2);
    const normalizedItem = normalizeFieldType(itemType, `${itemType} item`);
    return {
      type: 'array',
      items: normalizedItem,
      ...(description && { description }),
    };
  }

  const blobTypes = [
    'image',
    'video',
    'audio',
    'file',
    'document',
    'markdown',
    'mdx',
    'text_long',
  ];
  const dateTypes = ['date', 'datetime', 'timestamp'];

  if (blobTypes.includes(fieldType)) {
    return {
      type: 'string',
      format: fieldType,
      ...(description && { description }),
    };
  }

  if (dateTypes.includes(fieldType)) {
    return {
      type: 'number',
      format: fieldType,
      ...(description && { description }),
    } as any;
  }

  switch (fieldType) {
    case 'text':
      return {
        type: 'string',
        ...(description && { description }),
      };
    case 'integer':
    case 'real':
      return {
        type: 'number',
        ...(description && { description }),
      };
    case 'boolean':
      return {
        type: 'number',
        format: 'boolean',
        ...(description && { description }),
      } as any;
    case 'json':
      return {
        type: 'object',
        ...(description && { description }),
      };
    default:
      return {
        type: fieldType,
        ...(description && { description }),
      };
  }
}

function getSqliteTypeForField(fieldDef: CollectionField): string {
  if (fieldDef.type === 'number' && (fieldDef as any).format === 'boolean') {
    return 'integer';
  }

  switch (fieldDef.type) {
    case 'string':
      return 'text';
    case 'number':
      return 'real';
    case 'boolean':
      return 'integer';
    case 'null':
      return 'text';
    case 'object':
    case 'array':
      return 'text';
    default:
      return 'text';
  }
}

export function validateCollectionSchema(schema: unknown): {
  success: boolean;
  data?: CollectionSchema;
  error?: string;
} {
  try {
    const result = CollectionSchema.safeParse(schema);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error.message };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}
