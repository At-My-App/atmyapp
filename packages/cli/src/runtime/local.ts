import { mergeVariantOverlay } from "@atmyapp/structure";
import * as fs from "fs";
import type { ContentView, ReadResult } from "./content";
import { CliError, EXIT } from "./errors";
import { contentFingerprint } from "./fingerprint";
import { formatRef, type ContentRef } from "./refs";
import { RemoteSchema } from "./schema";
import { ContentStore, type StoreManifest, type StoredVariant } from "./store";
import { storedAssetRef, type DeliveredAsset } from "./views";

/** Reads from `.ama/content/published` (`--local`): no network. */
export class LocalContent {
  readonly manifest: StoreManifest;
  readonly schema: RemoteSchema;

  constructor(readonly store: ContentStore = new ContentStore()) {
    const manifest = store.readManifest();
    if (!manifest) {
      throw new CliError("no_local_copy", "There is no local content copy yet.", {
        exitCode: EXIT.usage,
        fix: "Run 'atmyapp content pull'.",
      });
    }
    this.manifest = manifest;
    this.schema = new RemoteSchema(JSON.parse(fs.readFileSync(`${store.spaceDir()}/schema.json`, "utf8")));
  }

  private readJson<T>(file: string): T | null {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  }

  read(ref: ContentRef, view: ContentView, locale: string | null): ReadResult {
    const label = formatRef({ ...ref, pointer: undefined });
    if ((view === "overlay" || view === "effective") && !locale) {
      throw new CliError("locale_required", `The ${view} view needs --locale.`, { exitCode: EXIT.usage });
    }
    if (ref.kind === "entry") {
      const record = this.manifest.collections[ref.name]?.entries[ref.entryId!];
      const wrapper = record ? this.readJson<{ data: Record<string, unknown> }>(this.store.entryPath(ref.name, ref.entryId!)) : null;
      if (!wrapper) throw new CliError("not_found", `${label} is not in the local copy.`, { fix: "Run 'atmyapp content pull'." });
      const variant = locale ? this.readJson<StoredVariant>(this.store.entryVariantPath(ref.name, ref.entryId!, locale)) : null;
      return this.result(label, "entry", undefined, ref.name, locale, view, wrapper.data, variant, "application/json");
    }
    if (ref.kind !== "doc" && ref.kind !== "file") {
      throw new CliError("not_supported_yet", `${label} can't be read from the local copy.`, { exitCode: EXIT.usage });
    }
    const storagePath = ref.kind === "doc" ? this.schema.resolveDocument(ref.name)?.path : ref.name;
    const record = storagePath ? this.manifest.files[storagePath] : undefined;
    if (!storagePath || !record) {
      throw new CliError("not_found", `${label} is not in the local copy.`, { fix: "Run 'atmyapp content pull'." });
    }
    if (!record.downloaded) {
      throw new CliError("not_downloaded", `${label} is media that was not downloaded.`, {
        fix: "Run 'atmyapp content pull --media', or 'atmyapp assets get' for this file.",
      });
    }
    const bytes = fs.readFileSync(this.store.filePath(storagePath));
    let value: unknown = bytes.toString("utf8");
    if (/json/i.test(record.mimeType) || /\.jsonx?$/i.test(storagePath)) {
      try {
        value = JSON.parse(value as string);
      } catch {
        // keep text
      }
    }
    const variant = locale ? this.readJson<StoredVariant>(this.store.fileVariantPath(storagePath, locale)) : null;
    return this.result(label, ref.kind === "doc" ? "document" : "file", storagePath, record.definition, locale, view, value, variant, record.mimeType);
  }

  private result(
    ref: string,
    kind: ReadResult["kind"],
    path: string | undefined,
    definition: string | null,
    locale: string | null,
    view: ContentView,
    stored: unknown,
    variant: StoredVariant | null,
    mimeType: string,
  ): ReadResult {
    if (locale && !variant && view === "overlay") throw new CliError("no_translation", `${ref} has no ${locale} translation in the local copy.`);
    const effective = locale && variant ? applyVariant(stored, variant) : stored;
    const value =
      view === "overlay" ? variant!.data : view === "delivered" ? deliver(effective, this.manifest.assets) : effective;
    return {
      ref,
      kind,
      ...(path ? { path } : {}),
      definition,
      locale,
      view,
      mimeType,
      fingerprint: contentFingerprint(kind === "entry" ? "entry" : "file", effective),
      commitSha: this.manifest.baseCommit,
      value,
      ...(variant ? { variant: { mode: variant.mode, status: variant.status, sourceHashes: variant.sourceHashes } } : {}),
    };
  }

  entries(collection: string): Array<{ id: string; data: Record<string, unknown>; createdAt?: string; updatedAt?: string }> {
    const records = this.manifest.collections[collection]?.entries ?? {};
    return Object.keys(records)
      .map((id) => this.readJson<{ id: string; data: Record<string, unknown>; createdAt?: string; updatedAt?: string }>(this.store.entryPath(collection, id)))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  }
}

export function applyVariant(source: unknown, variant: StoredVariant): unknown {
  return variant.mode === "replace" ? variant.data : mergeVariantOverlay(source, variant.data);
}

/** Replaces stored asset references with what websites receive. */
export function deliver(value: unknown, assets: Record<string, DeliveredAsset>): unknown {
  const ref = storedAssetRef(value);
  if (ref) return assets[ref] ?? value;
  if (Array.isArray(value)) return value.map((item) => deliver(item, assets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deliver(item, assets)]));
  }
  return value;
}
