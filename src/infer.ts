import type {
  ArrayFieldDefinition,
  AssetFieldDefinition,
  AssetKind,
  CollectionDefinition,
  Definition,
  DocumentDefinition,
  EnumFieldDefinition,
  FieldBase,
  FieldDefinition,
  FileDefinition,
  ObjectFieldDefinition,
  ReferenceFieldDefinition,
  ScalarFieldDefinition,
} from './types';

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type IsOptionalField<TField extends FieldBase> =
  TField extends { optional: true }
    ? true
    : TField extends { required: false }
    ? true
    : false;

type OptionalFieldKeys<TFields extends Record<string, FieldDefinition>> = {
  [K in keyof TFields]-?: IsOptionalField<TFields[K]> extends true ? K : never;
}[keyof TFields];

type RequiredFieldKeys<TFields extends Record<string, FieldDefinition>> = Exclude<
  keyof TFields,
  OptionalFieldKeys<TFields>
>;

type StructuredObjectValue<TFields extends Record<string, FieldDefinition>> = Simplify<
  {
    [K in RequiredFieldKeys<TFields>]: FieldValue<TFields[K]>;
  } & {
    [K in OptionalFieldKeys<TFields>]?: FieldValue<TFields[K]>;
  }
>;

type ScalarValue<TField extends ScalarFieldDefinition> =
  TField['scalar'] extends 'string'
    ? string
    : TField['scalar'] extends 'number'
    ? number
    : TField['scalar'] extends 'boolean'
    ? boolean
    : TField['scalar'] extends 'null'
    ? null
    : string;

type EnumValue<TField extends EnumFieldDefinition> = TField['values'][number];

type ReferenceValue<TField extends ReferenceFieldDefinition> = TField['multiple'] extends true
  ? string[]
  : string;

export interface FileAssetValue {
  url: string;
  name?: string;
  mimeType?: string;
}

export interface ImageAssetValue extends FileAssetValue {
  alt?: string;
}

export type AssetValue<TKind extends AssetKind = AssetKind> = TKind extends
  | 'image'
  | 'gallery'
  ? ImageAssetValue
  : FileAssetValue;

type SingleAssetValue<TField extends AssetFieldDefinition> = AssetValue<
  TField['assetKind']
>;

type AssetFieldValue<TField extends AssetFieldDefinition> = TField['assetKind'] extends 'gallery'
  ? ImageAssetValue[]
  : TField['multiple'] extends true
  ? SingleAssetValue<TField>[]
  : SingleAssetValue<TField>;

type GeneratedSystemFields<TDefinition extends CollectionDefinition | DocumentDefinition> =
  TDefinition extends { systemFields?: { slug?: infer TSlug } }
    ? TSlug extends false | undefined | null
      ? {}
      : TSlug extends { enabled: false }
      ? {}
      : { slug: string }
    : {};

export type FieldValue<TField extends FieldDefinition> = TField extends ScalarFieldDefinition
  ? ScalarValue<TField>
  : TField extends EnumFieldDefinition
  ? EnumValue<TField>
  : TField extends ObjectFieldDefinition
  ? StructuredObjectValue<TField['fields']>
  : TField extends ArrayFieldDefinition
  ? FieldValue<TField['items']>[]
  : TField extends AssetFieldDefinition
  ? AssetFieldValue<TField>
  : TField extends ReferenceFieldDefinition
  ? ReferenceValue<TField>
  : TField extends { kind: 'union'; variants: infer TVariants extends FieldDefinition[] }
  ? FieldValue<TVariants[number]>
  : TField extends { kind: 'mdx' | 'slug' }
  ? string
  : never;

export type EntryType<TDefinition extends CollectionDefinition | DocumentDefinition> = Simplify<
  StructuredObjectValue<TDefinition['fields']> & GeneratedSystemFields<TDefinition>
>;

export type DefinitionType<TDefinition extends Definition> = TDefinition extends
  | CollectionDefinition
  | DocumentDefinition
  ? EntryType<TDefinition>
  : TDefinition extends FileDefinition
  ? TDefinition['kind'] extends 'image'
    ? ImageAssetValue
    : FileAssetValue
  : never;
