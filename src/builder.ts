import type {
  ArrayFieldDefinition,
  AssetFieldDefinition,
  CollectionDefinition,
  Definition,
  DocumentDefinition,
  EnumFieldDefinition,
  EventDefinition,
  FieldBase,
  FieldDefinition,
  FileDefinition,
  MdxFieldDefinition,
  NumberFieldFormat,
  ObjectFieldDefinition,
  ReferenceFieldDefinition,
  ScalarFieldDefinition,
  SchemaDocument,
  SubmissionDefinition,
  SystemConfigDefinition,
  SlugFieldDefinition,
  StringFieldFormat,
  UnionFieldDefinition,
} from './types';

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type FieldOptions = Partial<Omit<FieldBase, 'kind'>>;

export type StringFieldOptions = Partial<
  Omit<ScalarFieldDefinition, 'kind' | 'scalar' | 'minimum' | 'maximum'>
> & {
  min?: number;
  max?: number;
  format?: StringFieldFormat | (string & {});
};

export type NumberFieldOptions = Partial<
  Omit<ScalarFieldDefinition, 'kind' | 'scalar' | 'minLength' | 'maxLength'>
> & {
  min?: number;
  max?: number;
  format?: NumberFieldFormat | (string & {});
};

export type BooleanFieldOptions = Partial<
  Omit<ScalarFieldDefinition, 'kind' | 'scalar'>
>;

export type DateFieldOptions = Partial<
  Omit<ScalarFieldDefinition, 'kind' | 'scalar'>
>;

export type ObjectFieldOptions = Partial<
  Omit<ObjectFieldDefinition, 'kind' | 'fields'>
>;

export type ArrayFieldOptions = Partial<
  Omit<ArrayFieldDefinition, 'kind' | 'items'>
>;

export type EnumFieldOptions = Partial<
  Omit<EnumFieldDefinition, 'kind' | 'values'>
>;

export type UnionFieldOptions = Partial<
  Omit<UnionFieldDefinition, 'kind' | 'variants'>
>;

export type AssetFieldOptions = Partial<
  Omit<AssetFieldDefinition, 'kind' | 'assetKind' | 'multiple'>
>;

export type ReferenceFieldOptions = Partial<
  Omit<ReferenceFieldDefinition, 'kind' | 'target'>
>;

export type MdxFieldOptions = Partial<
  Omit<MdxFieldDefinition, 'kind' | 'config'>
>;

export type SlugFieldOptions = Partial<Omit<SlugFieldDefinition, 'kind'>>;

export type EventOptions = Partial<Omit<EventDefinition, 'columns'>>;
export type SubmissionOptions = Partial<Omit<SubmissionDefinition, 'fields'>>;

export type ObjectFieldInput<
  TFields extends Record<string, FieldDefinition>,
> = Simplify<{ fields: TFields } & ObjectFieldOptions>;

export type ArrayFieldInput<TItems extends FieldDefinition> = Simplify<
  { items: TItems } & ArrayFieldOptions
>;

export type EnumFieldInput<
  TValues extends EnumFieldDefinition['values'],
> = Simplify<{ values: TValues } & EnumFieldOptions>;

export type UnionFieldInput<TVariants extends FieldDefinition[]> = Simplify<
  { variants: TVariants } & UnionFieldOptions
>;

export type ReferenceFieldInput<TTarget extends string> = Simplify<
  { target: TTarget } & ReferenceFieldOptions
>;

export type MdxFieldInput<TConfig extends string> = Simplify<
  { config: TConfig } & MdxFieldOptions
>;

export type EventInput<TColumns extends string[] = []> = Simplify<
  { columns: TColumns } & EventOptions
>;

export type SubmissionInput<
  TFields extends Record<string, FieldDefinition>,
> = Simplify<{ fields: TFields } & SubmissionOptions>;

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

function splitConfig<
  const TInput extends Record<string, unknown>,
  const TKey extends keyof TInput,
>(input: TInput, key: TKey): [TInput[TKey], Simplify<Omit<TInput, TKey>>] {
  const { [key]: value, ...options } = input;
  return [value, options as Simplify<Omit<TInput, TKey>>];
}

function objectField<
  const TFields extends Record<string, FieldDefinition>,
  const TInput extends ObjectFieldInput<TFields>,
>(input: TInput) {
  const [fields, options] = splitConfig(input, 'fields');
  return withFieldBase({ kind: 'object', fields }, options);
}

function arrayField<
  const TItems extends FieldDefinition,
  const TInput extends ArrayFieldInput<TItems>,
>(input: TInput) {
  const [items, options] = splitConfig(input, 'items');
  return withFieldBase({ kind: 'array', items }, options);
}

function enumField<
  const TValues extends EnumFieldDefinition['values'],
  const TInput extends EnumFieldInput<TValues>,
>(input: TInput) {
  const [values, options] = splitConfig(input, 'values');
  return withFieldBase({ kind: 'enum', values }, options);
}

function unionField<
  const TVariants extends FieldDefinition[],
  const TInput extends UnionFieldInput<TVariants>,
>(input: TInput) {
  const [variants, options] = splitConfig(input, 'variants');
  return withFieldBase({ kind: 'union', variants }, options);
}

function referenceField<
  const TTarget extends string,
  const TInput extends ReferenceFieldInput<TTarget>,
>(input: TInput) {
  const [target, options] = splitConfig(input, 'target');
  return withFieldBase({ kind: 'reference', target }, options);
}

function mdxField<
  const TConfig extends string,
  const TInput extends MdxFieldInput<TConfig>,
>(input: TInput) {
  const [config, options] = splitConfig(input, 'config');
  return withFieldBase({ kind: 'mdx', config }, options);
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
      localize: true,
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
      localize: true,
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
      localize: true,
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
  boolean<const TOptions extends BooleanFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase({ kind: 'scalar', scalar: 'boolean' }, options);
  },
  date<const TOptions extends DateFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase({ kind: 'scalar', scalar: 'date', format: 'date' }, options);
  },
  datetime<const TOptions extends DateFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase(
      { kind: 'scalar', scalar: 'datetime', format: 'datetime' },
      options
    );
  },
  timestamp<const TOptions extends DateFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase(
      { kind: 'scalar', scalar: 'timestamp', format: 'timestamp' },
      options
    );
  },
  object: objectField,
  array: arrayField,
  enum: enumField,
  union: unionField,
  image<const TOptions extends AssetFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase({ kind: 'asset', assetKind: 'image', multiple: false }, options);
  },
  file<const TOptions extends AssetFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase({ kind: 'asset', assetKind: 'file', multiple: false }, options);
  },
  gallery<const TOptions extends AssetFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
    return withFieldBase({ kind: 'asset', assetKind: 'gallery', multiple: true }, options);
  },
  reference: referenceField,
  mdx: mdxField,
  slug<const TOptions extends SlugFieldOptions = {}>(
    options: TOptions = {} as TOptions
  ) {
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

export function defineSystemConfig<
  const T extends Omit<SystemConfigDefinition, 'kind'>
>(input: T): Simplify<T & { kind: 'system_config' }> {
  return {
    kind: 'system_config',
    ...input,
  } as Simplify<T & { kind: 'system_config' }>;
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
  const TOptions extends EventOptions = {}
>(
  columns?: TColumns,
  options?: TOptions
): Simplify<{ columns: TColumns } & TOptions>;
export function defineEvent<
  const TColumns extends string[],
  const TInput extends EventInput<TColumns>,
>(input: TInput): TInput;
export function defineEvent<
  const TColumns extends string[] = [],
  const TOptions extends EventOptions = {},
>(
  columnsOrInput: TColumns | EventInput<TColumns> = [] as unknown as TColumns,
  options: TOptions = {} as TOptions
): Simplify<{ columns: TColumns } & TOptions> | EventInput<TColumns> {
  if (Array.isArray(columnsOrInput)) {
    return {
      columns: columnsOrInput,
      ...options,
    } as Simplify<{ columns: TColumns } & TOptions>;
  }

  return {
    ...columnsOrInput,
  } as EventInput<TColumns>;
}

export function defineSubmission<
  const TFields extends Record<string, FieldDefinition>,
  const TInput extends SubmissionInput<TFields>,
>(input: TInput): TInput {
  return {
    ...input,
  } as TInput;
}

export function defineBasicEvent<
  const TOptions extends EventOptions = {}
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
