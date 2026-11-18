import type { ApiClient } from "./api";
import { encodeStoragePath } from "./api";
import { CliError, EXIT } from "./errors";
import { contentFingerprint, sha256Hex } from "./fingerprint";
import { formatRef, type ContentRef } from "./refs";
import { fetchRemoteSchema, type RemoteSchema } from "./schema";
import { entryFilterQuery } from "./entryFilters";
import type { ContentMap, ContentView, EntryPage, Localization, LocaleStatusRow, RawEntry, ReadResult } from "./schemas/content";
import type { StoredVariant } from "./store";

/**
 * Remote reads (AgenticCliPlan.md §6.1). Views:
 *   stored     what is saved, and the only shape writes accept
 *   delivered  what the website SDK receives (assets as { url, alt })
 *   overlay    a translation's own fields only (locale required)
 *   effective  source with the translation applied (locale required; the default with a locale)
 */
export type { ContentMap, ContentMapItem, ContentView, EntryPage, Localization, LocaleStatusRow, RawEntry, ReadResult } from "./schemas/content";

const JSON_TYPES = /json|text|markdown|mdx|yaml|xml|javascript/i;

export function isTextual(mimeType: string, path?: string): boolean {
  return JSON_TYPES.test(mimeType) || /\.(json|jsonx|md|mdx|txt|ya?ml|csv|html?)$/i.test(path ?? "");
}

/** Runs `task` over `items` with at most `limit` at once, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  });
  const outcomes = await Promise.allSettled(workers);
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  return results;
}

export async function readLocalization(api: ApiClient): Promise<Localization | null> {
  const value = await api.json<Localization | null>("GET", "localization", { allow: [404] });
  if (!value || !Array.isArray(value.supportedLocales)) return null;
  return { defaultLocale: value.defaultLocale, supportedLocales: value.supportedLocales };
}

/** The locale a command was given, checked against the project's languages. */
export function checkLocale(locale: string | undefined, localization: Localization | null): string | null {
  if (!locale) return null;
  if (!localization) {
    throw new CliError("no_localization", "This project has no languages set up.", {
      exitCode: EXIT.usage,
      fix: "Read without --locale, or set up languages in Settings → Localization.",
    });
  }
  if (locale === localization.defaultLocale) return null;
  if (!localization.supportedLocales.includes(locale)) {
    throw new CliError("unsupported_locale", `'${locale}' is not one of this project's languages (${localization.supportedLocales.join(", ")}).`, {
      exitCode: EXIT.usage,
    });
  }
  return locale;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function parseMaybeJson(text: string, mimeType: string, path: string): unknown {
  if (/json/i.test(mimeType) || /\.jsonx?$/i.test(path)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function variantFor(variants: unknown, locale: string): StoredVariant | null {
  const list = Array.isArray(variants) ? variants : [];
  const match = list.find((variant: any) => variant?.scope?.locale === locale);
  if (!match) return null;
  return {
    mode: match.mode === "replace" ? "replace" : "overlay",
    status: String(match.status ?? "current"),
    sourceHashes: match.sourceHashes ?? {},
    data: match.data,
  };
}

/** Translations of one file, as stored. */
export async function readFileVariants(api: ApiClient, storagePath: string): Promise<Record<string, StoredVariant>> {
  const list = await api.json<unknown[]>("GET", `storage/variants/${encodeStoragePath(storagePath)}`, {
    query: { branch: "main" },
    allow: [400, 404],
  });
  return variantsByLocale(list);
}

/** Translations of one entry, as stored. */
export async function readEntryVariants(api: ApiClient, collection: string, entryId: string): Promise<Record<string, StoredVariant>> {
  const list = await api.json<unknown[]>(
    "GET",
    `collections/${encodeURIComponent(collection)}/entries/${encodeURIComponent(entryId)}/variants`,
    { query: { branch: "main" }, allow: [400, 404] },
  );
  return variantsByLocale(list);
}

function variantsByLocale(list: unknown): Record<string, StoredVariant> {
  const result: Record<string, StoredVariant> = {};
  for (const item of Array.isArray(list) ? list : []) {
    const locale = (item as any)?.scope?.locale;
    if (typeof locale !== "string") continue;
    const variant = variantFor([item], locale);
    if (variant) result[locale] = variant;
  }
  return result;
}

/** A document or file by storage path, in one view. */
export async function readStoragePath(
  api: ApiClient,
  storagePath: string,
  options: { view: ContentView; locale: string | null; definition: string | null; ref: string; kind: "document" | "file" },
): Promise<ReadResult> {
  const { view, locale } = options;
  if ((view === "overlay" || view === "effective") && !locale) {
    throw new CliError("locale_required", `The ${view} view needs --locale.`, { exitCode: EXIT.usage });
  }
  if (view === "overlay") {
    const variants = await readFileVariants(api, storagePath);
    const variant = locale ? variants[locale] : null;
    if (!variant) {
      throw new CliError("no_translation", `${options.ref} has no ${locale} translation yet.`, {
        details: { locales: Object.keys(variants) },
      });
    }
    return {
      ref: options.ref,
      kind: options.kind,
      path: storagePath,
      definition: options.definition,
      locale,
      view,
      mimeType: "application/json",
      fingerprint: sha256Hex(JSON.stringify(variant.data ?? null)),
      commitSha: null,
      value: variant.data,
      variant: { mode: variant.mode, status: variant.status, sourceHashes: variant.sourceHashes },
    };
  }
  const response = await api.bytes(`storage/f/${encodeStoragePath(storagePath)}`, {
    query: {
      branch: "main",
      ...(view === "delivered" ? {} : { skipTransformations: "true" }),
      ...(locale ? { locale } : {}),
    },
    allow: [404],
  });
  if (!response) {
    throw new CliError("not_found", `${options.ref} does not exist yet.`, {
      fix: "Run 'atmyapp content ls' to see what the project has.",
    });
  }
  const textual = isTextual(response.contentType, storagePath);
  const value = textual ? parseMaybeJson(decodeText(response.bytes), response.contentType, storagePath) : null;
  return {
    ref: options.ref,
    kind: options.kind,
    path: storagePath,
    definition: options.definition,
    locale,
    view,
    mimeType: response.contentType,
    fingerprint: textual ? contentFingerprint("file", value) : sha256Hex(response.bytes),
    commitSha: response.commitSha,
    value: textual ? value : { binary: true, size: response.bytes.length, mimeType: response.contentType },
  };
}

function entryQuery(view: ContentView, locale: string | null) {
  return {
    branch: "main",
    ...(view === "delivered" ? {} : { expandBlobs: "none", plugins: "with-id" }),
    ...(locale && view !== "overlay" ? { locale } : {}),
  };
}

export async function readEntry(
  api: ApiClient,
  collection: string,
  entryId: string,
  options: { view: ContentView; locale: string | null; ref: string },
): Promise<ReadResult & { entry: RawEntry }> {
  const { view, locale } = options;
  if ((view === "overlay" || view === "effective") && !locale) {
    throw new CliError("locale_required", `The ${view} view needs --locale.`, { exitCode: EXIT.usage });
  }
  const base = `collections/${encodeURIComponent(collection)}/entries/${encodeURIComponent(entryId)}`;
  if (view === "overlay") {
    const variants = await readEntryVariants(api, collection, entryId);
    const variant = locale ? variants[locale] : null;
    if (!variant) throw new CliError("no_translation", `${options.ref} has no ${locale} translation yet.`);
    return {
      ref: options.ref,
      kind: "entry",
      definition: collection,
      locale,
      view,
      mimeType: "application/json",
      fingerprint: sha256Hex(JSON.stringify(variant.data ?? null)),
      commitSha: null,
      value: variant.data,
      variant: { mode: variant.mode, status: variant.status, sourceHashes: variant.sourceHashes },
      entry: { id: entryId, data: (variant.data as Record<string, unknown>) ?? {} },
    };
  }
  const entry = await api.json<RawEntry>("GET", base, { query: entryQuery(view, locale), allow: [404] });
  if (!entry) {
    throw new CliError("not_found", `${options.ref} does not exist.`, {
      fix: `Run 'atmyapp entries ls ${collection}' to see the entries.`,
    });
  }
  return {
    ref: options.ref,
    kind: "entry",
    definition: collection,
    locale,
    view,
    mimeType: "application/json",
    fingerprint: contentFingerprint("entry", entry.data),
    commitSha: null,
    value: entry.data,
    entry,
  };
}

type EntryOrder = "created.asc" | "created.desc";
type EntryPagePosition = { offset: number } | { after: string };

function encodeCursor(payload: { o: number; s: EntryOrder } | { v: 2; k: string; s: EntryOrder }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, order: EntryOrder): EntryPagePosition {
  if (/^[A-Za-z0-9_-]{1,16384}$/.test(cursor)) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (parsed?.s === order) {
        if (parsed.v === 2 && typeof parsed.k === "string" && /^[A-Za-z0-9_-]{1,8192}$/.test(parsed.k)) {
          return { after: parsed.k };
        }
        if ((parsed.v === undefined || parsed.v === 1) && Number.isSafeInteger(parsed.o) && parsed.o >= 0) {
          return { offset: parsed.o };
        }
      }
    } catch {
      // The error below applies to malformed cursors and mismatched orders.
    }
  }
  throw new CliError("invalid_cursor", "This cursor is not valid for this listing.", {
    exitCode: EXIT.usage,
    fix: "Use the nextCursor from the previous page with the same --order.",
  });
}

export interface ListEntriesOptions {
  limit?: number;
  cursor?: string;
  order?: EntryOrder;
  view?: ContentView;
  locale?: string | null;
  where?: readonly string[];
  schema?: RemoteSchema;
}

export async function listEntries(
  api: ApiClient,
  collection: string,
  options: ListEntriesOptions = {},
): Promise<EntryPage> {
  const order = options.order ?? "created.desc";
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
  const position = options.cursor ? decodeCursor(options.cursor, order) : { offset: 0 };
  const view = options.view ?? "stored";
  if (view === "overlay") {
    throw new CliError("view_unsupported", "Lists support the stored, delivered and effective views.", { exitCode: EXIT.usage });
  }
  const where = options.where?.length
    ? entryFilterQuery(options.where, (options.schema ?? await fetchRemoteSchema(api)).collection(collection).fields)
    : undefined;
  const page = await api.json<{ entries?: RawEntry[]; total?: number; nextAfter?: string | null }>(
    "GET",
    `collections/${encodeURIComponent(collection)}/entries`,
    { query: { ...entryQuery(view, options.locale ?? null), ...where, ...position, limit, order } },
  );
  const entries = page?.entries ?? [];
  const total = page?.total ?? entries.length;
  if (page?.nextAfter !== undefined) {
    return {
      entries,
      total,
      nextCursor: page.nextAfter ? encodeCursor({ v: 2, k: page.nextAfter, s: order }) : null,
    };
  }
  if (where || "after" in position) {
    throw new CliError(
      where ? "filters_unsupported" : "cursor_unsupported",
      where ? "This AtMyApp server does not support --where." : "This AtMyApp server no longer accepts this cursor.",
      { fix: where ? "Use a server with collection filters enabled." : "Run the same listing again without --cursor." },
    );
  }
  const nextOffset = position.offset + entries.length;
  return {
    entries,
    total,
    nextCursor: entries.length > 0 && nextOffset < total ? encodeCursor({ o: nextOffset, s: order }) : null,
  };
}

/** Bytes of an entry blob. */
export async function readEntryBlob(api: ApiClient, collection: string, entryId: string, blobId: string) {
  return api.bytes(
    `collections/${encodeURIComponent(collection)}/entries/${encodeURIComponent(entryId)}/blobs/${encodeURIComponent(blobId)}`,
    { query: { branch: "main" } },
  );
}

/** Reads any item ref (doc/file/entry) in one view. */
export async function readRef(
  api: ApiClient,
  schema: RemoteSchema,
  ref: ContentRef,
  options: { view: ContentView; locale: string | null },
): Promise<ReadResult> {
  const label = formatRef({ ...ref, pointer: undefined });
  switch (ref.kind) {
    case "doc": {
      const document = schema.resolveDocument(ref.name);
      if (!document) {
        throw new CliError("unknown_document", `There is no document '${ref.name}' in the project's schema.`, {
          exitCode: EXIT.usage,
          fix: "Run 'atmyapp content ls' to see the documents.",
        });
      }
      return readStoragePath(api, document.path, { ...options, definition: document.name, ref: label, kind: "document" });
    }
    case "file": {
      const owner = schema.definitionForPath(ref.name);
      return readStoragePath(api, ref.name, { ...options, definition: owner?.name ?? null, ref: label, kind: "file" });
    }
    case "entry":
      schema.collection(ref.name);
      return readEntry(api, ref.name, ref.entryId!, { ...options, ref: label });
    case "public":
      throw new CliError("not_supported_yet", "Public assets can't be read with the CLI yet.", { exitCode: EXIT.usage });
    case "coll":
      throw new CliError("not_an_item", `${label} is a collection. Use 'atmyapp entries ls ${ref.name}'.`, { exitCode: EXIT.usage });
  }
}

// --- Content map (`atmyapp content ls`) ---------------------------------------

interface PlacementsOverview {
  usage?: Array<{ definition: string; summary?: string | null; pages?: Array<{ route: string }> }>;
}

export async function contentMap(api: ApiClient, schema: RemoteSchema): Promise<ContentMap> {
  const [placements, localization] = await Promise.all([
    api.json<PlacementsOverview>("GET", "content-placements").catch(() => null),
    readLocalization(api).catch(() => null),
  ]);
  const usage = new Map((placements?.usage ?? []).map((row) => [row.definition, row]));
  const summaries = schema.summaries().filter((summary) => summary.kind !== "system_config");
  const counts = await mapLimit(summaries, 6, async (summary) => {
    if (summary.kind !== "collection") return undefined;
    const page = await listEntries(api, summary.name, { limit: 1 }).catch(() => null);
    return page?.total;
  });
  return {
    items: summaries.map((summary, index) => {
      const row = usage.get(summary.name);
      const ref =
        summary.kind === "collection" ? `coll:${summary.name}` : summary.kind === "document" ? `doc:${summary.name}` : `file:${summary.path}`;
      return {
        ref,
        name: summary.name,
        kind: summary.kind,
        path: summary.path,
        description: summary.description,
        ...(summary.kind === "collection" ? { entries: counts[index] ?? 0 } : {}),
        localizedFields: summary.localizedFields,
        pages: [...new Set((row?.pages ?? []).map((page) => page.route))],
        summary: row?.summary ?? null,
      };
    }),
    localization,
    pagesKnown: Boolean(placements?.usage?.length),
  };
}

// --- Locale status (`atmyapp locales status`) ----------------------------------

interface LocaleDiscovery {
  defaultLocale: string | null;
  locales: Array<{ locale: string; status: string; missingPathCount?: number; outdatedPathCount?: number }>;
}

function rows(ref: string, discovery: LocaleDiscovery | null, only?: string | null): LocaleStatusRow[] {
  return (discovery?.locales ?? [])
    .filter((row) => !only || row.locale === only)
    .filter((row) => row.locale !== discovery?.defaultLocale)
    .map((row) => ({
      ref,
      locale: row.locale,
      status: row.status,
      ...(row.missingPathCount !== undefined ? { missingPathCount: row.missingPathCount } : {}),
      ...(row.outdatedPathCount !== undefined ? { outdatedPathCount: row.outdatedPathCount } : {}),
    }));
}

export async function storagePathLocales(api: ApiClient, storagePath: string, ref: string, locale?: string | null) {
  const discovery = await api.json<LocaleDiscovery>("GET", `storage/locales/${encodeStoragePath(storagePath)}`, {
    query: { branch: "main" },
    allow: [400, 404],
  });
  return rows(ref, discovery, locale);
}

export async function entryLocales(api: ApiClient, collection: string, entryId: string, locale?: string | null) {
  const discovery = await api.json<LocaleDiscovery>(
    "GET",
    `collections/${encodeURIComponent(collection)}/entries/${encodeURIComponent(entryId)}/locales`,
    { query: { branch: "main" }, allow: [400, 404] },
  );
  return rows(`entry:${collection}/${entryId}`, discovery, locale);
}
