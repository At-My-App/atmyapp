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
  LegacySubmissionDefinition,
  ObjectFieldDefinition,
  ReferenceFieldDefinition,
  ScalarFieldDefinition,
  SubmissionDefinition,
} from './types';

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type ExtractDefinitions<TSchema> = TSchema extends { definitions: infer TDefinitions }
  ? TDefinitions extends Record<string, Definition>
    ? TDefinitions
    : {}
  : TSchema extends Record<string, Definition>
  ? TSchema
  : {};

type ExtractSubmissions<TSchema> = TSchema extends { submissions: infer TSubmissions }
  ? TSubmissions extends Record<string, SubmissionDefinition | LegacySubmissionDefinition>
    ? TSubmissions
    : {}
  : {};

type ExtractSubmissionFields<TSubmission> = TSubmission extends {
  fields: infer TFields;
}
  ? TFields extends Record<string, FieldDefinition>
    ? TFields
    : {}
  : {};

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

export interface SubmissionBinaryLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  type?: string;
  size?: number;
}

export type SubmissionAssetInput<TKind extends AssetKind = AssetKind> = Simplify<
  {
    file: SubmissionBinaryLike;
    name?: string;
    mimeType?: string;
  } & (TKind extends 'image' | 'gallery' ? { alt?: string } : {})
>;

type SingleAssetValue<TField extends AssetFieldDefinition> = AssetValue<
  TField['assetKind']
>;

type AssetFieldValue<TField extends AssetFieldDefinition> = TField['assetKind'] extends 'gallery'
  ? ImageAssetValue[]
  : TField['multiple'] extends true
  ? SingleAssetValue<TField>[]
  : SingleAssetValue<TField>;

type SingleSubmissionAssetValue<
  TField extends AssetFieldDefinition,
> = SubmissionBinaryLike | SubmissionAssetInput<TField['assetKind']>;

type SubmissionAssetFieldValue<
  TField extends AssetFieldDefinition,
> = TField['assetKind'] extends 'gallery'
  ? Array<SubmissionBinaryLike | SubmissionAssetInput<'image'>>
  : TField['multiple'] extends true
  ? SingleSubmissionAssetValue<TField>[]
  : SingleSubmissionAssetValue<TField>;

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

export type SubmissionFieldValue<TField extends FieldDefinition> = TField extends ScalarFieldDefinition
  ? ScalarValue<TField>
  : TField extends EnumFieldDefinition
  ? EnumValue<TField>
  : TField extends ObjectFieldDefinition
  ? StructuredSubmissionObjectValue<TField['fields']>
  : TField extends ArrayFieldDefinition
  ? SubmissionFieldValue<TField['items']>[]
  : TField extends AssetFieldDefinition
  ? SubmissionAssetFieldValue<TField>
  : TField extends ReferenceFieldDefinition
  ? ReferenceValue<TField>
  : TField extends { kind: 'union'; variants: infer TVariants extends FieldDefinition[] }
  ? SubmissionFieldValue<TVariants[number]>
  : TField extends { kind: 'mdx' | 'slug' }
  ? string
  : never;

type StructuredSubmissionObjectValue<
  TFields extends Record<string, FieldDefinition>,
> = Simplify<
  {
    [K in RequiredFieldKeys<TFields>]: SubmissionFieldValue<TFields[K]>;
  } & {
    [K in OptionalFieldKeys<TFields>]?: SubmissionFieldValue<TFields[K]>;
  }
>;

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

export type SubmissionType<
  TSubmission extends SubmissionDefinition | LegacySubmissionDefinition,
> = StructuredSubmissionObjectValue<ExtractSubmissionFields<TSubmission>>;

export type InferDefinition<TName extends string, TSchema> = TName extends keyof ExtractDefinitions<TSchema>
  ? DefinitionType<Extract<ExtractDefinitions<TSchema>[TName], Definition>>
  : never;

export type InferSubmission<TName extends string, TSchema> =
  TName extends keyof ExtractSubmissions<TSchema>
    ? SubmissionType<
        Extract<
          ExtractSubmissions<TSchema>[TName],
          SubmissionDefinition | LegacySubmissionDefinition
        >
      >
    : never;

export type InferSchemaTypes<TSchema> = Simplify<{
  [K in keyof ExtractDefinitions<TSchema>]: DefinitionType<
    Extract<ExtractDefinitions<TSchema>[K], Definition>
  >;
}>;
