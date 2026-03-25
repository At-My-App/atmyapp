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
  NumberFieldFormat,
  ObjectFieldDefinition,
  ReferenceFieldDefinition,
  ScalarFieldDefinition,
  SchemaDocument,
  SlugFieldDefinition,
  StringFieldFormat,
  UnionFieldDefinition,
} from './types';

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type StringFieldOptions = Partial<
  Omit<ScalarFieldDefinition, 'kind' | 'scalar' | 'minimum' | 'maximum'>
> & {
  min?: number;
  max?: number;
  format?: StringFieldFormat | (string & {});
};

type NumberFieldOptions = Partial<
  Omit<ScalarFieldDefinition, 'kind' | 'scalar' | 'minLength' | 'maxLength'>
> & {
  min?: number;
  max?: number;
  format?: NumberFieldFormat | (string & {});
};

function normalizeStringOptions<const TOptions extends StringFieldOptions>(
  options: TOptions
): Simplify<
  TOptions & {
    minLength?: number;
    maxLength?: number;
  }
> {
  return {
    ...options,
    minLength: options.minLength ?? options.min,
    maxLength: options.maxLength ?? options.max,
  } as Simplify<
    TOptions & {
      minLength?: number;
      maxLength?: number;
    }
  >;
}

function normalizeNumberOptions<const TOptions extends NumberFieldOptions>(
  options: TOptions
): Simplify<
  TOptions & {
    minimum?: number;
    maximum?: number;
    format?: NumberFieldFormat | (string & {});
    step?: number;
  }
> {
  return {
    ...options,
    minimum: options.minimum ?? options.min,
    maximum: options.maximum ?? options.max,
    format: options.integer === true ? (options.format ?? 'integer') : options.format,
    step: options.integer === true ? (options.step ?? 1) : options.step,
  } as Simplify<
    TOptions & {
      minimum?: number;
      maximum?: number;
      format?: NumberFieldFormat | (string & {});
      step?: number;
    }
  >;
}

function withFieldBase<
  const T extends FieldDefinition,
  const TOptions extends Record<string, unknown> = {}
>(
  field: T,
  options?: TOptions
): Simplify<T & TOptions> {
  if (!options) {
    return field as Simplify<T & TOptions>;
  }
  return { ...field, ...options } as Simplify<T & TOptions>;
}

export const s = {
  string<const TOptions extends StringFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase(
      { kind: 'scalar', scalar: 'string' },
      normalizeStringOptions(options)
    );
  },
  shortText<const TOptions extends StringFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return s.string({
      format: 'short',
      preferredLength: 80,
      ...options,
    } as TOptions & {
      format: 'short';
      preferredLength: number;
    });
  },
  longText<const TOptions extends StringFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return s.string({
      format: 'long',
      preferredLength: 280,
      ...options,
    } as TOptions & {
      format: 'long';
      preferredLength: number;
    });
  },
  markdown<const TOptions extends StringFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return s.string({
      format: 'markdown',
      preferredLength: 1200,
      ...options,
    } as TOptions & {
      format: 'markdown';
      preferredLength: number;
    });
  },
  email<const TOptions extends StringFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return s.string({
      format: 'email',
      ...options,
    } as TOptions & {
      format: 'email';
    });
  },
  url<const TOptions extends StringFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return s.string({
      format: 'url',
      ...options,
    } as TOptions & {
      format: 'url';
    });
  },
  number<const TOptions extends NumberFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase(
      { kind: 'scalar', scalar: 'number' },
      normalizeNumberOptions(options)
    );
  },
  integer<const TOptions extends NumberFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return s.number({
      integer: true,
      format: 'integer',
      step: 1,
      ...options,
    } as TOptions & {
      integer: true;
      format: 'integer';
      step: number;
    });
  },
  boolean<
    const TOptions extends Partial<
      Omit<ScalarFieldDefinition, 'kind' | 'scalar'>
    > = {}
  >(options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'scalar', scalar: 'boolean' }, options);
  },
  date<
    const TOptions extends Partial<
      Omit<ScalarFieldDefinition, 'kind' | 'scalar'>
    > = {}
  >(options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'scalar', scalar: 'date', format: 'date' }, options);
  },
  datetime<
    const TOptions extends Partial<
      Omit<ScalarFieldDefinition, 'kind' | 'scalar'>
    > = {}
  >(options: TOptions = {} as TOptions) {
    return withFieldBase(
      { kind: 'scalar', scalar: 'datetime', format: 'datetime' },
      options
    );
  },
  timestamp<
    const TOptions extends Partial<
      Omit<ScalarFieldDefinition, 'kind' | 'scalar'>
    > = {}
  >(options: TOptions = {} as TOptions) {
    return withFieldBase(
      { kind: 'scalar', scalar: 'timestamp', format: 'timestamp' },
      options
    );
  },
  object<
    const TFields extends Record<string, FieldDefinition>,
    const TOptions extends Partial<
      Omit<ObjectFieldDefinition, 'kind' | 'fields'>
    > = {}
  >(fields: TFields, options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'object', fields }, options);
  },
  array<
    const TItems extends FieldDefinition,
    const TOptions extends Partial<
      Omit<ArrayFieldDefinition, 'kind' | 'items'>
    > = {}
  >(items: TItems, options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'array', items }, options);
  },
  enum<
    const TValues extends EnumFieldDefinition['values'],
    const TOptions extends Partial<Omit<EnumFieldDefinition, 'kind' | 'values'>> = {}
  >(values: TValues, options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'enum', values }, options);
  },
  union<
    const TVariants extends FieldDefinition[],
    const TOptions extends Partial<
      Omit<UnionFieldDefinition, 'kind' | 'variants'>
    > = {}
  >(variants: TVariants, options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'union', variants }, options);
  },
  image<
    const TOptions extends Partial<
      Omit<AssetFieldDefinition, 'kind' | 'assetKind' | 'multiple'>
    > = {}
  >(options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'asset', assetKind: 'image', multiple: false }, options);
  },
  file<
    const TOptions extends Partial<
      Omit<AssetFieldDefinition, 'kind' | 'assetKind' | 'multiple'>
    > = {}
  >(options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'asset', assetKind: 'file', multiple: false }, options);
  },
  gallery<
    const TOptions extends Partial<
      Omit<AssetFieldDefinition, 'kind' | 'assetKind' | 'multiple'>
    > = {}
  >(options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'asset', assetKind: 'gallery', multiple: true }, options);
  },
  reference<
    const TTarget extends string,
    const TOptions extends Partial<
      Omit<ReferenceFieldDefinition, 'kind' | 'target'>
    > = {}
  >(target: TTarget, options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'reference', target }, options);
  },
  mdx<
    const TConfig extends string,
    const TOptions extends Partial<Omit<MdxFieldDefinition, 'kind' | 'config'>> = {}
  >(config: TConfig, options: TOptions = {} as TOptions) {
    return withFieldBase({ kind: 'mdx', config }, options);
  },
  slug<
    const TOptions extends Partial<Omit<SlugFieldDefinition, 'kind'>> = {}
  >(options: TOptions = {} as TOptions) {
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

export function defineCollection<
  const T extends Omit<CollectionDefinition, 'kind'>
>(input: T): Simplify<T & { kind: 'collection' }> {
  return {
    kind: 'collection',
    ...input,
  } as Simplify<T & { kind: 'collection' }>;
}

export function defineDocument<
  const T extends Omit<DocumentDefinition, 'kind'>
>(input: T): Simplify<T & { kind: 'document' }> {
  return {
    kind: 'document',
    ...input,
  } as Simplify<T & { kind: 'document' }>;
}

export function defineFile<
  const T extends Omit<FileDefinition & { kind: 'file' }, 'kind'>
>(input: T): Simplify<T & { kind: 'file' }> {
  return {
    kind: 'file',
    ...input,
  } as Simplify<T & { kind: 'file' }>;
}

export function defineImage<
  const T extends Omit<FileDefinition & { kind: 'image' }, 'kind'>
>(input: T): Simplify<T & { kind: 'image' }> {
  return {
    kind: 'image',
    ...input,
  } as Simplify<T & { kind: 'image' }>;
}

export function defineEvent<
  const TColumns extends string[] = [],
  const TOptions extends Partial<EventDefinition> = {}
>(columns: TColumns = [] as unknown as TColumns, options: TOptions = {} as TOptions): Simplify<{ columns: TColumns } & TOptions> {
  return {
    columns,
    ...options,
  } as Simplify<{ columns: TColumns } & TOptions>;
}

export function defineBasicEvent<
  const TOptions extends Partial<Omit<EventDefinition, 'columns'>> = {}
>(options: TOptions = {} as TOptions): Simplify<{ columns: [] } & TOptions> {
  return {
    columns: [],
    ...options,
  } as Simplify<{ columns: [] } & TOptions>;
}

export function defineSchema<
  const T extends Omit<SchemaDocument, 'version'>
>(input: T): Simplify<T & { version: 1 }> {
  return {
    version: 1,
    ...input,
  } as Simplify<T & { version: 1 }>;
}
