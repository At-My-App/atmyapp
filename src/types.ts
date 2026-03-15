export type DefinitionKind = 'collection' | 'document' | 'file' | 'image';
export type FieldKind =
  | 'scalar'
  | 'object'
  | 'array'
  | 'enum'
  | 'union'
  | 'asset'
  | 'reference'
  | 'mdx'
  | 'slug';
export type ScalarType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'date'
  | 'datetime'
  | 'timestamp';
export type AssetKind = 'image' | 'file' | 'gallery';
export type SystemFieldName = 'id' | 'createdAt' | 'updatedAt' | 'slug';
export type ReferenceResolveBy = 'id' | 'slug' | 'path';
export type LegacyDefinitionType =
  | 'collection'
  | 'document'
  | 'jsonx'
  | 'file'
  | 'image';
export type MigrationCompatibilityClass =
  | 'safe_auto_convert'
  | 'confirmable_convert'
  | 'incompatible'
  | 'compatible';
export type MigrationActionType =
  | 'auto_convert'
  | 'confirm_convert'
  | 'require_union'
  | 'require_clear'
  | 'require_manual_migration'
  | 'backfill_generated_field'
  | 'create_unique_index'
  | 'drop_definition'
  | 'drop_field';

export interface MdxComponentConfig {
  description?: string;
  props?: Record<string, string>;
}

export interface MdxConfigDefinition {
  description?: string;
  components: Record<string, MdxComponentConfig>;
}

export interface EventDefinition {
  description?: string;
  columns: string[];
}

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

export interface ImageAssetConfig {
  optimizeFormat?: 'webp' | 'none';
  optimizeLoad?: 'progressive' | 'none';
  ratioHint?: {
    x: number;
    y: number;
  };
  maxSize?: {
    width: number;
    height: number;
  };
}

export interface FileAssetConfig {
  contentType?: string;
}

export interface ScalarFieldDefinition extends FieldBase {
  kind: 'scalar';
  scalar: ScalarType;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enumValues?: Array<string | number | boolean | null>;
  format?: string;
}

export interface EnumFieldDefinition extends FieldBase {
  kind: 'enum';
  values: Array<string | number | boolean | null>;
}

export interface ObjectFieldDefinition extends FieldBase {
  kind: 'object';
  fields: Record<string, FieldDefinition>;
  additionalProperties?: boolean;
}

export interface ArrayFieldDefinition extends FieldBase {
  kind: 'array';
  items: FieldDefinition;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface UnionFieldDefinition extends FieldBase {
  kind: 'union';
  variants: FieldDefinition[];
}

export interface AssetFieldDefinition extends FieldBase {
  kind: 'asset';
  assetKind: AssetKind;
  multiple?: boolean;
  accept?: string[];
  config?: ImageAssetConfig | FileAssetConfig | Record<string, unknown>;
  imageOptions?: Record<string, unknown>;
  deletePolicy?: 'detach' | 'delete';
  orphanPolicy?: 'allow' | 'delete';
}

export interface ReferenceFieldDefinition extends FieldBase {
  kind: 'reference';
  target: string;
  multiple?: boolean;
  by?: ReferenceResolveBy;
  targetField?: string;
  onDelete?: 'restrict' | 'nullify' | 'cascade';
}

export interface MdxFieldDefinition extends FieldBase {
  kind: 'mdx';
  config: string;
}

export interface SlugFieldDefinition extends FieldBase {
  kind: 'slug';
  source?: string;
  generated?: boolean;
  immutable?: boolean;
  updatePolicy?: 'immutable' | 'on_change';
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

export interface SystemFieldDefinition {
  name: SystemFieldName;
  enabled: boolean;
  readable: boolean;
  queryable: boolean;
  generated: boolean;
  immutable: boolean;
  unique: boolean;
  settable: boolean;
  requiredInStoredShape: boolean;
  source?: string;
  updatePolicy?: 'immutable' | 'on_change';
}

export type SystemFieldInput =
  | boolean
  | Partial<Omit<SystemFieldDefinition, 'name'>>;

export interface DefinitionBase {
  kind: DefinitionKind;
  name?: string;
  description?: string;
  systemFields?: Partial<Record<SystemFieldName, SystemFieldInput>>;
}

export interface CollectionDefinition extends DefinitionBase {
  kind: 'collection';
  fields: Record<string, FieldDefinition>;
  indexes?: Array<string | string[]>;
}

export interface DocumentDefinition extends DefinitionBase {
  kind: 'document';
  path?: string;
  fields: Record<string, FieldDefinition>;
}

export interface FileDefinition extends DefinitionBase {
  kind: 'file' | 'image';
  path: string;
  config?: Record<string, unknown>;
}

export type Definition =
  | CollectionDefinition
  | DocumentDefinition
  | FileDefinition;

export interface SchemaDocument {
  version: 1;
  description?: string;
  definitions: Record<string, Definition>;
  events?: Record<string, EventDefinition>;
  args?: Record<string, unknown>;
  mdx?: Record<string, MdxConfigDefinition>;
  submissions?: Record<string, unknown>;
}

export interface CompiledField {
  definitionName: string;
  path: string;
  field: FieldDefinition;
  description?: string;
}

export interface CompiledDefinition<TDefinition extends Definition = Definition> {
  definition: TDefinition;
  name: string;
  kind: DefinitionKind;
  pathAliases: string[];
  systemFields: SystemFieldDefinition[];
  description?: string;
}

export interface CompiledSchema {
  document: SchemaDocument;
  legacyStructure: LegacyStructureDocument;
  definitionsByName: Record<string, CompiledDefinition>;
  definitionsByPath: Record<string, CompiledDefinition>;
  definitionKindsByPath: Record<string, DefinitionKind>;
  fieldsByPath: Record<string, CompiledField>;
  referenceFields: CompiledField[];
  assetFields: CompiledField[];
  events: Record<string, EventDefinition>;
  configs: Record<string, MdxConfigDefinition>;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface MigrationChange {
  kind:
    | 'definition_added'
    | 'definition_removed'
    | 'definition_kind_changed'
    | 'field_added'
    | 'field_removed'
    | 'field_type_changed'
    | 'field_unique_changed'
    | 'system_field_changed'
    | 'index_added'
    | 'index_removed';
  definitionName: string;
  fieldPath?: string;
  fromType?: string;
  toType?: string;
  compatibility: MigrationCompatibilityClass;
}

export interface MigrationAction {
  type: MigrationActionType;
  definitionName: string;
  fieldPath?: string;
  message: string;
  compatibility: MigrationCompatibilityClass;
}

export interface MigrationPrompt {
  title: string;
  message: string;
  actionType: MigrationActionType;
  definitionName: string;
  fieldPath?: string;
}

export interface MigrationPlan {
  changes: MigrationChange[];
  actions: MigrationAction[];
  prompts: MigrationPrompt[];
  blocking: boolean;
}

export interface LegacySingleDefinition {
  type: LegacyDefinitionType;
  structure?: any;
  description?: string;
}

export interface LegacyStructureDocument {
  description?: string;
  definitions: Record<string, LegacySingleDefinition>;
  events?: Record<string, EventDefinition>;
  args?: Record<string, unknown>;
  mdx?: Record<string, MdxConfigDefinition>;
  submissions?: Record<string, unknown>;
}
