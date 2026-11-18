import * as path from "node:path";
import type { FieldDefinition } from "@atmyapp/structure";
import { fileMime, isLocalAsset, localAssetPath, maxStagedAssetBytes, readAssetFile } from "./assetFiles";
import type { CompiledAttachment, StagedOperation, UploadSource } from "./compile";
import { CliError, EXIT } from "./errors";
import { documentAssetId, sha256Hex } from "./fingerprint";
import { setJsonValue } from "./jsonPatch";
import { formatRef, parseRef, pointerTokens } from "./refs";
import { editLocalContent, record, type WorkingCopy, type WorkItem } from "./workingCopy";

const cleanField = (parts: string[]) => parts.map((part) => part.replace(/[^a-zA-Z0-9_-]/g, "_")).join(".");
const escapeEntry = (value: string) => encodeURIComponent(value).replace(/\./g, "%2E");
const mimeExtension = (mime: string) => {
  const subtype = mime.split("/")[1]?.split(";")[0]?.trim();
  return subtype === "jpeg" ? "jpg" : subtype?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
};
const documentExtensions: Record<string, string> = {
  "image/svg+xml": "svg",
  "text/plain": "txt",
  "text/markdown": "md",
  "audio/mpeg": "mp3",
  "application/octet-stream": "bin",
};
export function entryAssetId(collection: string, entryId: string, field: string, sha256: string, mimeType: string) {
  const stored = `collections/${escapeEntry(collection)}/entries/${escapeEntry(entryId)}/assets/${cleanField(field.split("."))}__${sha256.slice(0, 12)}.${mimeExtension(mimeType)}.json`;
  return "gcb_" + Buffer.from(stored).toString("base64url");
}
export const keyPart = (value: string) => `${Buffer.byteLength(value)}:${value}`;

function existingBlob(value: unknown) {
  if (typeof value === "string") return value;
  if (record(value) && typeof value.__blob === "string") return value.__blob;
  if (record(value) && typeof value.blobId === "string") return value.blobId;
}

export function binaryUpload(work: WorkingCopy, data: Buffer, mimeType: string, cache: boolean): UploadSource {
  if (data.length > maxStagedAssetBytes)
    throw new CliError("value_too_large", "A staged file can be at most 50 MiB.", { exitCode: EXIT.validation });
  const sha256 = cache ? work.store.putObject(data) : sha256Hex(data);
  return { sha256, size: data.length, mimeType };
}

export function materializeAssets(
  work: WorkingCopy,
  item: WorkItem,
  value: unknown,
  fields: Record<string, FieldDefinition>,
  cache: boolean,
) {
  const uploads: CompiledAttachment[] = [];
  const base = work.publishedValue(item.ref);
  const root = work.store.spaceDir(work.name);
  const definition: FieldDefinition = { kind: "object", fields };
  function walk(data: unknown, old: unknown, field: FieldDefinition | undefined, parts: string[]): unknown {
    if (isLocalAsset(data)) {
      if (field?.kind !== "asset" || item.ref.locale || item.newFile)
        throw new CliError(
          "invalid_asset_field",
          `${formatRef(item.ref)}#/${parts.join("/")} requires a source-language asset field in a saved entry or document.`,
          {
            exitCode: EXIT.validation,
          },
        );
      const filename = localAssetPath(root, item.file, data.$file);
      const mimeType = fileMime(filename);
      const upload = binaryUpload(work, readAssetFile(filename), mimeType, cache);
      if (field.assetKind === "image" && !mimeType.startsWith("image/"))
        throw new CliError("invalid_asset_field", "Choose an image file for this field.", {
          exitCode: EXIT.validation,
        });
      const value = { valueId: "v_" + upload.sha256, ...upload };
      const metadata = { name: path.basename(filename), ...(data.alt !== undefined ? { alt: data.alt } : {}) };
      const fieldName = parts.join(".");
      const fieldPath = cleanField(parts);
      const hash = upload.sha256.slice(0, 12);
      let operation: StagedOperation;
      let itemKey: string;
      let blobId: string;
      if (item.ref.kind === "entry") {
        const collectionName = item.ref.name;
        const entryId = item.ref.entryId!;
        const prior = existingBlob(old);
        if (prior) {
          blobId = prior;
          operation = { type: "replaceEntryBlob", collectionName, entryId, fieldName, blobId, value, metadata };
        } else {
          blobId = entryAssetId(collectionName, entryId, fieldName, upload.sha256, mimeType);
          operation = { type: "addEntryBlob", collectionName, entryId, fieldName, value, metadata };
        }
        itemKey = ["entryBlob", keyPart(collectionName), keyPart(blobId)].join("|");
      } else {
        const documentPath = item.ref.name;
        const ext = documentExtensions[mimeType] ?? mimeExtension(mimeType);
        blobId = documentAssetId(`${documentPath}.assets/${fieldPath}__${hash}.${ext}`);
        operation = { type: "replaceDocumentAsset", documentPath, assetPath: blobId, value, metadata };
        itemKey = ["documentAsset", keyPart(documentPath), keyPart(blobId)].join("|");
      }
      uploads.push({ itemKey, operation: { operation, expectedVersion: item.attachments?.[itemKey] ?? 0 }, upload });
      return { __blob: blobId, ...(data.alt !== undefined ? { alt: data.alt } : {}) };
    }
    if (Array.isArray(data)) {
      const identity = field?.kind === "array" ? (field.identityField ?? "_key") : "_key";
      return data.map((child, index) => {
        const prior = Array.isArray(old)
          ? record(child) && Object.prototype.hasOwnProperty.call(child, identity)
            ? old.find((candidate) => record(candidate) && candidate[identity] === child[identity])
            : old[index]
          : undefined;
        return walk(child, prior, field?.kind === "array" ? field.items : undefined, [...parts, String(index)]);
      });
    }
    if (record(data))
      return Object.fromEntries(
        Object.entries(data).map(([name, child]) => [
          name,
          walk(
            child,
            record(old) && Object.prototype.hasOwnProperty.call(old, name) ? old[name] : undefined,
            field?.kind === "object" ? field.fields[name] : undefined,
            [...parts, name],
          ),
        ]),
      );
    return data;
  }
  return { content: walk(value, base, definition, []), uploads };
}

export async function putDraftAsset(
  work: WorkingCopy,
  input: string,
  source: string,
  options: { alt?: string; dryRun?: boolean },
) {
  const parsed = parseRef(input);
  if (!parsed.pointer || parsed.locale || !["doc", "entry", "file"].includes(parsed.kind))
    throw new CliError("pointer_required", "Choose an asset field with a content reference and JSON pointer.", {
      exitCode: EXIT.usage,
    });
  const ref = work.describe(input);
  if (ref.kind !== "doc" && ref.kind !== "entry")
    throw new CliError("invalid_asset_field", "Choose a document or entry asset field.", { exitCode: EXIT.usage });
  const definition =
    ref.kind === "entry" ? work.schema.collection(ref.name) : work.schema.definitionForPath(ref.name)?.definition;
  let field: FieldDefinition | undefined =
    definition && "fields" in definition ? { kind: "object", fields: definition.fields } : undefined;
  for (const token of pointerTokens(parsed.pointer)) {
    field =
      field?.kind === "object" && Object.prototype.hasOwnProperty.call(field.fields, token)
        ? field.fields[token]
        : field?.kind === "array"
          ? field.items
          : undefined;
  }
  if (field?.kind !== "asset" || (field.assetKind === "image" && !fileMime(source).startsWith("image/")))
    throw new CliError("invalid_asset_field", "The pointer and file type must match an asset field.", {
      exitCode: EXIT.validation,
    });
  const bytes = readAssetFile(source);
  const digest = sha256Hex(bytes);
  const file = path.join(work.store.spaceDir(work.name), ".assets", digest, path.basename(source));
  return editLocalContent({
    work,
    ref,
    dryRun: options.dryRun,
    existence: "existing",
    edit: (value) => {
      const relative = path
        .relative(path.dirname(work.filename(ref)), file)
        .split(path.sep)
        .join("/");
      const next = setJsonValue(value, parsed.pointer!, {
        $file: relative,
        ...(options.alt !== undefined ? { alt: options.alt } : {}),
      });
      if (!options.dryRun) work.store.writeBytes(file, bytes);
      return next;
    },
  });
}

export function putDraftFile(work: WorkingCopy, input: string, source: string, dryRun = false) {
  const ref = work.describe(input.startsWith("public:") || input.startsWith("file:") ? input : "file:" + input);
  if (ref.locale || (ref.kind !== "file" && ref.kind !== "public"))
    throw new CliError("invalid_ref", "Choose a file or public asset path.", { exitCode: EXIT.usage });
  return editLocalContent({ work, ref, dryRun, edit: () => readAssetFile(source) });
}
