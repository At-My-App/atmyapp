import {
  compileSchema,
  type CompiledSchema,
  type Definition,
  type FieldDefinition,
  type SchemaDocument,
} from "@atmyapp/structure";
import type { ApiClient } from "./api";
import { CliError, EXIT } from "./errors";
import { sha256Hex } from "./fingerprint";
import { escapePointerToken } from "./refs";
import type { DefinitionSummary, FieldRow } from "./schemas/commands";

export type { DefinitionSummary, FieldRow } from "./schemas/commands";

interface StructureResponse {
  found: boolean;
  structure: unknown;
  schemaError?: string;
}

function ensureDocumentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return /\.(json|jsonx|md)$/.test(normalized) ? normalized : `${normalized}.json`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The project's published schema, compiled with the same code the server uses. */
export class RemoteSchema {
  readonly compiled: CompiledSchema;
  readonly hash: string;

  constructor(readonly raw: unknown) {
    try {
      this.compiled = compileSchema(raw as SchemaDocument);
    } catch (error) {
      throw new CliError(
        "schema_unreadable",
        `The project's stored schema could not be read: ${error instanceof Error ? error.message : String(error)}`,
        { fix: "Run 'atmyapp migrate' to upload a valid schema." },
      );
    }
    this.hash = sha256Hex(stableStringify(raw));
  }

  get document(): SchemaDocument {
    return this.compiled.document;
  }

  get localizationEnabled(): boolean {
    return this.document.localization?.enabled === true;
  }

  definition(name: string): Definition | undefined {
    return this.document.definitions[name];
  }

  /** Storage path of a document, file or system config definition. */
  storagePath(name: string): string | null {
    const definition = this.definition(name);
    if (!definition) return null;
    if (definition.kind === "document") return ensureDocumentPath(definition.path || name);
    if (definition.kind === "collection") return null;
    return definition.path.replace(/^\/+/, "");
  }

  /** A document by definition name or by path (with or without .json). */
  resolveDocument(nameOrPath: string): { name: string; path: string; definition: Definition } | null {
    const wanted = nameOrPath.replace(/^\/+/, "");
    for (const [name, definition] of Object.entries(this.document.definitions)) {
      if (definition.kind !== "document" && definition.kind !== "system_config") continue;
      const path = this.storagePath(name)!;
      if (name === wanted || path === wanted || path.replace(/\.[^.]+$/, "") === wanted) {
        return { name, path, definition };
      }
    }
    return null;
  }

  /** The definition that owns a storage path (documents, files, images). */
  definitionForPath(path: string): { name: string; definition: Definition } | null {
    const wanted = path.replace(/^\/+/, "");
    for (const [name, definition] of Object.entries(this.document.definitions)) {
      if (definition.kind === "collection") continue;
      if (this.storagePath(name) === wanted) return { name, definition };
    }
    return null;
  }

  collection(name: string): Definition & { kind: "collection" } {
    const definition = this.definition(name);
    if (!definition || definition.kind !== "collection") {
      throw new CliError("unknown_collection", `There is no collection '${name}' in the project's schema.`, {
        exitCode: EXIT.usage,
        fix: "Run 'atmyapp content ls' to see the collections.",
      });
    }
    return definition as Definition & { kind: "collection" };
  }

  collections(): string[] {
    return Object.entries(this.document.definitions)
      .filter(([, definition]) => definition.kind === "collection")
      .map(([name]) => name);
  }

  summaries(): DefinitionSummary[] {
    return Object.entries(this.document.definitions).map(([name, definition]) => ({
      name,
      kind: definition.kind,
      path: this.storagePath(name),
      description: definition.description ?? null,
      localizedFields: "fields" in definition ? localizedPointers(definition.fields) : [],
    }));
  }

  /** One row per field, nested fields flattened to JSON pointers. */
  fieldRows(name: string): FieldRow[] {
    const definition = this.definition(name);
    if (!definition || !("fields" in definition)) return [];
    const rows: FieldRow[] = [];
    walkFields(definition.fields, "", rows);
    return rows;
  }
}

function fieldType(field: FieldDefinition): string {
  switch (field.kind) {
    case "scalar":
      return field.format ? `${field.scalar}:${field.format}` : field.scalar;
    case "asset":
      return field.multiple ? `${field.assetKind}[]` : field.assetKind;
    case "reference":
      return field.multiple ? `reference(${field.target})[]` : `reference(${field.target})`;
    case "enum":
      return `enum(${field.values.map((value) => JSON.stringify(value)).join("|")})`;
    case "array":
      return `array<${fieldType(field.items)}>`;
    case "mdx":
      return `mdx(${field.config})`;
    default:
      return field.kind;
  }
}

function fieldLimits(field: FieldDefinition): Record<string, unknown> {
  const limits: Record<string, unknown> = {};
  const candidates = field as unknown as Record<string, unknown>;
  for (const key of ["min", "max", "minLength", "maxLength", "minimum", "maximum", "preferredLength", "pattern", "minItems", "maxItems", "accept", "default"]) {
    if (candidates[key] !== undefined) limits[key] = candidates[key];
  }
  return limits;
}

function walkFields(fields: Record<string, FieldDefinition>, prefix: string, rows: FieldRow[]) {
  for (const [name, field] of Object.entries(fields)) {
    const pointer = `${prefix}/${escapePointerToken(name)}`;
    rows.push({
      pointer,
      kind: field.kind,
      type: fieldType(field),
      required: field.required === true || (field.optional !== true && field.required !== false),
      nullable: field.nullable === true,
      localize: field.localize === true,
      description: field.description ?? null,
      limits: fieldLimits(field),
    });
    if (field.kind === "object") walkFields(field.fields, pointer, rows);
    if (field.kind === "array" && field.items.kind === "object") walkFields(field.items.fields, `${pointer}/*`, rows);
  }
}

function localizedPointers(fields: Record<string, FieldDefinition>, prefix = ""): string[] {
  const pointers: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const pointer = `${prefix}/${escapePointerToken(name)}`;
    if (field.localize === true) pointers.push(pointer);
    if (field.kind === "object") pointers.push(...localizedPointers(field.fields, pointer));
    if (field.kind === "array" && field.items.kind === "object") {
      pointers.push(...localizedPointers(field.items.fields, `${pointer}/*`));
    }
  }
  return pointers;
}

export async function fetchRemoteSchema(api: ApiClient): Promise<RemoteSchema> {
  const response = await api.json<StructureResponse>("GET", "storage/structure", { query: { branch: "main" } });
  if (!response?.found || !response.structure) {
    throw new CliError("no_schema", "The project has no schema yet.", {
      exitCode: EXIT.usage,
      fix: "Write atmyapp.schema.ts and run 'atmyapp migrate'.",
    });
  }
  return new RemoteSchema(response.structure);
}
