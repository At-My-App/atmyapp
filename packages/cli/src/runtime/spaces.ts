import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { CliError, EXIT } from "./errors";
import { ContentStore } from "./store";

const slug = /^[a-z0-9-]{1,40}$/;
const stamp = z.string();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const coordinate = z.object({
  kind: z.enum(["doc", "file", "entry", "public"]),
  name: z.string().min(1),
  entryId: z.string().min(1).optional(),
  locale: z.string().min(1).optional(),
});
const base = z.object({ sha256: digest.nullable(), fingerprint: digest.nullable(), commit: z.string().nullable() });
const item = z.object({
  base,
  staged: z.object({ itemRevision: z.number().int().nonnegative(), sha256: digest, at: stamp }).optional(),
  locale: z.string().optional(),
  ref: coordinate.optional(),
  newFile: z.string().optional(),
  replaceData: z.boolean().optional(),
  rebase: z.boolean().optional(),
  attachments: z.record(z.string(), z.int()).optional(),
  merge: z.object({
    local: digest.nullable(),
    head: digest.nullable(),
    choices: z.array(z.tuple([z.string(), z.enum(["ours", "theirs"])])),
  }).optional(),
  placement: z
    .object({
      field: z.string(),
      position: z.enum(["first", "last", "before", "after"]),
      entryId: z.string().optional(),
    })
    .optional(),
});
export const spaceFileSchema = z.object({
  version: z.literal(1),
  name: z.string().regex(slug),
  createdAt: stamp,
  session: z.object({ sessionId: z.string().regex(/^ns_[\da-f-]{36}$/), createdAt: stamp }).nullable(),
  items: z.record(z.string(), item),
  deletions: z.array(z.string()),
  lastPushOperationId: z.string().optional(),
});
export type SpaceFile = z.infer<typeof spaceFileSchema>;
export type SpaceItem = z.infer<typeof item>;
export type SpaceRef = z.infer<typeof coordinate>;
export type SpaceBase = z.infer<typeof base>;

export function spaceName(name: string, allowDefault = true): string {
  if (!slug.test(name) || name === "published" || (!allowDefault && name === "default")) {
    throw new CliError(
      "invalid_space",
      "Space names use 1–40 lowercase letters, numbers or hyphens. 'published' and 'default' are reserved.",
      {
        exitCode: EXIT.usage,
      },
    );
  }
  return name;
}

export function currentSpace(store: ContentStore, requested?: string): string {
  if (requested?.trim()) return spaceName(requested.trim());
  const file = path.join(store.root, ".current");
  const name = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  return name ? spaceName(name) : "default";
}

const metadataPath = (store: ContentStore, name: string) => path.join(store.spaceDir(spaceName(name)), "space.json");
const defaultSpace = (name: string): SpaceFile => ({
  version: 1,
  name,
  createdAt: new Date().toISOString(),
  session: null,
  items: {},
  deletions: [],
});

export function readSpace(store: ContentStore, name: string): SpaceFile {
  const file = metadataPath(store, name);
  if (!fs.existsSync(file)) {
    if (name === "default") return defaultSpace(name);
    throw new CliError("space_not_found", `Space '${name}' does not exist.`, { exitCode: EXIT.usage });
  }
  try {
    const saved = spaceFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (saved.name !== name) throw new Error("Name differs");
    return saved;
  } catch {
    throw new CliError("space_corrupt", `${file} is not a valid space file.`);
  }
}

export function writeSpace(store: ContentStore, space: SpaceFile): void {
  store.writeJson(metadataPath(store, space.name), space, false);
}

export async function withSpace<T>(
  store: ContentStore,
  name: string,
  action: (space: SpaceFile) => T | Promise<T>,
): Promise<T> {
  readSpace(store, name);
  const release = store.lockSpace(name);
  try {
    return await action(readSpace(store, name));
  } finally {
    release();
  }
}

export function createSpace(
  store: ContentStore,
  name: string,
  options: { from?: string; dryRun?: boolean } = {},
): SpaceFile {
  spaceName(name, false);
  const target = store.spaceDir(name);
  if (fs.existsSync(target))
    throw new CliError("space_exists", `Space '${name}' already exists.`, { exitCode: EXIT.conflict });
  const space = defaultSpace(name);
  if (options.from && options.from !== "published") {
    const source = readSpace(store, spaceName(options.from));
    space.items = Object.fromEntries(
      Object.entries(source.items).map(([key, entry]) => {
        const { staged: _, ...baseItem } = entry;
        return [key, baseItem];
      }),
    );
    space.deletions = [...source.deletions];
  }
  if (options.dryRun) return space;
  fs.mkdirSync(store.root, { recursive: true });
  fs.mkdirSync(target);
  const release = store.lockSpace(name);
  try {
    if (options.from && options.from !== "published") {
      for (const directory of ["f", "public", "locales", "collections", ".assets"]) {
        const source = path.join(store.spaceDir(options.from), directory);
        if (fs.existsSync(source)) {
          fs.cpSync(source, path.join(target, directory), {
            recursive: true,
            filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
          });
        }
      }
    }
    writeSpace(store, space);
  } catch (error) {
    store.remove(target);
    throw error;
  } finally {
    release();
  }
  return space;
}

export function useSpace(store: ContentStore, name: string, dryRun = false): SpaceFile {
  const space = readSpace(store, name);
  if (!dryRun) {
    if (!fs.existsSync(metadataPath(store, name))) writeSpace(store, space);
    store.writeBytes(path.join(store.root, ".current"), Buffer.from(name + "\n"));
  }
  return space;
}

export function spaceNames(store: ContentStore): string[] {
  if (!fs.existsSync(store.root)) return [];
  return fs
    .readdirSync(store.root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        slug.test(entry.name) &&
        entry.name !== "published" &&
        (entry.name === "default" || fs.existsSync(metadataPath(store, entry.name))),
    )
    .map((entry) => entry.name)
    .sort();
}

/** Called only after the caller checks the pending changes and remote session. */
export function removeSpaceFiles(store: ContentStore, name: string) {
  const current = currentSpace(store);
  store.remove(store.spaceDir(spaceName(name)));
  if (current === name) store.remove(path.join(store.root, ".current"));
}

export function collectUnusedObjects(store: ContentStore, dryRun = false) {
  const release = dryRun ? undefined : store.lockPublished();
  try {
    const keep = new Set<string>();
    const manifest = store.readManifest();
    for (const record of [
      ...Object.values(manifest?.files ?? {}),
      ...Object.values(manifest?.publicFiles ?? {}),
      ...Object.values(manifest?.collections ?? {}).flatMap((collection) => Object.values(collection.entries)),
    ]) {
      keep.add(record.sha256);
      for (const variant of Object.values(record.locales ?? {})) keep.add(variant.sha256);
    }
    for (const name of spaceNames(store)) {
      if (fs.existsSync(path.join(store.spaceDir(name), ".lock")) || fs.existsSync(path.join(store.spaceDir(name), ".push.json")))
        throw new CliError("store_locked", "Finish editing or pushing the space before collecting unused objects.");
      for (const entry of Object.values(readSpace(store, name).items)) {
        if (entry.base.sha256) keep.add(entry.base.sha256);
      }
    }
    const directory = path.join(store.root, ".objects");
    let objects = 0;
    let bytes = 0;
    for (const prefix of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
      if (!prefix.isDirectory() || !/^[a-f\d]{2}$/.test(prefix.name)) continue;
      const bucket = path.join(directory, prefix.name);
      for (const file of fs.readdirSync(bucket, { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-f\d]{64}$/.test(file.name) || keep.has(file.name)) continue;
        const target = path.join(bucket, file.name);
        objects++;
        bytes += fs.statSync(target).size;
        if (!dryRun) fs.unlinkSync(target);
      }
    }
    return { objects, bytes, dryRun };
  } finally {
    release?.();
  }
}
