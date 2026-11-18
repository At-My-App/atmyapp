import { compileSchema, mergeVariantOverlay, resolveDefinitionForPath, type CompiledSchema, type Definition, type SchemaDocument } from "@atmyapp/structure";
import { loadNodeBuiltin } from "./nodeBuiltins";

/**
 * Reader for the local content store that `atmyapp content pull` writes
 * (`.ama/content`, format 2; the CLI's runtime/store.ts writes it — keep the
 * two in sync):
 *
 *   published/manifest.json                 what was pulled, at which commit
 *   published/f/<path>                      documents and files, as stored
 *   published/locales/f/<path>/<loc>.json   file translations
 *   published/collections/<c>/<id>/entry.json (+ locales/<loc>.json, blob_*)
 *   <space>/…                               the same layout: a space's changes
 *   <space>/space.json                      { deletions: ["file:<path>", "entry:<c>:<id>"] }
 *   <space>/collections/<c>/_new/<name>.json  entry data for entries not created yet
 *
 * `with-fallback` reads published/ only, so drafts never reach a live site;
 * `local` reads the active space over published/.
 */

type NodeFs = typeof import("fs");
type NodePath = typeof import("path");
type NodeUrl = typeof import("url");

export interface LocalReadContext {
  /** Requested translation (the source when absent). */
  locale?: string;
  /** Read published content only, never a space's drafts (with-fallback). */
  publishedOnly?: boolean;
}

interface StoredVariant {
  mode: "overlay" | "replace";
  data: unknown;
}

interface FileRecord {
  mimeType: string;
  downloaded: boolean;
  url?: string;
}

interface StoreManifest {
  version: 2;
  files: Record<string, FileRecord>;
  collections: Record<string, { entries: Record<string, { createdAt?: string; updatedAt?: string; blobs?: string[] }> }>;
  assets: Record<string, Record<string, unknown>>;
  localization: { defaultLocale: string; supportedLocales: string[] } | null;
}

interface SpaceFile {
  deletions?: string[];
}

export interface LocalStoreEntry {
  id: string;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

function encodeSegment(segment: string): string {
  if (segment === "." || segment === "..") return encodeURIComponent(segment).replace(/\./g, "%2E");
  return encodeURIComponent(segment).replace(/\*/g, "%2A");
}

function encodePath(storagePath: string): string[] {
  return storagePath.replace(/^\/+/, "").split("/").filter(Boolean).map(encodeSegment);
}

function nodeModules(): { fs: NodeFs; path: NodePath; url: NodeUrl } | null {
  const fs = loadNodeBuiltin<NodeFs>("fs");
  const path = loadNodeBuiltin<NodePath>("path");
  const url = loadNodeBuiltin<NodeUrl>("url");
  return fs && path && url ? { fs, path, url } : null;
}

export class LocalStore {
  private readonly manifest: StoreManifest;
  private readonly schema?: CompiledSchema;
  private readonly space: { dir: string; deletions: Set<string> } | null;

  private constructor(
    private readonly node: { fs: NodeFs; path: NodePath; url: NodeUrl },
    private readonly root: string,
    spaceName: string | null,
  ) {
    this.manifest = JSON.parse(node.fs.readFileSync(node.path.join(root, "published", "manifest.json"), "utf8"));
    const schema = this.readJsonFile<SchemaDocument>(node.path.join(root, "published", "schema.json"));
    if (schema) {
      try { this.schema = compileSchema(schema); }
      catch { /* Legacy local snapshots may only provide usable content files. */ }
    }
    if (spaceName && spaceName !== "published" && /^[a-z0-9-]{1,40}$/.test(spaceName)) {
      const dir = node.path.join(root, spaceName);
      const spaceFile = this.readJsonFile<SpaceFile>(node.path.join(dir, "space.json"));
      this.space = node.fs.existsSync(dir) ? { dir, deletions: new Set(spaceFile?.deletions ?? []) } : null;
    } else {
      this.space = null;
    }
  }

  /**
   * The store under `root` (default `.ama/content`), or null when there is
   * none. `space` defaults to ATMYAPP_SPACE, then `.current`, then `default`.
   */
  static open(options: { root?: string; space?: string | null; publishedOnly?: boolean } = {}): LocalStore | null {
    const node = nodeModules();
    if (!node) return null;
    const root = node.path.resolve(process.cwd(), options.root ?? ".ama/content");
    if (!node.fs.existsSync(node.path.join(root, "published", "manifest.json"))) return null;
    let space: string | null = null;
    if (!options.publishedOnly) {
      space = options.space ?? process.env.ATMYAPP_SPACE?.trim() ?? null;
      if (!space) {
        const current = node.path.join(root, ".current");
        space = node.fs.existsSync(current) ? node.fs.readFileSync(current, "utf8").trim() || null : null;
      }
      if (!space && node.fs.existsSync(node.path.join(root, "default"))) space = "default";
    }
    try {
      return new LocalStore(node, root, space);
    } catch {
      return null;
    }
  }

  private readJsonFile<T>(file: string): T | null {
    if (!this.node.fs.existsSync(file)) return null;
    try {
      return JSON.parse(this.node.fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** The first existing file: in the space (unless deleted there), then published. */
  private locate(relative: string[], itemKey: string): string | null {
    const { fs, path } = this.node;
    if (this.space) {
      if (this.space.deletions.has(itemKey)) return null;
      const inSpace = path.join(this.space.dir, ...relative);
      if (fs.existsSync(inSpace)) return inSpace;
    }
    const published = path.join(this.root, "published", ...relative);
    return fs.existsSync(published) ? published : null;
  }

  private isJson(storagePath: string): boolean {
    const record = this.manifest.files[storagePath];
    return /json/i.test(record?.mimeType ?? "") || /\.jsonx?$/i.test(storagePath);
  }

  private translate(value: unknown, variantFile: string | null, definition?: Definition): unknown {
    const variant = variantFile ? this.readJsonFile<StoredVariant>(variantFile) : null;
    if (!variant) return value;
    const field = definition && "fields" in definition ? { kind: "object" as const, fields: definition.fields } : undefined;
    return variant.mode === "replace" ? variant.data : mergeVariantOverlay(value, variant.data, field);
  }

  /** Stored asset references → what websites receive; `$file` → a local file URL. */
  private deliver(value: unknown, baseDir: string): unknown {
    if (typeof value === "string") return this.manifest.assets[`__blob:${value}`] ?? value;
    if (Array.isArray(value)) return value.map((item) => this.deliver(item, baseDir));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.$asset === "string") return this.manifest.assets[`$asset:${record.$asset}`] ?? value;
    if (typeof record.__blob === "string") return this.manifest.assets[`__blob:${record.__blob}`] ?? value;
    if (typeof record.$file === "string") {
      const { $file, ...rest } = record;
      return { ...rest, url: this.node.url.pathToFileURL(this.node.path.resolve(baseDir, $file)).href };
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, this.deliver(item, baseDir)]));
  }

  private fileVariant(storagePath: string, locale?: string): string | null {
    if (!locale || locale === this.manifest.localization?.defaultLocale) return null;
    return this.locate(["locales", "f", ...encodePath(storagePath), `${encodeSegment(locale)}.json`], `file-locale:${storagePath}:${locale}`);
  }

  readJson(storagePath: string, context: LocalReadContext = {}): unknown | null {
    const file = this.locate(["f", ...encodePath(storagePath)], `file:${storagePath}`);
    if (!file || !this.isJson(storagePath)) return null;
    let value: unknown;
    try {
      value = JSON.parse(this.node.fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    return this.deliver(this.translate(value, this.fileVariant(storagePath, context.locale), this.schema && resolveDefinitionForPath(this.schema, storagePath)?.definition), this.node.path.dirname(file));
  }

  readFile(storagePath: string, context: LocalReadContext = {}): string | Buffer | null {
    const file = this.locate(["f", ...encodePath(storagePath)], `file:${storagePath}`);
    if (!file) return null;
    const record = this.manifest.files[storagePath];
    const textual = this.isJson(storagePath) || /text|markdown|mdx|yaml/i.test(record?.mimeType ?? "") || /\.(md|mdx|txt|ya?ml)$/i.test(storagePath);
    if (!textual) return this.node.fs.readFileSync(file);
    const text = this.node.fs.readFileSync(file, "utf8");
    if (this.isJson(storagePath)) return JSON.stringify(this.readJson(storagePath, context));
    const translated = this.translate(text, this.fileVariant(storagePath, context.locale));
    return typeof translated === "string" ? translated : text;
  }

  /** A local file URL for downloaded or space files, else the published URL. */
  staticUrl(storagePath: string): string | null {
    if (this.space?.deletions.has(`file:${storagePath}`)) return null;
    const file = this.locate(["f", ...encodePath(storagePath)], `file:${storagePath}`);
    if (file) return this.node.url.pathToFileURL(file).href;
    return this.manifest.files[storagePath]?.url ?? null;
  }

  private entryIds(collection: string): string[] {
    const { fs, path } = this.node;
    const ids = new Set(Object.keys(this.manifest.collections[collection]?.entries ?? {}));
    if (this.space) {
      const dir = path.join(this.space.dir, "collections", encodeSegment(collection));
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          if (name !== "_new" && fs.existsSync(path.join(dir, name, "entry.json"))) ids.add(decodeURIComponent(name));
        }
      }
      for (const key of this.space.deletions) {
        if (key.startsWith(`entry:${collection}:`)) ids.delete(key.slice(`entry:${collection}:`.length));
      }
    }
    return [...ids];
  }

  listCollection(collection: string, context: LocalReadContext = {}): LocalStoreEntry[] {
    const { fs, path } = this.node;
    const entries: LocalStoreEntry[] = [];
    const translate = context.locale && context.locale !== this.manifest.localization?.defaultLocale;
    for (const id of this.entryIds(collection)) {
      const base = ["collections", encodeSegment(collection), encodeSegment(id)];
      const key = `entry:${collection}:${id}`;
      const file = this.locate([...base, "entry.json"], key);
      const wrapper = file ? this.readJsonFile<{ data?: Record<string, unknown>; createdAt?: string; updatedAt?: string }>(file) : null;
      if (!wrapper?.data) continue;
      const variant = translate ? this.locate([...base, "locales", `${encodeSegment(context.locale!)}.json`], `entry-locale:${collection}:${id}:${context.locale}`) : null;
      entries.push({
        id,
        data: this.deliver(this.translate(wrapper.data, variant, this.schema?.document.definitions[collection]), path.dirname(file!)) as Record<string, unknown>,
        createdAt: wrapper.createdAt,
        updatedAt: wrapper.updatedAt,
      });
    }
    if (this.space) {
      const fresh = path.join(this.space.dir, "collections", encodeSegment(collection), "_new");
      if (fs.existsSync(fresh)) {
        for (const name of fs.readdirSync(fresh).filter((file) => file.endsWith(".json")).sort()) {
          const data = this.readJsonFile<Record<string, unknown>>(path.join(fresh, name));
          if (data && typeof data === "object") {
            entries.push({ id: name.replace(/\.json$/, ""), data: this.deliver(data, fresh) as Record<string, unknown> });
          }
        }
      }
    }
    return entries;
  }
}
