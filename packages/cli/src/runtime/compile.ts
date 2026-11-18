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
  | { type: "deleteFile"; path: string; locale?: string };
export interface CompiledOperation {
  operation: StagedOperation;
  expectedVersion?: number;
  expectedBase?: { exists: false } | { exists: true; sha256: string };
}
export interface DraftIssue {
  ref: string;
  pointer: string;
  code: string;
  message: string;
  severity: "hard" | "overridable";
}
export interface CompiledItem {
  key: string;
  ref: SpaceRef;
  itemKey: string;
  localSha: string;
  operation: CompiledOperation;
  upload?: { content: string; mimeType: string };
  normalized?: { value: unknown };
  newFile?: string;
  deleted: boolean;
}

function hasLocalFile(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (record(value) && typeof value.$file === "string") return true;
  return Object.values(value).some(hasLocalFile);
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
  if (ref.kind === "entry") return ["entry", part(ref.name), part(ref.entryId), part(ref.locale)].join("|");
  return document ? ["document", part(ref.name)].join("|") : ["file", part(ref.name), part(ref.locale)].join("|");
}

function operationFor(item: WorkItem, definitionName: string | undefined, content: unknown, mimeType: string) {
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
  const size = Buffer.byteLength(text, "utf8");
  if (size > INLINE_LIMIT)
    throw new CliError("not_supported_yet", `${formatRef(ref)} exceeds the 1 MB inline limit.`, {
      exitCode: EXIT.validation,
    });
  const digest = sha256Hex(text);
  return {
    operation: {
      type: "writeFile" as const,
      ...coordinates,
      value: { valueId: "v_" + digest, sha256: digest, size, mimeType, encoding: "utf-8" as const },
    },
    upload: { content: text, mimeType },
  };
}

export function compileDraft(work: WorkingCopy, items: WorkItem[]) {
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
    const fileDefinition = ref.kind === "entry" ? undefined : work.schema.definitionForPath(ref.name);
    const definition: Definition | undefined =
      ref.kind === "entry" ? work.schema.collection(ref.name) : fileDefinition?.definition;
    if (definition?.kind === "system_config")
      throw new CliError("not_supported_yet", "Edit website settings in the dashboard.", { exitCode: EXIT.validation });
    let value = item.deleted ? undefined : work.value(item);
    if (hasLocalFile(value))
      throw new CliError("not_supported_yet", "Local asset references cannot be pushed yet.", {
        exitCode: EXIT.validation,
        details: { ref: formatRef(ref) },
      });
    let normalized: CompiledItem["normalized"];
    if (definition && !item.deleted) {
      const source = ref.locale ? work.publishedValue({ ...ref, locale: undefined }) : undefined;
      const variant = ref.locale ? work.variant(ref) : undefined;
      const effective = ref.locale && variant?.mode !== "replace" ? mergeVariantOverlay(source, value) : value;
      const result = normalizeContent(effective, definition, {
        base: item.base.fingerprint ? work.publishedValue(ref, true) : undefined,
        resourceIdentity: ref.kind === "entry" ? `entry:${ref.name}:${ref.entryId}` : `document:${ref.name}`,
        createKey: createItemKey,
        configs: work.schema.compiled.configs,
      });
      const validation = validate(result.value, definition, "draft", work.schema.compiled.configs);
      for (const issue of [...result.issues, ...validation.issues]) {
        const next = forItem(ref, issue);
        if (
          !issues.some((prior) => prior.ref === next.ref && prior.pointer === next.pointer && prior.code === next.code)
        )
          issues.push(next);
      }
      if (!ref.locale && result.changed) {
        value = result.value;
        normalized = { value };
      }
    }
    const { operation, upload } = operationFor(item, fileDefinition?.name, value, work.mime(ref));
    compiled.push({
      key: item.key,
      ref,
      localSha: item.sha256,
      newFile: item.newFile,
      deleted: item.deleted,
      itemKey: serverItemKey(ref, operation.type),
      operation: {
        operation,
        ...(item.staged
          ? { expectedVersion: item.staged.itemRevision }
          : {
              expectedVersion: 0,
              expectedBase: item.base.fingerprint ? { exists: true, sha256: item.base.fingerprint } : { exists: false },
            }),
      },
      upload,
      normalized,
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
  let metadataBytes = 512;
  for (const item of items) {
    const inline = Buffer.byteLength(item.upload?.content ?? "", "utf8");
    const metadata = Buffer.byteLength(JSON.stringify(item.operation), "utf8") + 1;
    if (metadata + 512 > METADATA_LIMIT)
      throw new CliError("draft_item_too_large", `${formatRef(item.ref)} is too large to stage in one operation.`, {
        exitCode: EXIT.validation,
      });
    if (
      pending.length >= OPERATION_LIMIT ||
      inlineBytes + inline > INLINE_LIMIT ||
      metadataBytes + metadata > METADATA_LIMIT
    ) {
      batches.push(pending);
      pending = [];
      inlineBytes = 0;
      metadataBytes = 512;
    }
    pending.push(item);
    inlineBytes += inline;
    metadataBytes += metadata;
  }
  if (pending.length) batches.push(pending);
  return batches;
}
