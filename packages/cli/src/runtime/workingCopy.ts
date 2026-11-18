import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { mergeVariantOverlay, type Placement } from "@atmyapp/structure";
import { checkLocale, isTextual } from "./content";
import { CliError, EXIT } from "./errors";
import { contentFingerprint, sha256Hex } from "./fingerprint";
import { canonicalLocale, escapePointerToken, formatRef, parseRef, toItemKey } from "./refs";
import { RemoteSchema } from "./schema";
import { ContentStore, decodeSegment, encodeSegment, type StoredVariant } from "./store";
import {
  readSpace,
  withSpace,
  writeSpace,
  type SpaceBase,
  type SpaceFile,
  type SpaceItem,
  type SpaceRef,
} from "./spaces";

export const workStates = [
  "published",
  "modified",
  "staged",
  "staged+modified",
  "new",
  "deleted",
  "remote-changed",
  "conflict",
] as const;
export type WorkState = (typeof workStates)[number];
export interface WorkItem {
  key: string;
  ref: SpaceRef;
  file: string;
  sha256: string | null;
  base: SpaceBase;
  published: SpaceBase;
  staged?: SpaceItem["staged"];
  state: WorkState;
  deleted: boolean;
  newFile?: string;
  placement?: SpaceItem["placement"];
  replaceData?: boolean;
}

function invalidJson(file: string): never {
  throw new CliError("invalid_content", `Invalid JSON in ${file}.`, { exitCode: EXIT.validation });
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return invalidJson(file);
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function itemKey(ref: SpaceRef): string {
  const base = toItemKey(ref, ref.kind === "doc" ? ref.name : undefined)!;
  if (!ref.locale) return base;
  return base.replace(":", "-locale:") + ":" + ref.locale;
}

function refFromKey(key: string): SpaceRef | undefined {
  const colon = key.indexOf(":");
  if (colon < 0) return;
  const kind = key.slice(0, colon);
  let rest = key.slice(colon + 1);
  let locale: string | undefined;
  if (kind.endsWith("-locale")) {
    const last = rest.lastIndexOf(":");
    if (last < 0) return;
    locale = rest.slice(last + 1);
    rest = rest.slice(0, last);
  }
  if (kind.startsWith("entry")) {
    const delimiter = rest.indexOf(":");
    if (delimiter < 0) return;
    return { kind: "entry", name: rest.slice(0, delimiter), entryId: rest.slice(delimiter + 1), locale };
  }
  if (kind.startsWith("file")) return { kind: "file", name: rest, locale };
}

function files(directory: string): string[][] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return files(path.join(directory, entry.name)).map((parts) => [entry.name, ...parts]);
    return entry.isFile() && !entry.name.endsWith(".tmp") ? [[entry.name]] : [];
  });
}

function readBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function storedVariant(value: unknown): StoredVariant {
  if (record(value) && (value.mode === "overlay" || value.mode === "replace") && "data" in value) {
    return {
      mode: value.mode,
      data: value.data,
      status: typeof value.status === "string" ? value.status : "current",
      sourceHashes: record(value.sourceHashes) ? (value.sourceHashes as Record<string, string>) : {},
    };
  }
  return { mode: "overlay", data: value, status: "current", sourceHashes: {} };
}

export class WorkingCopy {
  readonly manifest;
  readonly schema: RemoteSchema;

  constructor(
    readonly store: ContentStore,
    readonly name: string,
  ) {
    const manifest = store.readManifest();
    if (!manifest)
      throw new CliError("no_local_copy", "There is no local content copy yet.", {
        exitCode: EXIT.usage,
        fix: "Run 'atmyapp content pull'.",
      });
    this.manifest = manifest;
    const schemaFile = path.join(store.spaceDir(), "schema.json");
    this.schema = new RemoteSchema(parseJson(schemaFile, fs.readFileSync(schemaFile, "utf8")));
  }

  describe(input: string): SpaceRef {
    const parsed = parseRef(input);
    const locale = checkLocale(parsed.locale, this.manifest.localization) ?? undefined;
    if (parsed.kind === "entry") {
      this.schema.collection(parsed.name);
      return { kind: "entry", name: parsed.name, entryId: parsed.entryId, locale };
    }
    if (parsed.kind === "doc") {
      const resolved = this.schema.resolveDocument(parsed.name);
      if (!resolved)
        throw new CliError("unknown_document", `Unknown document '${parsed.name}'.`, { exitCode: EXIT.usage });
      return { kind: "doc", name: resolved.path, locale };
    }
    if (parsed.kind === "file") return this.fileRef(parsed.name, locale);
    throw new CliError("not_supported_yet", "Use a document, file or entry reference.", { exitCode: EXIT.usage });
  }

  fileRef(name: string, locale?: string): SpaceRef {
    const definition = this.schema.definitionForPath(name);
    return { kind: definition?.definition.kind === "document" ? "doc" : "file", name, locale };
  }

  filename(ref: SpaceRef, space = this.name): string {
    if (ref.kind === "entry") {
      return ref.locale
        ? this.store.entryVariantPath(ref.name, ref.entryId!, ref.locale, space)
        : this.store.entryPath(ref.name, ref.entryId!, space);
    }
    return ref.locale ? this.store.fileVariantPath(ref.name, ref.locale, space) : this.store.filePath(ref.name, space);
  }

  newEntryFilename(collection: string, file: string): string {
    if (path.basename(file) !== file || !file.endsWith(".json"))
      throw new CliError("space_corrupt", "The new entry filename is invalid.");
    return path.join(this.store.collectionDir(collection, this.name), "_new", file);
  }

  mime(ref: SpaceRef): string {
    if (ref.kind === "entry" || ref.kind === "doc" || /\.jsonx?$/i.test(ref.name)) return "application/json";
    return this.manifest.files[ref.name]?.mimeType ?? (/\.mdx?$/i.test(ref.name) ? "text/markdown" : "text/plain");
  }

  private readValue(ref: SpaceRef, file: string, raw: Buffer, newFile = false): unknown {
    const text = raw.toString("utf8");
    if (ref.locale) return storedVariant(parseJson(file, text)).data;
    if (ref.kind === "entry") {
      const parsed = parseJson(file, text);
      const value = newFile ? parsed : record(parsed) ? parsed.data : undefined;
      if (!record(value)) return invalidJson(file);
      return value;
    }
    if (ref.kind === "doc" || /json/i.test(this.mime(ref))) return parseJson(file, text);
    if (!isTextual(this.mime(ref), ref.name) || raw.includes(0) || !Buffer.from(text, "utf8").equals(raw)) {
      throw new CliError("not_supported_yet", `Binary file '${ref.name}' cannot be edited in a space yet.`, {
        exitCode: EXIT.validation,
      });
    }
    return text;
  }

  value(item: Pick<WorkItem, "ref" | "file" | "newFile">): unknown {
    const bytes = fs.readFileSync(item.file);
    return this.readValue(item.ref, item.file, bytes, !!item.newFile);
  }

  variant(ref: SpaceRef, space = this.name): StoredVariant | undefined {
    if (!ref.locale) return;
    const file = this.filename(ref, space);
    const bytes = readBytes(file);
    return bytes ? storedVariant(parseJson(file, bytes.toString("utf8"))) : undefined;
  }

  publishedValue(ref: SpaceRef, effective = false): unknown {
    const file = this.filename(ref, this.store.published);
    const bytes = readBytes(file);
    const value = bytes ? this.readValue(ref, file, bytes) : undefined;
    if (!effective || !ref.locale) return value;
    const source = this.publishedValue({ ...ref, locale: undefined });
    const variant = this.variant(ref, this.store.published);
    return variant?.mode === "replace" ? variant.data : variant ? mergeVariantOverlay(source, variant.data) : source;
  }

  published(ref: SpaceRef): SpaceBase {
    const resource =
      ref.kind === "entry" ? this.manifest.collections[ref.name]?.entries[ref.entryId!] : this.manifest.files[ref.name];
    if (!resource) return { sha256: null, fingerprint: null, commit: this.manifest.baseCommit };
    if (!ref.locale)
      return {
        sha256: resource.sha256 || null,
        fingerprint: resource.fingerprint || null,
        commit: this.manifest.baseCommit,
      };
    const value = this.publishedValue(ref, true);
    return {
      sha256: resource.locales?.[ref.locale]?.sha256 ?? resource.sha256 ?? null,
      fingerprint: value === undefined ? null : contentFingerprint(ref.kind === "entry" ? "entry" : "file", value),
      commit: this.manifest.baseCommit,
    };
  }

  writeValue(ref: SpaceRef, value: unknown, file = this.filename(ref), newFile = false): string {
    if (ref.locale) {
      const previous = this.variant(ref) ?? this.variant(ref, this.store.published);
      return this.store.writeJson(file, { ...(previous ?? storedVariant(value)), data: value }, false);
    }
    if (ref.kind === "entry" && !newFile) return this.store.writeJson(file, { id: ref.entryId, data: value }, false);
    if (typeof value === "string" && ref.kind === "file" && !/json/i.test(this.mime(ref))) {
      this.store.writeBytes(file, Buffer.from(value));
      return sha256Hex(value);
    }
    return this.store.writeJson(file, value, false);
  }

  itemStates(space = readSpace(this.store, this.name), all = false): WorkItem[] {
    const known = new Map<string, { ref: SpaceRef; file?: string; newFile?: string }>();
    const add = (ref: SpaceRef, file?: string, newFile?: string) => known.set(itemKey(ref), { ref, file, newFile });
    const dir = this.store.spaceDir(this.name);
    for (const parts of files(path.join(dir, "f"))) add(this.fileRef(parts.map(decodeSegment).join("/")));
    for (const parts of files(path.join(dir, "locales", "f"))) {
      const locale = parts.at(-1);
      if (parts.length > 1 && locale?.endsWith(".json"))
        add(this.fileRef(parts.slice(0, -1).map(decodeSegment).join("/"), decodeSegment(locale.slice(0, -5))));
    }
    for (const parts of files(path.join(dir, "collections"))) {
      const [collection, id, ...rest] = parts;
      if (!collection || !id) continue;
      const name = decodeSegment(collection);
      if (id === "_new" && rest.length === 1 && rest[0].endsWith(".json")) {
        const existing = Object.values(space.items).find((item) => item.newFile === rest[0] && item.ref?.name === name);
        const entryId = existing?.ref?.entryId ?? "new-" + sha256Hex(name + "/" + rest[0]).slice(0, 24);
        add({ kind: "entry", name, entryId }, this.newEntryFilename(name, rest[0]), rest[0]);
      } else if (rest.length === 1 && rest[0] === "entry.json") {
        add({ kind: "entry", name, entryId: decodeSegment(id) });
      } else if (rest.length === 2 && rest[0] === "locales" && rest[1].endsWith(".json")) {
        add({ kind: "entry", name, entryId: decodeSegment(id), locale: decodeSegment(rest[1].slice(0, -5)) });
      }
    }
    for (const key of new Set([...Object.keys(space.items), ...space.deletions])) {
      const ref = space.items[key]?.ref ?? refFromKey(key);
      if (ref && !known.has(key)) add(ref);
    }
    if (all) {
      for (const name of Object.keys(this.manifest.files)) {
        const ref = this.fileRef(name);
        if (!known.has(itemKey(ref))) add(ref);
      }
      for (const [name, collection] of Object.entries(this.manifest.collections)) {
        for (const entryId of Object.keys(collection.entries)) {
          const ref = { kind: "entry", name, entryId } as const;
          if (!known.has(itemKey(ref))) add(ref);
        }
      }
    }
    return [...known]
      .map(([key, coordinates]) => {
        const { ref, newFile } = coordinates;
        const saved = space.items[key];
        const published = this.published(ref);
        const base = saved?.base ?? published;
        const deleted = space.deletions.includes(key);
        const file = coordinates.file ?? this.filename(ref);
        const bytes = deleted ? null : readBytes(file);
        const sha256 = deleted ? sha256Hex("deleted") : bytes ? fileDigest(bytes, saved?.placement) : null;
        const state = workingState({
          sha256,
          base,
          published,
          deleted,
          staged: saved?.staged,
          local: !!bytes,
          placement: !!saved?.placement,
        });
        return {
          key,
          ref,
          file,
          newFile,
          deleted,
          base,
          published,
          sha256,
          state,
          staged: saved?.staged,
          placement: saved?.placement,
          replaceData: saved?.replaceData,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}

export function fileDigest(bytes: Uint8Array, placement?: SpaceItem["placement"]): string {
  const hash = sha256Hex(bytes);
  return placement ? sha256Hex(hash + JSON.stringify(placement)) : hash;
}

export function workingState(input: {
  base: SpaceBase;
  published: SpaceBase;
  sha256: string | null;
  deleted: boolean;
  staged?: SpaceItem["staged"];
  local: boolean;
  placement?: boolean;
}): WorkState {
  const { base, published, sha256, deleted, staged, local, placement } = input;
  const changed = deleted || placement || (local && sha256 !== base.sha256);
  if (base.fingerprint !== published.fingerprint) return changed || staged ? "conflict" : "remote-changed";
  if (staged) return sha256 === staged.sha256 ? "staged" : "staged+modified";
  if (deleted) return "deleted";
  if (!changed) return "published";
  return base.sha256 || base.fingerprint ? "modified" : "new";
}

export function recordWorkItem(space: SpaceFile, work: WorkingCopy, ref: SpaceRef): SpaceItem {
  const key = itemKey(ref);
  return (space.items[key] ??= { ref, base: work.published(ref), ...(ref.locale ? { locale: ref.locale } : {}) });
}

export async function editLocalContent(input: {
  work: WorkingCopy;
  ref: string | SpaceRef;
  dryRun?: boolean;
  remove?: boolean;
  edit?: (previous: unknown) => unknown;
  replaceData?: boolean;
  existence?: "new" | "existing";
  placement?: { field: string } & Placement;
}) {
  const { work } = input;
  const ref = typeof input.ref === "string" ? work.describe(input.ref) : input.ref;
  const key = itemKey(ref);
  const file = work.filename(ref);
  const action = (space: SpaceFile) => {
    const existing = readBytes(file);
    const published = work.published(ref);
    const exists = !!existing || published.fingerprint !== null || !!space.items[key]?.staged;
    if (input.existence === "new" && exists)
      throw new CliError("entry_exists", `${formatRef(ref)} already exists.`, { exitCode: EXIT.conflict });
    if (input.existence === "existing" && !exists)
      throw new CliError("not_found", `${formatRef(ref)} is not in this working copy.`, { exitCode: EXIT.usage });
    if (!input.remove && existing && !input.edit && !input.placement && !space.deletions.includes(key))
      return { ref: formatRef(ref), file, dryRun: !!input.dryRun, changed: false };
    const item = recordWorkItem(space, work, ref);
    const remove = () => {
      if (!existing && published.fingerprint === null && !item.staged)
        throw new CliError("not_found", `${formatRef(ref)} is not in this space or the published copy.`, {
          exitCode: EXIT.usage,
        });
      if (!input.dryRun) {
        work.store.remove(file);
        if (published.fingerprint !== null || item.staged) {
          if (!space.deletions.includes(key)) space.deletions.push(key);
        } else delete space.items[key];
        writeSpace(work.store, space);
      }
    };
    if (input.remove) remove();
    else {
      const previous = existing ? work.value({ ref, file }) : work.publishedValue(ref);
      const initial = previous ?? (ref.kind === "file" && !ref.locale ? "" : {});
      const value = input.edit ? input.edit(initial) : initial;
      if (value === undefined) remove();
      else if (!input.dryRun) {
        space.deletions = space.deletions.filter((deleted) => deleted !== key);
        if (ref.kind === "entry" && input.edit && !ref.locale) {
          // A later merge must preserve fields removed by a replacement or JSON Patch.
          item.replaceData = item.replaceData || (input.replaceData ?? true);
        } else if (input.replaceData !== undefined) item.replaceData = input.replaceData;
        if (input.placement) item.placement = input.placement;
        const publishedFile = work.filename(ref, work.store.published);
        const publishedBytes = readBytes(publishedFile);
        if (!input.edit && !existing && publishedBytes) work.store.writeBytes(file, publishedBytes);
        else work.writeValue(ref, value, file);
        writeSpace(work.store, space);
      }
    }
    return { ref: formatRef(ref), file, dryRun: !!input.dryRun, changed: true };
  };
  return input.dryRun ? action(readSpace(work.store, work.name)) : withSpace(work.store, work.name, action);
}

export function reserveNewEntryId(work: WorkingCopy, space: SpaceFile, item: WorkItem): WorkItem {
  if (!item.newFile || !item.ref.entryId?.startsWith("new-")) return item;
  const ref = { ...item.ref, entryId: randomUUID() };
  const key = itemKey(ref);
  space.items[key] = { base: item.base, ref, newFile: item.newFile };
  return { ...item, ref, key };
}

export function selectWorkItems(work: WorkingCopy, items: WorkItem[], refs: string[]): WorkItem[] {
  if (!refs.length) return items;
  const keys = refs.map((ref) => itemKey(work.describe(ref)));
  const selected = items.filter((item) => keys.includes(item.key));
  const missing = keys.find((key) => !selected.some((item) => item.key === key));
  if (missing) throw new CliError("not_an_item", `${missing} has no changes in this space.`, { exitCode: EXIT.usage });
  return selected;
}

export function workSummary(item: WorkItem) {
  return {
    ref: formatRef(item.ref),
    key: item.key,
    state: item.state,
    base: item.base,
    staged: item.staged,
    ...(item.newFile ? { newFile: item.newFile } : {}),
  };
}

export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o");
}

export function grepSpace(work: WorkingCopy, query: string, limit = 50) {
  const needle = foldText(query.trim());
  if (!needle) throw new CliError("invalid_query", "Give a word or phrase to search for.", { exitCode: EXIT.usage });
  const matches: Array<{ ref: string; pointer: string; text: string }> = [];
  function visit(value: unknown, ref: string, pointer: string) {
    if (matches.length >= limit) return;
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, ref, pointer + "/" + escapePointerToken(key));
    } else if (typeof value === "string" && foldText(value).includes(needle)) {
      const text = value.split(/\r?\n/).find((line) => foldText(line).includes(needle)) ?? value;
      matches.push({ ref, pointer, text: text.slice(0, 280) });
    }
  }
  for (const item of work.itemStates(undefined, true)) {
    if (matches.length >= limit) break;
    if (item.deleted) continue;
    try {
      visit(item.sha256 ? work.value(item) : work.publishedValue(item.ref), formatRef(item.ref), "");
    } catch (error) {
      if (!(error instanceof CliError && error.code === "not_supported_yet")) throw error;
    }
  }
  return { matches };
}
