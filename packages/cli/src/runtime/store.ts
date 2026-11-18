import * as fs from "fs";
import * as path from "path";
import { CliError } from "./errors";
import { sha256Hex } from "./fingerprint";
import type { DeliveredAsset } from "./views";

/**
 * The local content store (AgenticCliPlan.md §5): `.ama/content/`.
 *
 *   .objects/<sha256>                       content-addressed bytes (bases)
 *   published/manifest.json                 StoreManifest (version 2)
 *   published/schema.json                   remote schema at baseCommit
 *   published/f/<path>                      documents and files, verbatim
 *   published/locales/f/<path>/<loc>.json   file translations (StoredVariant)
 *   published/collections/<c>/<id>/entry.json
 *   published/collections/<c>/<id>/locales/<loc>.json
 *   published/collections/<c>/<id>/blob_<blobId>.<ext>   (media, when pulled)
 *   <space>/space.json + the same layout    a space: only its changes (C2)
 *
 * `@atmyapp/core` reads this layout in local mode (`localStore.ts` there);
 * keep the two in sync. Path segments are encoded with `encodeSegment`.
 */

export const STORE_VERSION = 2;
export const PUBLISHED = "published";

export interface StoredVariant {
  mode: "overlay" | "replace";
  status: string;
  sourceHashes: Record<string, string>;
  data: unknown;
}

export interface VariantRecord {
  status: string;
  mode: "overlay" | "replace";
  sha256: string;
}

export interface FileRecord {
  kind: "document" | "system_config" | "file" | "image" | "other";
  definition: string | null;
  mimeType: string;
  size: number;
  /** sha256 of the stored bytes; the object name when stored. */
  sha256: string;
  /** Server-compatible content fingerprint (see fingerprint.ts). */
  fingerprint: string;
  /** False for media that was not downloaded (lazy). */
  downloaded: boolean;
  /** Published URL of media, so local mode can serve files it did not download. */
  url?: string;
  locales?: Record<string, VariantRecord>;
}

export interface EntryRecord {
  sha256: string;
  fingerprint: string;
  createdAt?: string;
  updatedAt?: string;
  /** Blob IDs downloaded next to entry.json. */
  blobs?: string[];
  locales?: Record<string, VariantRecord>;
}

export interface StoreManifest {
  version: typeof STORE_VERSION;
  projectId: string;
  branch: string;
  /** Git commit the copy matches; null when the project has no Git history. */
  baseCommit: string | null;
  pulledAt: string;
  schemaHash: string;
  localization: { defaultLocale: string; supportedLocales: string[] } | null;
  media: "lazy" | "full";
  files: Record<string, FileRecord>;
  collections: Record<string, { entries: Record<string, EntryRecord> }>;
  /** Stored asset reference (`$asset:…`, `__blob:…`) → what websites receive. */
  assets: Record<string, DeliveredAsset>;
}

/** Encodes one path segment so any storage name is a safe file name everywhere. */
export function encodeSegment(segment: string): string {
  if (segment === "." || segment === "..") return encodeURIComponent(segment).replace(/\./g, "%2E");
  return encodeURIComponent(segment).replace(/\*/g, "%2A");
}

export function decodeSegment(segment: string): string {
  return decodeURIComponent(segment);
}

function encodePath(storagePath: string): string[] {
  return storagePath.replace(/^\/+/, "").split("/").filter(Boolean).map(encodeSegment);
}

function writeAtomic(file: string, data: Uint8Array | string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

export function emptyManifest(input: Pick<StoreManifest, "projectId" | "branch">): StoreManifest {
  return {
    version: STORE_VERSION,
    projectId: input.projectId,
    branch: input.branch,
    baseCommit: null,
    pulledAt: new Date(0).toISOString(),
    schemaHash: "",
    localization: null,
    media: "lazy",
    files: {},
    collections: {},
    assets: {},
  };
}

/** Paths inside `.ama/content` for one space (or `published`). */
export class ContentStore {
  readonly root: string;
  /** Directory the published copy is written to (a staging name during a full pull). */
  readonly published: string;

  constructor(cwd: string = process.cwd(), options: { root?: string; published?: string } = {}) {
    this.root = options.root ?? path.join(cwd, ".ama", "content");
    this.published = options.published ?? PUBLISHED;
  }

  /** The same store, writing the published copy under another name. */
  withPublished(name: string): ContentStore {
    return new ContentStore(undefined, { root: this.root, published: name });
  }

  spaceDir(space: string = this.published): string {
    return path.join(this.root, space);
  }

  objectPath(sha256: string): string {
    return path.join(this.root, ".objects", sha256.slice(0, 2), sha256);
  }

  filePath(storagePath: string, space = this.published): string {
    return path.join(this.spaceDir(space), "f", ...encodePath(storagePath));
  }

  fileVariantPath(storagePath: string, locale: string, space = this.published): string {
    return path.join(this.spaceDir(space), "locales", "f", ...encodePath(storagePath), `${encodeSegment(locale)}.json`);
  }

  collectionDir(collection: string, space = this.published): string {
    return path.join(this.spaceDir(space), "collections", encodeSegment(collection));
  }

  entryDir(collection: string, entryId: string, space = this.published): string {
    return path.join(this.spaceDir(space), "collections", encodeSegment(collection), encodeSegment(entryId));
  }

  entryPath(collection: string, entryId: string, space = this.published): string {
    return path.join(this.entryDir(collection, entryId, space), "entry.json");
  }

  entryVariantPath(collection: string, entryId: string, locale: string, space = this.published): string {
    return path.join(this.entryDir(collection, entryId, space), "locales", `${encodeSegment(locale)}.json`);
  }

  manifestPath(): string {
    return path.join(this.spaceDir(), "manifest.json");
  }

  readManifest(): StoreManifest | null {
    const file = this.manifestPath();
    if (!fs.existsSync(file)) return null;
    let parsed: StoreManifest;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new CliError("store_corrupt", `${file} is not valid JSON.`, {
        fix: "Run 'atmyapp content pull --full' to rebuild the local copy.",
      });
    }
    if (parsed.version !== STORE_VERSION) {
      throw new CliError("store_version", `The local copy uses format ${parsed.version}; this CLI writes ${STORE_VERSION}.`, {
        fix: "Run 'atmyapp content pull --full' to rebuild the local copy.",
      });
    }
    return parsed;
  }

  writeManifest(manifest: StoreManifest) {
    writeAtomic(this.manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  writeSchema(raw: unknown) {
    writeAtomic(path.join(this.spaceDir(), "schema.json"), `${JSON.stringify(raw, null, 2)}\n`);
  }

  /** Stores bytes by hash (idempotent) and returns the hash. */
  putObject(bytes: Uint8Array | string): string {
    const sha = sha256Hex(bytes);
    const file = this.objectPath(sha);
    if (!fs.existsSync(file)) writeAtomic(file, bytes);
    return sha;
  }

  writePublishedFile(storagePath: string, bytes: Uint8Array, keepObject: boolean): string {
    const sha = keepObject ? this.putObject(bytes) : sha256Hex(bytes);
    writeAtomic(this.filePath(storagePath), bytes);
    return sha;
  }

  writeJson(file: string, value: unknown, keepObject = true): string {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const sha = keepObject ? this.putObject(text) : sha256Hex(text);
    writeAtomic(file, text);
    return sha;
  }

  writeBytes(file: string, bytes: Uint8Array) {
    writeAtomic(file, bytes);
  }

  remove(target: string) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  /** Removes this store's published directory (used for a fresh staging copy). */
  clearPublished() {
    fs.rmSync(this.spaceDir(), { recursive: true, force: true });
  }

  /**
   * Replaces published/ with the copy written under `next` in one rename, so
   * readers see either the old copy or the new one, never a half-written one.
   */
  promotePublished(next: string) {
    const live = path.join(this.root, PUBLISHED);
    const old = path.join(this.root, `${PUBLISHED}.old`);
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(live)) fs.renameSync(live, old);
    fs.renameSync(path.join(this.root, next), live);
    fs.rmSync(old, { recursive: true, force: true });
  }

  /**
   * Exclusive lock while the published copy is rewritten. A lock older than
   * ten minutes is treated as left behind by a crashed run.
   */
  lockPublished(): () => void {
    fs.mkdirSync(this.root, { recursive: true });
    const lock = path.join(this.root, ".lock");
    const take = () => {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
    };
    try {
      take();
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age < 10 * 60_000) {
        throw new CliError("store_locked", "Another 'atmyapp content pull' is updating the local copy.", {
          fix: `Wait for it to finish. If none is running, delete ${lock}.`,
        });
      }
      fs.rmSync(lock, { force: true });
      take();
    }
    return () => fs.rmSync(lock, { force: true });
  }
}

/** Adds `.ama/content/` to .gitignore once. */
export function ensureStoreIgnored(cwd: string = process.cwd()) {
  const file = path.join(cwd, ".gitignore");
  const line = ".ama/content/";
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).some((existing) => existing.trim() === line || existing.trim() === ".ama/content")) return false;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${current}${prefix}\n# AtMyApp local content (atmyapp content pull)\n${line}\n`);
  return true;
}
