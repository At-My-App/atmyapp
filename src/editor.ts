export const MONACO_STRUCTURE_TYPES = `
declare module "@atmyapp/structure" {
  type Simplify<T> = { [K in keyof T]: T[K] } & {};

  export type DefinitionKind =
    | "collection"
    | "document"
    | "file"
    | "image"
    | "system_config";
  export type FieldKind =
    | "scalar"
    | "object"
    | "array"
    | "enum"
    | "union"
    | "asset"
    | "reference"
    | "mdx"
    | "slug";
  export type ScalarType =
    | "string"
    | "number"
    | "boolean"
    | "null"
    | "date"
    | "datetime"
    | "timestamp";
  export type StringFieldFormat =
    | "short"
    | "long"
    | "markdown"
    | "email"
    | "url"
    | "slug"
    | "code"
    | "textarea"
    | "date"
    | "datetime"
    | "timestamp";
  export type NumberFieldFormat = "integer" | "percent" | "currency";
  export type AssetKind = "image" | "file" | "gallery";
  export type ReferenceResolveBy = "id" | "slug" | "path";

  export interface FieldBase {
    kind: FieldKind;
    description?: string;
    optional?: boolean;
    required?: boolean;
    unique?: boolean;
    default?: unknown;
    legacy?: Record<string, unknown>;
    storage?: Record<string, unknown>;
    ui?: Record<string, unknown>;
  }

  export interface ScalarFieldDefinition extends FieldBase {
    kind: "scalar";
    scalar: ScalarType;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    preferredLength?: number;
    step?: number;
    pattern?: string;
    enumValues?: Array<string | number | boolean | null>;
    format?: StringFieldFormat | NumberFieldFormat | (string & {});
    placeholder?: string;
    examples?: Array<string | number | boolean | null>;
    integer?: boolean;
  }

  export interface EnumFieldDefinition extends FieldBase {
    kind: "enum";
    values: Array<string | number | boolean | null>;
  }

  export interface ObjectFieldDefinition extends FieldBase {
    kind: "object";
    fields: Record<string, FieldDefinition>;
    additionalProperties?: boolean;
  }

  export interface ArrayFieldDefinition extends FieldBase {
    kind: "array";
    items: FieldDefinition;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
  }

  export interface UnionFieldDefinition extends FieldBase {
    kind: "union";
    variants: FieldDefinition[];
  }

  export interface AssetFieldDefinition extends FieldBase {
    kind: "asset";
    assetKind: AssetKind;
    multiple?: boolean;
    accept?: string[];
    config?: Record<string, unknown>;
    imageOptions?: Record<string, unknown>;
    deletePolicy?: "detach" | "delete";
    orphanPolicy?: "allow" | "delete";
  }

  export interface ReferenceFieldDefinition extends FieldBase {
    kind: "reference";
    target: string;
    multiple?: boolean;
    by?: ReferenceResolveBy;
    targetField?: string;
    onDelete?: "restrict" | "nullify" | "cascade";
  }

  export interface MdxFieldDefinition extends FieldBase {
    kind: "mdx";
    config: string;
  }

  export interface SlugFieldDefinition extends FieldBase {
    kind: "slug";
    source?: string;
    generated?: boolean;
    immutable?: boolean;
    updatePolicy?: "immutable" | "on_change";
  }

  export type FieldDefinition =
    | ScalarFieldDefinition
    | EnumFieldDefinition
    | ObjectFieldDefinition
    | ArrayFieldDefinition
    | UnionFieldDefinition
    | AssetFieldDefinition
    | ReferenceFieldDefinition
    | MdxFieldDefinition
    | SlugFieldDefinition;

  export interface CollectionDefinition {
    kind: "collection";
    name?: string;
    description?: string;
    systemFields?: Record<string, unknown>;
    fields: Record<string, FieldDefinition>;
    indexes?: Array<string | string[]>;
  }

  export interface DocumentDefinition {
    kind: "document";
    name?: string;
    description?: string;
    systemFields?: Record<string, unknown>;
    path?: string;
    fields: Record<string, FieldDefinition>;
  }

  export interface SystemConfigDefinition {
    kind: "system_config";
    name?: string;
    description?: string;
    systemFields?: Record<string, unknown>;
    framework: string;
    systemKey: string;
    displayName: string;
    path: string;
    fields: Record<string, FieldDefinition>;
    managedBy: "framework_preset" | (string & {});
  }

  export interface FileDefinition {
    kind: "file" | "image";
    name?: string;
    description?: string;
    systemFields?: Record<string, unknown>;
    path: string;
    config?: Record<string, unknown>;
  }

  export type Definition =
    | CollectionDefinition
    | DocumentDefinition
    | SystemConfigDefinition
    | FileDefinition;

  export interface EventDefinition {
    description?: string;
    columns: string[];
  }

  export type SubmissionCaptchaProvider = "hcaptcha" | (string & {});

  export interface SubmissionCaptchaConfig {
    required?: boolean;
    provider?: SubmissionCaptchaProvider;
    secret?: string;
  }

  export interface SubmissionDefinition {
    description?: string;
    fields: Record<string, FieldDefinition>;
    captcha?: SubmissionCaptchaConfig;
  }

  export interface SchemaDocument {
    version: 1;
    description?: string;
    definitions: Record<string, Definition>;
    events?: Record<string, EventDefinition>;
    args?: Record<string, unknown>;
    mdx?: Record<string, unknown>;
    submissions?: Record<string, SubmissionDefinition>;
  }

  export type StringFieldOptions = Partial<
    Omit<ScalarFieldDefinition, "kind" | "scalar" | "minimum" | "maximum">
  > & {
    min?: number;
    max?: number;
    format?: StringFieldFormat | (string & {});
  };

  export type NumberFieldOptions = Partial<
    Omit<ScalarFieldDefinition, "kind" | "scalar" | "minLength" | "maxLength">
  > & {
    min?: number;
    max?: number;
    format?: NumberFieldFormat | (string & {});
  };

  export type BooleanFieldOptions = Partial<
    Omit<ScalarFieldDefinition, "kind" | "scalar">
  >;
  export type DateFieldOptions = Partial<
    Omit<ScalarFieldDefinition, "kind" | "scalar">
  >;
  export type ObjectFieldOptions = Partial<
    Omit<ObjectFieldDefinition, "kind" | "fields">
  >;
  export type ArrayFieldOptions = Partial<
    Omit<ArrayFieldDefinition, "kind" | "items">
  >;
  export type EnumFieldOptions = Partial<
    Omit<EnumFieldDefinition, "kind" | "values">
  >;
  export type UnionFieldOptions = Partial<
    Omit<UnionFieldDefinition, "kind" | "variants">
  >;
  export type AssetFieldOptions = Partial<
    Omit<AssetFieldDefinition, "kind" | "assetKind" | "multiple">
  >;
  export type ReferenceFieldOptions = Partial<
    Omit<ReferenceFieldDefinition, "kind" | "target">
  >;
  export type MdxFieldOptions = Partial<
    Omit<MdxFieldDefinition, "kind" | "config">
  >;
  export type SlugFieldOptions = Partial<Omit<SlugFieldDefinition, "kind">>;
  export type EventOptions = Partial<Omit<EventDefinition, "columns">>;
  export type SubmissionOptions = Partial<
    Omit<SubmissionDefinition, "fields">
  >;

  export type ObjectFieldInput<
    TFields extends Record<string, FieldDefinition>,
  > = Simplify<{ fields: TFields } & ObjectFieldOptions>;
  export type ArrayFieldInput<TItems extends FieldDefinition> = Simplify<
    { items: TItems } & ArrayFieldOptions
  >;
  export type EnumFieldInput<
    TValues extends EnumFieldDefinition["values"],
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

  export const s: {
    string<const TOptions extends StringFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "string" } & TOptions>;
    shortText<const TOptions extends StringFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "string"; format: "short"; preferredLength: number } & TOptions>;
    longText<const TOptions extends StringFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "string"; format: "long"; preferredLength: number } & TOptions>;
    markdown<const TOptions extends StringFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "string"; format: "markdown"; preferredLength: number } & TOptions>;
    email<const TOptions extends StringFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "string"; format: "email" } & TOptions>;
    url<const TOptions extends StringFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "string"; format: "url" } & TOptions>;
    number<const TOptions extends NumberFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "number" } & TOptions>;
    integer<const TOptions extends NumberFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "number"; integer: true; format: "integer"; step: number } & TOptions>;
    boolean<const TOptions extends BooleanFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "boolean" } & TOptions>;
    date<const TOptions extends DateFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "date"; format: "date" } & TOptions>;
    datetime<const TOptions extends DateFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "datetime"; format: "datetime" } & TOptions>;
    timestamp<const TOptions extends DateFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "scalar"; scalar: "timestamp"; format: "timestamp" } & TOptions>;
    object<
      const TFields extends Record<string, FieldDefinition>,
      const TInput extends ObjectFieldInput<TFields>,
    >(
      input: TInput,
    ): Simplify<{ kind: "object"; fields: TFields } & Omit<TInput, "fields">>;
    array<
      const TItems extends FieldDefinition,
      const TInput extends ArrayFieldInput<TItems>,
    >(
      input: TInput,
    ): Simplify<{ kind: "array"; items: TItems } & Omit<TInput, "items">>;
    enum<
      const TValues extends EnumFieldDefinition["values"],
      const TInput extends EnumFieldInput<TValues>,
    >(
      input: TInput,
    ): Simplify<{ kind: "enum"; values: TValues } & Omit<TInput, "values">>;
    union<
      const TVariants extends FieldDefinition[],
      const TInput extends UnionFieldInput<TVariants>,
    >(
      input: TInput,
    ): Simplify<{ kind: "union"; variants: TVariants } & Omit<TInput, "variants">>;
    image<const TOptions extends AssetFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "asset"; assetKind: "image"; multiple: false } & TOptions>;
    file<const TOptions extends AssetFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "asset"; assetKind: "file"; multiple: false } & TOptions>;
    gallery<const TOptions extends AssetFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "asset"; assetKind: "gallery"; multiple: true } & TOptions>;
    reference<
      const TTarget extends string,
      const TInput extends ReferenceFieldInput<TTarget>,
    >(
      input: TInput,
    ): Simplify<{ kind: "reference"; target: TTarget } & Omit<TInput, "target">>;
    mdx<
      const TConfig extends string,
      const TInput extends MdxFieldInput<TConfig>,
    >(
      input: TInput,
    ): Simplify<{ kind: "mdx"; config: TConfig } & Omit<TInput, "config">>;
    slug<const TOptions extends SlugFieldOptions = {}>(
      options?: TOptions,
    ): Simplify<{ kind: "slug"; unique: true; generated: true; immutable: true; updatePolicy: "immutable" } & TOptions>;
  };

  export interface FileAssetValue {
    url: string;
    name?: string;
    mimeType?: string;
  }

  export interface ImageAssetValue extends FileAssetValue {
    alt?: string;
  }

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
    TField["scalar"] extends "string"
      ? string
      : TField["scalar"] extends "number"
      ? number
      : TField["scalar"] extends "boolean"
      ? boolean
      : TField["scalar"] extends "null"
      ? null
      : string;

  type EnumValue<TField extends EnumFieldDefinition> = TField["values"][number];

  type ReferenceValue<TField extends ReferenceFieldDefinition> =
    TField["multiple"] extends true ? string[] : string;

  export type AssetValue<TKind extends AssetKind = AssetKind> = TKind extends
    | "image"
    | "gallery"
    ? ImageAssetValue
    : FileAssetValue;

  export interface SubmissionBinaryLike {
    arrayBuffer(): Promise<ArrayBuffer>;
    type?: string;
    size?: number;
  }

  export type SubmissionAssetInput<TKind extends AssetKind = AssetKind> =
    Simplify<
      {
        file: SubmissionBinaryLike;
        name?: string;
        mimeType?: string;
      } & (TKind extends "image" | "gallery" ? { alt?: string } : {})
    >;

  type SingleAssetValue<TField extends AssetFieldDefinition> = AssetValue<
    TField["assetKind"]
  >;

  type AssetFieldValue<TField extends AssetFieldDefinition> =
    TField["assetKind"] extends "gallery"
      ? ImageAssetValue[]
      : TField["multiple"] extends true
      ? SingleAssetValue<TField>[]
      : SingleAssetValue<TField>;

  type SingleSubmissionAssetValue<TField extends AssetFieldDefinition> =
    | SubmissionBinaryLike
    | SubmissionAssetInput<TField["assetKind"]>;

  type SubmissionAssetFieldValue<TField extends AssetFieldDefinition> =
    TField["assetKind"] extends "gallery"
      ? Array<SubmissionBinaryLike | SubmissionAssetInput<"image">>
      : TField["multiple"] extends true
      ? SingleSubmissionAssetValue<TField>[]
      : SingleSubmissionAssetValue<TField>;

  type GeneratedSystemFields<
    TDefinition extends CollectionDefinition | DocumentDefinition | SystemConfigDefinition,
  > = TDefinition extends { systemFields?: { slug?: infer TSlug } }
    ? TSlug extends false | undefined | null
      ? {}
      : TSlug extends { enabled: false }
      ? {}
      : { slug: string }
    : {};

  type ExtractDefinitions<TSchema> = TSchema extends {
    definitions: infer TDefinitions;
  }
    ? TDefinitions extends Record<string, Definition>
      ? TDefinitions
      : {}
    : TSchema extends Record<string, Definition>
    ? TSchema
    : {};

  type ExtractSubmissions<TSchema> = TSchema extends {
    submissions: infer TSubmissions;
  }
    ? TSubmissions extends Record<string, SubmissionDefinition>
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

  export type FieldValue<TField extends FieldDefinition> =
    TField extends ScalarFieldDefinition
      ? ScalarValue<TField>
      : TField extends EnumFieldDefinition
      ? EnumValue<TField>
      : TField extends ObjectFieldDefinition
      ? StructuredObjectValue<TField["fields"]>
      : TField extends ArrayFieldDefinition
      ? FieldValue<TField["items"]>[]
      : TField extends AssetFieldDefinition
      ? AssetFieldValue<TField>
      : TField extends ReferenceFieldDefinition
      ? ReferenceValue<TField>
      : TField extends {
          kind: "union";
          variants: infer TVariants extends FieldDefinition[];
        }
      ? FieldValue<TVariants[number]>
      : TField extends { kind: "mdx" | "slug" }
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

  export type SubmissionFieldValue<TField extends FieldDefinition> =
    TField extends ScalarFieldDefinition
      ? ScalarValue<TField>
      : TField extends EnumFieldDefinition
      ? EnumValue<TField>
      : TField extends ObjectFieldDefinition
      ? StructuredSubmissionObjectValue<TField["fields"]>
      : TField extends ArrayFieldDefinition
      ? SubmissionFieldValue<TField["items"]>[]
      : TField extends AssetFieldDefinition
      ? SubmissionAssetFieldValue<TField>
      : TField extends ReferenceFieldDefinition
      ? ReferenceValue<TField>
      : TField extends {
          kind: "union";
          variants: infer TVariants extends FieldDefinition[];
        }
      ? SubmissionFieldValue<TVariants[number]>
      : TField extends { kind: "mdx" | "slug" }
      ? string
      : never;

  export type EntryType<
    TDefinition extends CollectionDefinition | DocumentDefinition | SystemConfigDefinition,
  > = Simplify<
    StructuredObjectValue<TDefinition["fields"]> &
      GeneratedSystemFields<TDefinition>
  >;

  export type DefinitionType<TDefinition extends Definition> =
    TDefinition extends CollectionDefinition | DocumentDefinition | SystemConfigDefinition
      ? EntryType<TDefinition>
      : TDefinition extends FileDefinition
      ? TDefinition["kind"] extends "image"
        ? ImageAssetValue
        : FileAssetValue
      : never;

  export type SubmissionType<TSubmission extends SubmissionDefinition> =
    StructuredSubmissionObjectValue<ExtractSubmissionFields<TSubmission>>;

  export type InferDefinition<TName extends string, TSchema> =
    TName extends keyof ExtractDefinitions<TSchema>
      ? DefinitionType<Extract<ExtractDefinitions<TSchema>[TName], Definition>>
      : never;

  export type InferSubmission<TName extends string, TSchema> =
    TName extends keyof ExtractSubmissions<TSchema>
      ? SubmissionType<
          Extract<ExtractSubmissions<TSchema>[TName], SubmissionDefinition>
        >
      : never;

  export type InferSchemaTypes<TSchema> = Simplify<{
    [K in keyof ExtractDefinitions<TSchema>]: DefinitionType<
      Extract<ExtractDefinitions<TSchema>[K], Definition>
    >;
  }>;

  export function compileSchema(input: SchemaDocument | Record<string, unknown>): any;
  export function defineSchema<
    const T extends Omit<SchemaDocument, "version">,
  >(input: T): Simplify<T & { version: 1 }>;
  export function defineCollection<
    const T extends Omit<CollectionDefinition, "kind">,
  >(input: T): Simplify<T & { kind: "collection" }>;
  export function defineDocument<
    const T extends Omit<DocumentDefinition, "kind">,
  >(input: T): Simplify<T & { kind: "document" }>;
  export function defineSystemConfig<
    const T extends Omit<SystemConfigDefinition, "kind">,
  >(input: T): Simplify<T & { kind: "system_config" }>;
  export function defineFile<
    const T extends Omit<FileDefinition & { kind: "file" }, "kind">,
  >(input: T): Simplify<T & { kind: "file" }>;
  export function defineImage<
    const T extends Omit<FileDefinition & { kind: "image" }, "kind">,
  >(input: T): Simplify<T & { kind: "image" }>;
  export function defineSubmission<
    const TFields extends Record<string, FieldDefinition>,
    const TInput extends SubmissionInput<TFields>,
  >(input: TInput): TInput;
  export function defineEvent<
    const TColumns extends string[] = [],
    const TOptions extends EventOptions = {},
  >(
    columns?: TColumns,
    options?: TOptions,
  ): Simplify<{ columns: TColumns } & TOptions>;
  export function defineEvent<
    const TColumns extends string[],
    const TInput extends EventInput<TColumns>,
  >(input: TInput): TInput;
  export function defineBasicEvent<const TOptions extends EventOptions = {}>(
    options?: TOptions,
  ): Simplify<{ columns: [] } & TOptions>;
}
`;
