import type {
  ArrayFieldDefinition,
  AssetFieldDefinition,
  CollectionDefinition,
  Definition,
  DocumentDefinition,
  EnumFieldDefinition,
  EventDefinition,
  FieldDefinition,
  FileDefinition,
  MdxFieldDefinition,
  ObjectFieldDefinition,
  ReferenceFieldDefinition,
  ScalarFieldDefinition,
  SchemaDocument,
  SlugFieldDefinition,
  UnionFieldDefinition,
} from './types';

function withFieldBase<T extends FieldDefinition>(
  field: T,
  options?: Partial<Omit<T, 'kind'>>
): T {
  if (!options) {
    return field;
  }
  return { ...field, ...options } as T;
}

export const s = {
  string(options: Partial<Omit<ScalarFieldDefinition, 'kind' | 'scalar'>> = {}): ScalarFieldDefinition {
    return withFieldBase({ kind: 'scalar', scalar: 'string' }, options);
  },
  number(options: Partial<Omit<ScalarFieldDefinition, 'kind' | 'scalar'>> = {}): ScalarFieldDefinition {
    return withFieldBase({ kind: 'scalar', scalar: 'number' }, options);
  },
  boolean(options: Partial<Omit<ScalarFieldDefinition, 'kind' | 'scalar'>> = {}): ScalarFieldDefinition {
    return withFieldBase({ kind: 'scalar', scalar: 'boolean' }, options);
  },
  date(options: Partial<Omit<ScalarFieldDefinition, 'kind' | 'scalar'>> = {}): ScalarFieldDefinition {
    return withFieldBase({ kind: 'scalar', scalar: 'date', format: 'date' }, options);
  },
  datetime(options: Partial<Omit<ScalarFieldDefinition, 'kind' | 'scalar'>> = {}): ScalarFieldDefinition {
    return withFieldBase(
      { kind: 'scalar', scalar: 'datetime', format: 'datetime' },
      options
    );
  },
  timestamp(options: Partial<Omit<ScalarFieldDefinition, 'kind' | 'scalar'>> = {}): ScalarFieldDefinition {
    return withFieldBase(
      { kind: 'scalar', scalar: 'timestamp', format: 'timestamp' },
      options
    );
  },
  object(
    fields: Record<string, FieldDefinition>,
    options: Partial<Omit<ObjectFieldDefinition, 'kind' | 'fields'>> = {}
  ): ObjectFieldDefinition {
    return withFieldBase({ kind: 'object', fields }, options);
  },
  array(
    items: FieldDefinition,
    options: Partial<Omit<ArrayFieldDefinition, 'kind' | 'items'>> = {}
  ): ArrayFieldDefinition {
    return withFieldBase({ kind: 'array', items }, options);
  },
  enum(
    values: EnumFieldDefinition['values'],
    options: Partial<Omit<EnumFieldDefinition, 'kind' | 'values'>> = {}
  ): EnumFieldDefinition {
    return withFieldBase({ kind: 'enum', values }, options);
  },
  union(
    variants: FieldDefinition[],
    options: Partial<Omit<UnionFieldDefinition, 'kind' | 'variants'>> = {}
  ): UnionFieldDefinition {
    return withFieldBase({ kind: 'union', variants }, options);
  },
  image(
    options: Partial<Omit<AssetFieldDefinition, 'kind' | 'assetKind' | 'multiple'>> = {}
  ): AssetFieldDefinition {
    return withFieldBase({ kind: 'asset', assetKind: 'image', multiple: false }, options);
  },
  file(
    options: Partial<Omit<AssetFieldDefinition, 'kind' | 'assetKind' | 'multiple'>> = {}
  ): AssetFieldDefinition {
    return withFieldBase({ kind: 'asset', assetKind: 'file', multiple: false }, options);
  },
  gallery(
    options: Partial<Omit<AssetFieldDefinition, 'kind' | 'assetKind' | 'multiple'>> = {}
  ): AssetFieldDefinition {
    return withFieldBase({ kind: 'asset', assetKind: 'gallery', multiple: true }, options);
  },
  reference(
    target: string,
    options: Partial<Omit<ReferenceFieldDefinition, 'kind' | 'target'>> = {}
  ): ReferenceFieldDefinition {
    return withFieldBase({ kind: 'reference', target }, options);
  },
  mdx(
    config: string,
    options: Partial<Omit<MdxFieldDefinition, 'kind' | 'config'>> = {}
  ): MdxFieldDefinition {
    return withFieldBase({ kind: 'mdx', config }, options);
  },
  slug(
    options: Partial<Omit<SlugFieldDefinition, 'kind'>> = {}
  ): SlugFieldDefinition {
    return withFieldBase(
      {
        kind: 'slug',
        unique: true,
        generated: true,
        immutable: true,
        updatePolicy: 'immutable',
      },
      options
    );
  },
};

export function defineCollection(
  input: Omit<CollectionDefinition, 'kind'>
): CollectionDefinition {
  return {
    kind: 'collection',
    ...input,
  };
}

export function defineDocument(
  input: Omit<DocumentDefinition, 'kind'>
): DocumentDefinition {
  return {
    kind: 'document',
    ...input,
  };
}

export function defineFile(
  input: Omit<FileDefinition & { kind: 'file' }, 'kind'>
): FileDefinition {
  return {
    kind: 'file',
    ...input,
  };
}

export function defineImage(
  input: Omit<FileDefinition & { kind: 'image' }, 'kind'>
): FileDefinition {
  return {
    kind: 'image',
    ...input,
  };
}

export function defineEvent(
  columns: string[] = [],
  options: Partial<EventDefinition> = {}
): EventDefinition {
  return {
    columns,
    ...options,
  };
}

export function defineBasicEvent(
  options: Partial<Omit<EventDefinition, 'columns'>> = {}
): EventDefinition {
  return {
    columns: [],
    ...options,
  };
}

export function defineSchema(
  input: Omit<SchemaDocument, 'version'>
): SchemaDocument {
  return {
    version: 1,
    ...input,
  };
}
