import { maxStagedAssetBytes } from "./assetFiles";
import { binaryUpload, materializeAssets } from "./assetDrafts";
import {
  createItemKey,
  mergeVariantOverlay,
  normalizeContent,
  validate,


  type Definition,
  type Placement,
  type ValidationIssue,
} from "@atmyapp/structure";
import { CliError, EXIT } from "./errors";
import { contentFingerprint, sha256Hex } from "./fingerprint";
import { formatRef } from "./refs";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileCanonicalSource } from "./canonical";
import { RemoteSchema } from "./schema";
import type { SpaceRef } from "./spaces";
import { record, type WorkItem, type WorkingCopy } from "./workingCopy";

export const INLINE_LIMIT = 1024 * 1024;
const METADATA_LIMIT = 256 * 1024;
const OPERATION_LIMIT = 100;

type Coordinates = { collectionName: string; entryId: string; locale?: string };
export type ValueRef = {
  valueId: string;
  sha256: string;
  size: number;
  mimeType?: string;
  encoding?: "utf-8" | "base64";
};
export type UploadSource = { sha256: string; size: number; mimeType: string; content?: string };

export type StagedOperation =
  | ({
      type: "upsertEntry";
      data: Record<string, unknown>;
      replaceData?: boolean;
      moveOnly?: boolean;
      placements?: Record<string, Placement>;

    } & Coordinates)
  | ({ type: "deleteEntry" } & Coordinates)
  | { type: "putDocument"; path: string; definitionName: string; content: unknown }
  | { type: "deleteDocument"; path: string }
  | { type: "writeFile"; path: string; locale?: string; value: ValueRef; metadata?: Record<string, unknown> }
  | { type: "deleteFile"; path: string; locale?: string }
  | { type: "putPublicAsset"; path: string; value: ValueRef; metadata?: Record<string, unknown> }
  | { type: "deletePublicAsset"; path: string }
  | { type: "replaceDocumentAsset"; documentPath: string; assetPath: string; value: ValueRef; metadata?: Record<string, unknown> }
  | ({ type: "addEntryBlob"; fieldName: string; value: ValueRef; metadata?: Record<string, unknown> } & Coordinates)
  | ({ type: "replaceEntryBlob"; blobId: string; fieldName?: string; value: ValueRef; metadata?: Record<string, unknown> } & Coordinates);
export interface CompiledOperation {
  operation: StagedOperation;
  expectedVersion?: number;
  expectedBase?: { exists: false } | { exists: true; sha256: string } | { exists: true; bytesSha256: string };
  rebase?: true;
}
export interface DraftIssue {
  ref: string;
  pointer: string;
  code: string;
  message: string;
  severity: "hard" | "overridable";
}
export interface CompiledAttachment {
  itemKey: string;
  operation: CompiledOperation;
  upload?: UploadSource;
}

export interface CompiledItem extends CompiledAttachment {
  key: string;
  ref: SpaceRef;
  localSha: string;
  attachments?: CompiledAttachment[];
  normalized?: { value: unknown };
  newFile?: string;
  deleted: boolean;
}

function forItem(ref: SpaceRef, issue: ValidationIssue): DraftIssue {
  const field = issue.path === "root" ? "" : issue.path.replace(/^root\.?/, "");
  return {
    ref: formatRef(ref),
    pointer: field
      ? "/" +
        field
          .replace(/\[(\d+)\]/g, ".$1")
          .split(".")
          .join("/")
      : "",
    message: issue.message,
    code: issue.code,
    severity: issue.severity,
  };
}

export function serverItemKey(ref: SpaceRef, type?: StagedOperation["type"]): string {
  const part = (input?: string) => (input === undefined ? "-" : `${Buffer.byteLength(input, "utf8")}:${input}`);
  const document =
    (type === "putDocument" || type === "deleteDocument" || (type === undefined && ref.kind === "doc")) && !ref.locale;
  if (ref.kind === "public") return ["publicAsset", part(ref.name), "-"].join("|");
  if (ref.kind === "entry") return ["entry", part(ref.name), part(ref.entryId), part(ref.locale)].join("|");
  return document ? ["document", part(ref.name)].join("|") : ["file", part(ref.name), part(ref.locale)].join("|");
}

function operationFor(work: WorkingCopy, item: WorkItem, definitionName: string | undefined, content: unknown, mimeType: string, cache: boolean): { operation: StagedOperation; upload?: UploadSource } {
  const { ref } = item;
  if (ref.kind === "entry") {
    const coordinate = {
      collectionName: ref.name,
      entryId: ref.entryId!,
      ...(ref.locale ? { locale: ref.locale } : {}),
    };
    if (item.deleted) return { operation: { type: "deleteEntry", ...coordinate } as const };
    if (!record(content))
      throw new CliError("invalid_content", `${formatRef(ref)} must contain an object.`, { exitCode: EXIT.validation });
    if (item.placement) {
      const { field, position, entryId } = item.placement;
      const placement: Placement =
        position === "before" || position === "after" ? { position, entryId: entryId! } : { position };
      const moveOnly = item.base.fingerprint === contentFingerprint("entry", content);
      return {
        operation: {
          type: "upsertEntry" as const,
          ...coordinate,
          data: moveOnly ? {} : content,
          ...(moveOnly ? { moveOnly } : { replaceData: item.replaceData ?? true }),
          placements: { [field]: placement },
        },
      };
    }
    return {
      operation: {
        type: "upsertEntry" as const,
        ...coordinate,
        data: content,
        replaceData: item.replaceData ?? !ref.locale,
      },
    };
  }
  const coordinates = { path: ref.name, ...(ref.locale ? { locale: ref.locale } : {}) };
  if (ref.kind === "public" && item.deleted) return { operation: { type: "deletePublicAsset", path: ref.name } };
  if (item.deleted)
    return {
      operation: {
        type: ref.kind === "doc" && !ref.locale ? ("deleteDocument" as const) : ("deleteFile" as const),
        ...coordinates,
      },
    };
  if (ref.kind === "doc" && !ref.locale && definitionName)
    return { operation: { type: "putDocument" as const, path: ref.name, definitionName, content } };
  const text = typeof content === "string" ? content : JSON.stringify(content);
  if (Buffer.isBuffer(content)) {
    const upload = binaryUpload(work, content, mimeType, cache);
    return { operation: {
      type: ref.kind === "public" ? "putPublicAsset" : "writeFile",
      ...coordinates,
      value: { valueId: "v_" + upload.sha256, ...upload },
    }, upload };
  }
  const size = Buffer.byteLength(text, "utf8");
  if (size > maxStagedAssetBytes)
    throw new CliError("value_too_large", "A staged file can be at most 50 MiB.", { exitCode: EXIT.validation });
  const sha256 = sha256Hex(text);
  return {
    operation: {
      type: ref.kind === "public" ? "putPublicAsset" : "writeFile",
      ...coordinates,
      value: { valueId: "v_" + sha256, sha256, size, mimeType, encoding: "utf-8" },
    },
    upload: { content: text, mimeType, size, sha256 },
  };
}

export function compileDraft(work: WorkingCopy, items: WorkItem[], cacheUploads = false) {
  const issues: DraftIssue[] = [];
  const compiled: CompiledItem[] = [];
  for (const item of items) {
    if (!item.sha256)
      throw new CliError(
        "work_file_missing",
        `The file for ${formatRef(item.ref)} is missing. Use 'content rm' to record a deletion.`,
        { exitCode: EXIT.validation },
      );
    const { ref } = item;
    const fileDefinition = ref.kind === "entry" || ref.kind === "public" ? undefined : work.schema.definitionForPath(ref.name);
    const definition: Definition | undefined =
      ref.kind === "entry" ? work.schema.collection(ref.name) : fileDefinition?.definition;
    if (definition?.kind === "system_config")
      throw new CliError("not_supported_yet", "Edit website settings in the dashboard.", { exitCode: EXIT.validation });
    let value = item.deleted ? undefined : work.value(item);
    let normalized: CompiledItem["normalized"];
    let attachments: CompiledAttachment[] = [];
    if (definition && !item.deleted && !Buffer.isBuffer(value)) {
      const source = ref.locale ? work.publishedValue({ ...ref, locale: undefined }) : undefined;
      const variant = ref.locale ? work.variant(ref) : undefined;
      const effective = ref.locale && variant?.mode !== "replace" ? mergeVariantOverlay(source, value) : value;
      const result = normalizeContent(effective, definition, {
        base: item.base.fingerprint ? work.publishedValue(ref, true) : undefined,
        resourceIdentity: ref.kind === "entry" ? `entry:${ref.name}:${ref.entryId}` : `document:${ref.name}`,
        createKey: createItemKey,
        configs: work.schema.compiled.configs,
      });
      if (!ref.locale && result.changed) {
        value = result.value;
        normalized = { value };
      }
      const transformed = !ref.locale && "fields" in definition
        ? materializeAssets(work, item, result.value, definition.fields, cacheUploads)
        : { content: result.value, uploads: [] };
      attachments = transformed.uploads;
      if (!ref.locale && attachments.length) value = transformed.content;
      const validation = validate(transformed.content, definition, "draft", work.schema.compiled.configs);
      for (const issue of [...result.issues, ...validation.issues]) {
        const next = forItem(ref, issue);
        if (!issues.some((prior) => prior.ref === next.ref && prior.pointer === next.pointer && prior.code === next.code))
          issues.push(next);
      }
    }
    const { operation, upload } = operationFor(work, item, fileDefinition?.name, value, work.mime(ref), cacheUploads);
    const base = item.base.fingerprint;
    const binary = ref.kind === "public" || !ref.locale && ref.kind === "file" && item.base.sha256 === base;
    const expectedBase: CompiledOperation["expectedBase"] = base
      ? binary ? { exists: true, bytesSha256: base } : { exists: true, sha256: base }
      : { exists: false };
    compiled.push({
      key: item.key, ref, localSha: item.sha256, newFile: item.newFile, deleted: item.deleted,
      itemKey: serverItemKey(ref, operation.type),
      operation: {
        operation,
        expectedVersion: item.staged?.itemRevision ?? 0,
        ...(!item.staged || item.rebase ? { expectedBase } : {}),
        ...(item.rebase && item.staged ? { rebase: true } : {}),
      },
      upload, normalized, ...(attachments.length ? { attachments } : {}),
    });
  }
  return { items: compiled, issues };
}

export function assertDraftValid(issues: DraftIssue[]) {
  const hard = issues.filter((issue) => issue.severity === "hard");
  if (hard.length)
    throw new CliError("validation_failed", `${hard.length} validation issue(s) must be fixed.`, {
      exitCode: EXIT.validation,
      details: { issues },
    });
}

export function draftSchemaWarnings(work: WorkingCopy, cwd: string) {
  const filename = path.resolve(cwd, "atmyapp.schema.ts");
  if (!fs.existsSync(filename)) return [];
  const source = compileCanonicalSource({ filename, code: fs.readFileSync(filename, "utf8") });
  if (source.output && new RemoteSchema(source.output).hash === work.schema.hash) return [];
  return [
    {
      code: "schema_differs",
      message:
        "The local schema differs from the pulled schema. Run 'atmyapp migrate' and pull again if you want to use the new schema.",
    },
  ];
}

export function stageBatches(items: CompiledItem[]): CompiledItem[][] {
  const batches: CompiledItem[][] = [];
  let pending: CompiledItem[] = [];
  let inlineBytes = 0;
  let operationCount = 0;
  let metadataBytes = 512;
  for (const item of items) {
    const group = [...item.attachments ?? [], item];
    const inline = group.reduce((total, entry) => total + (entry.upload && entry.upload.size <= INLINE_LIMIT ? entry.upload.size : 0), 0);
    const metadata = group.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.operation), "utf8") + 1, 0);
    if (group.length > OPERATION_LIMIT || metadata + 512 > METADATA_LIMIT)
      throw new CliError("draft_item_too_large", `${formatRef(item.ref)} is too large to stage in one operation.`, {
        exitCode: EXIT.validation,
      });
    if (
      operationCount + group.length > OPERATION_LIMIT ||
      (pending.length > 0 && inlineBytes + inline > INLINE_LIMIT) ||
      metadataBytes + metadata > METADATA_LIMIT
    ) {
      batches.push(pending);
      pending = [];
      inlineBytes = 0;
      operationCount = 0;
      metadataBytes = 512;
    }
    pending.push(item);
    operationCount += group.length;
    inlineBytes += inline;
    metadataBytes += metadata;
  }
  if (pending.length) batches.push(pending);
  return batches;
}
