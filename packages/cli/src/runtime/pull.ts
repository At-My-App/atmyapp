import * as path from "path";
import type { ApiClient } from "./api";
import { encodeStoragePath } from "./api";
import {
  isTextual,
  mapLimit,
  readEntryBlob,
  readEntryVariants,
  readFileVariants,
  readLocalization,
  type Localization,
  type RawEntry,
} from "./content";
import { CliError, EXIT } from "./errors";
import { spaceNames } from "./spaces";
import { contentFingerprint, sha256Hex } from "./fingerprint";
import { fetchRemoteSchema, type RemoteSchema } from "./schema";
import {
  ContentStore,
  PUBLISHED,
  encodeSegment,
  emptyManifest,
  ensureStoreIgnored,
  type EntryRecord,
  type FileRecord,
  type StoreManifest,
  type StoredVariant,
  type VariantRecord,
} from "./store";
import { collectAssetMap, type DeliveredAsset } from "./views";
import type { PullSummary } from "./schemas/content";

export type { PullSummary } from "./schemas/content";

/**
 * `atmyapp content pull` (AgenticCliPlan.md §5.4): refreshes the read-only
 * `published/` copy. The first pull (or --full) reads everything; later
 * pulls read only what the storage history says changed since `baseCommit`.
 */

export interface PullOptions {
  full?: boolean;
  /** Download images and files too (default: lazy, served from their URL). */
  media?: boolean;
  onProgress?: (message: string) => void;
}

interface PullContext {
  api: ApiClient;
  store: ContentStore;
  schema: RemoteSchema;
  localization: Localization | null;
  manifest: StoreManifest;
  media: boolean;
  progress: (message: string) => void;
  counts: { files: number; entries: number; translations: number; removed: number };
}

interface HistoryHead {
  headCommitSha: string | null;
}

interface DiffChange {
  key: string;
  kind: string;
  change: "added" | "modified" | "deleted";
  label: string;
  path: string;
}

interface DiffResponse {
  changes: DiffChange[];
  truncated?: boolean;
}

const CONCURRENCY = 6;
const PAGE = 50;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType.split(";")[0].trim()] ?? "bin";
}

/** The newest commit on main, or null when the project has no Git history. */
export async function headCommit(api: ApiClient): Promise<string | null> {
  const history = await api.json<HistoryHead>("GET", "storage/history", {
    query: { limit: 1, branch: "main" },
    allow: [404, 409, 501],
  });
  return history?.headCommitSha ?? null;
}

function hiddenPath(path: string): boolean {
  return path.startsWith(".ama") || path === ".structure.json" || path.startsWith("structure/");
}

function variantRecord(variant: StoredVariant, sha: string): VariantRecord {
  return { status: variant.status, mode: variant.mode, sha256: sha };
}

// --- Files ----------------------------------------------------------------------

async function pullFileVariants(ctx: PullContext, storagePath: string): Promise<Record<string, VariantRecord> | undefined> {
  if (!ctx.localization || !ctx.schema.localizationEnabled) return undefined;
  const variants = await readFileVariants(ctx.api, storagePath);
  const records: Record<string, VariantRecord> = {};
  for (const [locale, variant] of Object.entries(variants)) {
    const sha = ctx.store.writeJson(ctx.store.fileVariantPath(storagePath, locale), variant);
    records[locale] = variantRecord(variant, sha);
    ctx.counts.translations++;
  }
  return Object.keys(records).length ? records : undefined;
}

async function pullFile(ctx: PullContext, storagePath: string, listedMime?: string): Promise<void> {
  const owner = ctx.schema.definitionForPath(storagePath);
  const kind = (owner?.definition.kind ?? "other") as FileRecord["kind"];
  const structured = kind === "document" || kind === "system_config";
  const guessedMime = listedMime || (/\.jsonx?$/i.test(storagePath) ? "application/json" : "application/octet-stream");
  const textual = structured || isTextual(guessedMime, storagePath);
  const route = `storage/f/${encodeStoragePath(storagePath)}`;

  if (!textual && !ctx.media) {
    // Static URLs are content-addressed (hash in the URL), so they stay valid
    // until the file changes, and a change comes back through the diff.
    const staticUrl = await ctx.api
      .json<{ staticUrl?: string }>("GET", `storage/static/${encodeStoragePath(storagePath)}`, { query: { branch: "main" }, allow: [400, 404] })
      .catch(() => null);
    ctx.manifest.files[storagePath] = {
      kind,
      definition: owner?.name ?? null,
      mimeType: guessedMime,
      size: 0,
      sha256: "",
      fingerprint: "",
      downloaded: false,
      ...(staticUrl?.staticUrl ? { url: staticUrl.staticUrl } : {}),
    };
    ctx.counts.files++;
    return;
  }

  const stored = await ctx.api.bytes(route, { query: { branch: "main", skipTransformations: "true" }, allow: [404] });
  if (!stored) {
    removeFile(ctx, storagePath);
    return;
  }
  const sha = ctx.store.writePublishedFile(storagePath, stored.bytes, textual);
  let fingerprint = sha256Hex(stored.bytes);
  if (textual) {
    const text = new TextDecoder().decode(stored.bytes);
    let parsed: unknown = text;
    if (/json/i.test(stored.contentType) || /\.jsonx?$/i.test(storagePath)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    fingerprint = contentFingerprint("file", parsed);
    if (structured && parsed && typeof parsed === "object") {
      // The delivered form tells local mode what each stored asset becomes.
      const delivered = await ctx.api.bytes(route, { query: { branch: "main" }, allow: [404] });
      if (delivered) {
        try {
          collectAssetMap(parsed, JSON.parse(new TextDecoder().decode(delivered.bytes)), ctx.manifest.assets);
        } catch {
          // Not JSON when delivered: nothing to map.
        }
      }
    }
  }
  ctx.manifest.files[storagePath] = {
    kind,
    definition: owner?.name ?? null,
    mimeType: stored.contentType,
    size: stored.bytes.length,
    sha256: sha,
    fingerprint,
    downloaded: true,
    locales: textual ? await pullFileVariants(ctx, storagePath) : undefined,
  };
  ctx.counts.files++;
}

function removeFile(ctx: PullContext, storagePath: string) {
  ctx.store.remove(ctx.store.filePath(storagePath));
  for (const locale of Object.keys(ctx.manifest.files[storagePath]?.locales ?? {})) {
    ctx.store.remove(ctx.store.fileVariantPath(storagePath, locale));
  }
  if (ctx.manifest.files[storagePath]) ctx.counts.removed++;
  delete ctx.manifest.files[storagePath];
}

async function pullAllFiles(ctx: PullContext) {
  const listing = await ctx.api.json<{ manifestFiles?: Record<string, { mimeType?: string; contentType?: string }> }>(
    "GET",
    "storage/f",
    { query: { branch: "main", includeHomeData: "true" } },
  );
  const paths = Object.keys(listing?.manifestFiles ?? {}).filter((path) => !hiddenPath(path));
  // Documents the schema declares but nobody has saved yet are simply absent.
  ctx.progress(`Reading ${paths.length} files…`);
  await mapLimit(paths, CONCURRENCY, (path) => {
    const meta = listing!.manifestFiles![path] ?? {};
    return pullFile(ctx, path, meta.mimeType || meta.contentType);
  });
}

// --- Entries --------------------------------------------------------------------

function blobIds(value: unknown, assets: Record<string, DeliveredAsset>, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(assets, `__blob:${value}`)) into.add(value);
  else if (Array.isArray(value)) value.forEach((item) => blobIds(item, assets, into));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.__blob === "string") into.add(record.__blob);
    else Object.values(record).forEach((item) => blobIds(item, assets, into));
  }
  return into;
}

function collectionTranslatable(ctx: PullContext, collection: string): boolean {
  if (!ctx.localization || !ctx.schema.localizationEnabled) return false;
  return (ctx.schema.summaries().find((summary) => summary.name === collection)?.localizedFields.length ?? 0) > 0;
}

async function writeEntry(ctx: PullContext, collection: string, stored: RawEntry, delivered: RawEntry | undefined) {
  const wrapper = { id: stored.id, data: stored.data, createdAt: stored.created, updatedAt: stored.updated };
  const sha = ctx.store.writeJson(ctx.store.entryPath(collection, stored.id), wrapper);
  const assets = delivered ? collectAssetMap(stored.data, delivered.data) : {};
  Object.assign(ctx.manifest.assets, assets);
  const record: EntryRecord = {
    sha256: sha,
    fingerprint: contentFingerprint("entry", stored.data),
    ...(stored.created ? { createdAt: stored.created } : {}),
    ...(stored.updated ? { updatedAt: stored.updated } : {}),
  };
  if (ctx.media) {
    const downloaded: string[] = [];
    for (const blobId of blobIds(stored.data, assets)) {
      const blob = await readEntryBlob(ctx.api, collection, stored.id, blobId).catch(() => null);
      if (!blob) continue;
      ctx.store.writeBytes(path.join(ctx.store.entryDir(collection, stored.id), `blob_${encodeSegment(blobId)}.${extensionFor(blob.contentType)}`), blob.bytes);
      downloaded.push(blobId);
    }
    if (downloaded.length) record.blobs = downloaded;
  }
  if (collectionTranslatable(ctx, collection)) {
    const variants = await readEntryVariants(ctx.api, collection, stored.id);
    const locales: Record<string, VariantRecord> = {};
    for (const [locale, variant] of Object.entries(variants)) {
      locales[locale] = variantRecord(variant, ctx.store.writeJson(ctx.store.entryVariantPath(collection, stored.id, locale), variant));
      ctx.counts.translations++;
    }
    if (Object.keys(locales).length) record.locales = locales;
  }
  (ctx.manifest.collections[collection] ??= { entries: {} }).entries[stored.id] = record;
  ctx.counts.entries++;
}

async function pullCollection(ctx: PullContext, collection: string) {
  ctx.store.remove(ctx.store.collectionDir(collection));
  ctx.manifest.collections[collection] = { entries: {} };
  const base = `collections/${encodeURIComponent(collection)}/entries`;
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const query = { branch: "main", limit: PAGE, offset, order: "created.asc" };
    const [stored, delivered] = await Promise.all([
      ctx.api.json<{ entries?: RawEntry[]; total?: number }>("GET", base, { query: { ...query, expandBlobs: "none", plugins: "with-id" } }),
      ctx.api.json<{ entries?: RawEntry[]; total?: number }>("GET", base, { query }),
    ]);
    const entries = stored?.entries ?? [];
    total = stored?.total ?? entries.length;
    const deliveredById = new Map((delivered?.entries ?? []).map((entry) => [entry.id, entry]));
    await mapLimit(entries, CONCURRENCY, (entry) => writeEntry(ctx, collection, entry, deliveredById.get(entry.id)));
    if (!entries.length) break;
    offset += entries.length;
    ctx.progress(`${collection}: ${Math.min(offset, total)}/${total} entries`);
  }
}

async function pullEntry(ctx: PullContext, collection: string, entryId: string) {
  const route = `collections/${encodeURIComponent(collection)}/entries/${encodeURIComponent(entryId)}`;
  const [stored, delivered] = await Promise.all([
    ctx.api.json<RawEntry>("GET", route, { query: { branch: "main", expandBlobs: "none", plugins: "with-id" }, allow: [404] }),
    ctx.api.json<RawEntry>("GET", route, { query: { branch: "main" }, allow: [404] }),
  ]);
  if (!stored) {
    removeEntry(ctx, collection, entryId);
    return;
  }
  await writeEntry(ctx, collection, stored, delivered ?? undefined);
}

function removeEntry(ctx: PullContext, collection: string, entryId: string) {
  ctx.store.remove(ctx.store.entryDir(collection, entryId));
  const entries = ctx.manifest.collections[collection]?.entries;
  if (entries?.[entryId]) {
    delete entries[entryId];
    ctx.counts.removed++;
  }
}

async function pullEntryVariantsOnly(ctx: PullContext, collection: string, entryId: string) {
  const record = ctx.manifest.collections[collection]?.entries[entryId];
  if (!record) return pullEntry(ctx, collection, entryId);
  for (const locale of Object.keys(record.locales ?? {})) {
    ctx.store.remove(ctx.store.entryVariantPath(collection, entryId, locale));
  }
  const variants = await readEntryVariants(ctx.api, collection, entryId);
  const locales: Record<string, VariantRecord> = {};
  for (const [locale, variant] of Object.entries(variants)) {
    locales[locale] = variantRecord(variant, ctx.store.writeJson(ctx.store.entryVariantPath(collection, entryId, locale), variant));
    ctx.counts.translations++;
  }
  record.locales = Object.keys(locales).length ? locales : undefined;
}

// --- Change application ---------------------------------------------------------

/** `entry:<collection>:<id>` → parts (IDs may contain ':'). */
function splitEntryKey(key: string, prefix: string): { collection: string; rest: string } | null {
  const body = key.slice(prefix.length);
  const colon = body.indexOf(":");
  if (colon <= 0) return null;
  return { collection: body.slice(0, colon), rest: body.slice(colon + 1) };
}

const ENTRY_VARIANT_PATH = /^collections\/([^/]+)\/entries\/([^/]+)\/variants\//;

/** Applies one diff; returns false when only a full pull can apply it. */
async function applyChanges(ctx: PullContext, changes: DiffChange[]): Promise<{ ok: boolean; reason?: string }> {
  if (changes.some((change) => change.kind === "structure")) return { ok: false, reason: "The schema changed." };
  const collections = new Set<string>();
  const entries = new Map<string, { collection: string; id: string; deleted: boolean }>();
  const entryVariants = new Map<string, { collection: string; id: string }>();
  const files = new Map<string, boolean>();
  const fileVariants = new Set<string>();

  for (const change of changes) {
    if (change.kind === "collection") collections.add(change.label);
    else if (change.kind === "entry") {
      const parts = splitEntryKey(change.key, "entry:");
      if (parts) entries.set(`${parts.collection}\u0000${parts.rest}`, { collection: parts.collection, id: parts.rest, deleted: change.change === "deleted" });
    } else if (change.key.startsWith("entry-locale:")) {
      const parts = splitEntryKey(change.key, "entry-locale:");
      const id = parts?.rest.slice(0, parts.rest.lastIndexOf(":"));
      if (parts && id) entryVariants.set(`${parts.collection}\u0000${id}`, { collection: parts.collection, id });
    } else if (change.key.startsWith("entry-variant:")) {
      const match = ENTRY_VARIANT_PATH.exec(change.path);
      if (match) {
        const collection = decodeURIComponent(match[1]);
        const id = decodeURIComponent(match[2]);
        entryVariants.set(`${collection}\u0000${id}`, { collection, id });
      }
    } else if (change.kind === "file") files.set(change.label, change.change === "deleted");
    else if (change.key.startsWith("file-locale:")) {
      const body = change.key.slice("file-locale:".length);
      fileVariants.add(body.slice(0, body.lastIndexOf(":")));
    } else if (change.key.startsWith("file-variant:")) fileVariants.add(change.label);
  }

  for (const collection of collections) {
    if (!ctx.schema.collections().includes(collection)) {
      ctx.store.remove(ctx.store.collectionDir(collection));
      delete ctx.manifest.collections[collection];
      continue;
    }
    await pullCollection(ctx, collection);
  }
  await mapLimit([...entries.values()].filter((entry) => !collections.has(entry.collection)), CONCURRENCY, (entry) =>
    entry.deleted ? Promise.resolve(removeEntry(ctx, entry.collection, entry.id)) : pullEntry(ctx, entry.collection, entry.id),
  );
  await mapLimit(
    [...entryVariants.values()].filter(
      (entry) => !collections.has(entry.collection) && !entries.has(`${entry.collection}\u0000${entry.id}`),
    ),
    CONCURRENCY,
    (entry) => pullEntryVariantsOnly(ctx, entry.collection, entry.id),
  );
  await mapLimit([...files.entries()], CONCURRENCY, ([path, deleted]) =>
    deleted ? Promise.resolve(removeFile(ctx, path)) : pullFile(ctx, path, ctx.manifest.files[path]?.mimeType),
  );
  await mapLimit([...fileVariants].filter((path) => !files.has(path)), CONCURRENCY, async (path) => {
    const record = ctx.manifest.files[path];
    if (!record) return pullFile(ctx, path);
    for (const locale of Object.keys(record.locales ?? {})) ctx.store.remove(ctx.store.fileVariantPath(path, locale));
    record.locales = await pullFileVariants(ctx, path);
  });
  return { ok: true };
}

async function diffSince(api: ApiClient, base: string, head: string): Promise<DiffResponse | null> {
  return api.json<DiffResponse>("GET", `storage/history/${encodeURIComponent(head)}/diff`, {
    query: { baseCommitSha: base, branch: "main" },
    allow: [400, 404, 409],
  });
}

/** Catches up with commits made while the pull ran. */
async function settle(ctx: PullContext, from: string | null, notes: string[]): Promise<string | null> {
  let base = from;
  for (let round = 0; round < 3 && base; round++) {
    const head = await headCommit(ctx.api);
    if (!head || head === base) return base;
    const diff = await diffSince(ctx.api, base, head);
    if (!diff || diff.truncated) {
      notes.push("Content changed during the pull and could not be caught up; run 'atmyapp content pull' again.");
      return base;
    }
    const applied = await applyChanges(ctx, diff.changes);
    if (!applied.ok) {
      notes.push(`${applied.reason} Run 'atmyapp content pull --full'.`);
      return base;
    }
    base = head;
  }
  return base;
}

export async function pullContent(api: ApiClient, options: PullOptions = {}, cwd: string = process.cwd()): Promise<PullSummary> {
  const store = new ContentStore(cwd);
  const progress = options.onProgress ?? (() => {});
  const release = store.lockPublished();
  try {
    ensureStoreIgnored(cwd);
    const hasSpaces = spaceNames(store).length > 0;
    const previous = !options.full || hasSpaces ? store.readManifest() : null;
    const sameProject = previous?.projectId === api.session.projectId &&
      (!previous.projectBase || previous.projectBase === api.projectBase);
    if (hasSpaces && previous && !sameProject)
      throw new CliError("project_mismatch", "The local draft spaces belong to another project.", {
        exitCode: EXIT.auth,
        fix: "Pull this project in a separate directory.",
      });
    const existing = options.full ? null : previous;
    const notes: string[] = [];
    const media = options.media ?? existing?.media === "full";
    const counts = { files: 0, entries: 0, translations: 0, removed: 0 };

    const head = await headCommit(api);
    const canIncrement =
      existing &&
      sameProject &&
      existing.baseCommit &&
      head &&
      (existing.media === "full") === media;

    if (canIncrement && existing.baseCommit === head) {
      if (!existing.projectBase) {
        existing.projectBase = api.projectBase;
        store.writeManifest(existing);
      }
      return { mode: "up-to-date", baseCommit: head, previousCommit: head, ...counts, notes, dir: store.spaceDir() };
    }

    const schema = await fetchRemoteSchema(api);
    const localization = await readLocalization(api);
    const staging = store.withPublished(`${PUBLISHED}.next`);
    staging.clearPublished();

    if (canIncrement) {
      const previousCommit = existing.baseCommit;
      const diff = await diffSince(api, existing.baseCommit!, head!);
      if (diff && !diff.truncated) {
        store.copyPublishedTo(staging);
        staging.writeSchema(schema.raw);
        const ctx: PullContext = { api, store: staging, schema, localization, manifest: existing, media, progress, counts };
        existing.projectBase = api.projectBase;
        existing.schemaHash = schema.hash;
        existing.localization = localization;
        const applied = await applyChanges(ctx, diff.changes);
        if (applied.ok) {
          existing.baseCommit = await settle(ctx, head, notes);
          existing.pulledAt = new Date().toISOString();
          staging.writeManifest(existing);
          store.promotePublished(staging.published);
          return { mode: "incremental", baseCommit: existing.baseCommit, previousCommit, ...counts, notes, dir: store.spaceDir() };
        }
        notes.push(`${applied.reason} Reading everything again.`);
        counts.files = counts.entries = counts.translations = counts.removed = 0;
      } else {
        notes.push(diff?.truncated ? "Too many changes to apply one by one; reading everything again." : "The previous version is no longer available; reading everything again.");
      }
    } else if (existing && !head) {
      notes.push("This project has no storage history yet, so every pull reads everything.");
    }

    // Full pull, written aside and swapped in when complete.
    const manifest = emptyManifest({ projectId: api.session.projectId, branch: "main" });
    manifest.projectBase = api.projectBase;
    manifest.schemaHash = schema.hash;
    manifest.localization = localization;
    manifest.media = media ? "full" : "lazy";
    staging.clearPublished();
    staging.writeSchema(schema.raw);
    const ctx: PullContext = { api, store: staging, schema, localization, manifest, media, progress, counts };
    await pullAllFiles(ctx);
    for (const collection of schema.collections()) await pullCollection(ctx, collection);
    manifest.baseCommit = await settle(ctx, head, notes);
    manifest.pulledAt = new Date().toISOString();
    staging.writeManifest(manifest);
    store.promotePublished(`${PUBLISHED}.next`);
    return { mode: "full", baseCommit: manifest.baseCommit, previousCommit: existing?.baseCommit ?? null, ...counts, notes, dir: store.spaceDir() };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("pull_failed", `The pull stopped: ${error instanceof Error ? error.message : String(error)}`, {
      fix: "Run 'atmyapp content pull' again. The previous local copy is still in place.",
    });
  } finally {
    release();
  }
}
