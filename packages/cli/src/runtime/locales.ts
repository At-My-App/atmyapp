import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildLocalizedDocumentOverlay,
  collectVariantSourceHashes,
  mergeVariantOverlay,
  validate,
  validateLocalizedItemIdentities,
  variantSourceValue,
  type Definition,
  type FieldDefinition,
} from "@atmyapp/structure";
import { z } from "zod";
import { CliError, EXIT } from "./errors";
import { sha256Hex } from "./fingerprint";
import { applyJsonPatch } from "./jsonPatch";
import { escapePointerToken, formatRef, parseRef } from "./refs";
import { readSpace, withSpace, writeSpace, type SpaceFile, type SpaceRef } from "./spaces";
import type { StoredVariant } from "./store";
import { itemKey, record, recordWorkItem, type WorkingCopy, type WorkItem } from "./workingCopy";

const statuses = ["current", "incomplete", "outdated", "missing"] as const;
export type SegmentStatus = (typeof statuses)[number];

const editInputSchema = z.object({
  ref: z.string(),
  pointer: z.string(),
  sourceHash: z.string(),
  translation: z.string().nullable().optional(),
});
export const segmentSchema = editInputSchema.extend({
  source: z.string(),
  current: z.string().nullable(),
  status: z.enum(statuses),
  field: z.object({
    kind: z.string(),
    description: z.string().optional(),
    max: z.number().optional(),
    maxLength: z.number().optional(),
    preferredLength: z.number().optional(),
  }),
});

type Segment = z.infer<typeof segmentSchema>;
type Coordinate = { segment: Segment; tokens: string[]; hashPath: string; field: FieldDefinition };

function canonicalSource(work: WorkingCopy, ref: SpaceRef): Definition | undefined {
  return ref.kind === "entry" ? work.schema.collection(ref.name) : work.schema.definitionForPath(ref.name)?.definition;
}

export function translationSchema(definition: Definition | undefined): FieldDefinition | undefined {
  return definition && "fields" in definition ? { kind: "object", fields: definition.fields } : undefined;
}

function sourceAt(work: WorkingCopy, ref: SpaceRef, items: Map<string, WorkItem>) {
  const source = { ...ref, locale: undefined };
  const candidate = items.get(itemKey(source));
  return candidate?.deleted ? undefined : candidate?.sha256 ? work.value(candidate) : work.publishedValue(source);
}

function variantAt(work: WorkingCopy, ref: SpaceRef, space: SpaceFile | undefined) {
  if (space?.deletions.includes(itemKey(ref))) return undefined;
  return (space && work.variant(ref)) ?? work.variant(ref, work.store.published);
}

function effective(source: unknown, variant: StoredVariant | undefined, schema?: FieldDefinition): unknown {
  if (!variant) return source;
  return variant.mode === "replace" ? variant.data : mergeVariantOverlay(source, variant.data, schema);
}

function sourceHashPath(ref: SpaceRef, schema?: FieldDefinition) {
  return ref.kind === "entry" ? "" : schema ? "content" : "raw";
}

const equal = (left: unknown, right: unknown) => variantSourceValue(left) === variantSourceValue(right);

const sourceDigest = (source: unknown) => sha256Hex(variantSourceValue(source));
const selector = (key: string, identity: string | number) => key + "=" + encodeURIComponent(String(identity));

function codePointer(tokens: string[]) {
  return tokens.length ? "/" + tokens.map(escapePointerToken).join("/") : "";
}

function requireLocale(work: WorkingCopy, value: string): string {
  if (!work.manifest.localization || !work.schema.localizationEnabled)
    throw new CliError("no_localization", "This project has no configured languages.", { exitCode: EXIT.usage });
  const locale = work.describe("file:translation.txt@" + value).locale;
  if (!locale)
    throw new CliError("invalid_locale", "Choose a non-default language for this translation.", {
      exitCode: EXIT.usage,
    });
  return locale;
}

function coordinates(
  ref: SpaceRef,
  source: unknown,
  variant: StoredVariant | undefined,
  definition: Definition | undefined,
): Coordinate[] {
  const schema = translationSchema(definition);
  const results: Coordinate[] = [];
  const translated = effective(source, variant, schema);
  function walk(
    field: FieldDefinition,
    value: unknown,
    display: unknown,
    pointer: string[],
    tokens: string[],
    hashPath: string,
    hashSource = value,
  ) {
    if (typeof value === "string" && field.localize && (field.kind === "scalar" || field.kind === "mdx")) {
      const previous = variant?.sourceHashes[hashPath];
      const current = typeof display === "string" && (previous !== undefined || display !== value) ? display : null;
      const status: SegmentStatus =
        current === null
          ? variant
            ? "incomplete"
            : "missing"
          : previous !== undefined && previous !== variantSourceValue(hashSource)
            ? "outdated"
            : "current";
      results.push({
        tokens,
        hashPath,
        field,
        segment: {
          ref: formatRef(ref),
          pointer: codePointer(pointer),
          source: value,
          current,
          status,
          sourceHash: sourceDigest(value),
          field: {
            kind: field.kind,
            description: field.description,
            ...(field.kind === "scalar"
              ? { max: field.max ?? field.maximum, maxLength: field.maxLength, preferredLength: field.preferredLength }
              : {}),
          },
        },
      });
    } else if (field.kind === "object" && record(value)) {
      for (const [name, child] of Object.entries(field.fields))
        walk(
          child,
          value[name],
          record(display) ? display[name] : undefined,
          [...pointer, name],
          [...tokens, name],
          hashPath ? hashPath + "." + name : name,
        );
    } else if (field.kind === "array" && Array.isArray(value)) {
      const identity = field.items.kind === "object" ? (field.identityField ?? "_key") : undefined;
      const seen = new Set<string>();
      value.forEach((item, index) => {
        let segment = String(index);
        let childHash = hashPath;
        if (identity) {
          const id = record(item) ? item[identity] : undefined;
          if ((typeof id !== "string" && typeof id !== "number") || seen.has(String(id)))
            throw new CliError(
              "invalid_translation_identity",
              `Missing or duplicate item identity in ${formatRef(ref)}#${codePointer(pointer)}.`,
              {
                exitCode: EXIT.validation,
              },
            );
          seen.add(String(id));
          segment = selector(identity, id);
          childHash += "[" + segment + "]";
        }
        walk(
          field.items,
          item,
          Array.isArray(display) ? display[index] : undefined,
          [...pointer, segment],
          [...tokens, String(index)],
          childHash,
          identity ? item : value,
        );
      });
    }
  }
  if (schema) walk(schema, source, translated, [], [], sourceHashPath(ref, schema));
  else if (definition?.kind === "file" && definition.localize) {
    walk(
      { kind: "scalar", scalar: "string", localize: true, description: definition.description },
      source,
      translated,
      [],
      [],
      sourceHashPath(ref),
    );
  }
  return results;
}

function selectedSources(work: WorkingCopy, all: WorkItem[], refs: string[]) {
  const collections = new Set<string>();
  const selected = new Map<string, SpaceRef>();
  for (const input of refs) {
    const parsed = parseRef(input);
    if (parsed.kind === "coll") {
      work.schema.collection(parsed.name);
      collections.add(parsed.name);
    } else {
      const ref = work.describe(input);
      if (ref.kind === "public")
        throw new CliError("not_translatable", "Public assets cannot be translated.", { exitCode: EXIT.usage });
      selected.set(itemKey({ ...ref, locale: undefined }), { ...ref, locale: undefined });
    }
  }
  for (const item of all)
    if (!item.ref.locale && (!refs.length || (item.ref.kind === "entry" && collections.has(item.ref.name))))
      selected.set(item.key, item.ref);
  return [...selected.values()];
}

export function parseStatuses(input?: string): SegmentStatus[] {
  const parsed =
    input
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  if (parsed.some((status) => !statuses.includes(status as SegmentStatus)))
    throw new CliError("invalid_status", "Use current, incomplete, outdated or missing.", { exitCode: EXIT.usage });
  return parsed as SegmentStatus[];
}

export function exportSegments(
  work: WorkingCopy,
  options: { locale: string; statuses?: SegmentStatus[]; refs?: string[]; space?: boolean },
) {
  const locale = requireLocale(work, options.locale);
  const space = options.space ? readSpace(work.store, work.name) : undefined;
  const all = work.itemStates(
    space ?? { version: 1, name: work.name, createdAt: "", session: null, items: {}, deletions: [] },
    true,
  );
  const items = new Map(options.space ? all.map((item) => [item.key, item]) : []);
  const segments = selectedSources(work, all, options.refs ?? []).flatMap((ref) => {
    const source = sourceAt(work, ref, items);
    const target = { ...ref, locale };
    return coordinates(target, source, variantAt(work, target, space), canonicalSource(work, ref)).map(
      (record) => record.segment,
    );
  });
  return {
    locale,
    segments: segments.filter((segment) => !options.statuses?.length || options.statuses.includes(segment.status)),
  };
}

function buildVariant(
  work: WorkingCopy,
  ref: SpaceRef,
  definition: Definition | undefined,
  source: unknown,
  value: unknown,
  previous: StoredVariant | undefined,
  acknowledged?: Set<string>,
): StoredVariant {
  const schema = translationSchema(definition);
  if (!definition || (!schema && (definition.kind !== "file" || !definition.localize)))
    throw new CliError("not_translatable", `${formatRef(ref)} cannot be translated.`, { exitCode: EXIT.validation });
  let data: unknown;
  try {
    data = schema?.kind === "object" ? buildLocalizedDocumentOverlay(schema.fields, source, value) : value;
    if (schema && !equal(mergeVariantOverlay(source, data, schema), value))
      throw new Error("The source fields or array identities changed.");
  } catch (error) {
    throw new CliError(
      "not_localizable",
      error instanceof Error ? error.message : "Only translated fields may change.",
      { exitCode: EXIT.validation },
    );
  }
  const issues = validate(value, definition, "draft", work.schema.compiled.configs).issues.filter(
    (issue) => issue.severity === "hard",
  );
  const identityIssues = schema?.kind === "object" ? validateLocalizedItemIdentities(data, definition, source) : [];
  if (issues.length || identityIssues.length)
    throw new CliError("validation_failed", "Fix the translation validation issues.", {
      exitCode: EXIT.validation,
      details: { issues: [...issues, ...identityIssues] },
    });
  const hashes = collectVariantSourceHashes(source, data, sourceHashPath(ref, schema), {}, schema);
  for (const key of Object.keys(hashes)) {
    if (acknowledged && !acknowledged.has(key) && previous?.sourceHashes[key] !== undefined)
      hashes[key] = previous.sourceHashes[key];
  }
  return {
    mode: schema ? "overlay" : "replace",
    status: Object.keys(hashes).length ? "current" : "incomplete",
    data,
    sourceHashes: hashes,
  };
}

function saveVariant(work: WorkingCopy, space: SpaceFile, ref: SpaceRef, variant: StoredVariant) {
  recordWorkItem(space, work, ref);
  space.deletions = space.deletions.filter((key) => key !== itemKey(ref));
  work.store.writeJson(work.filename(ref), variant, false);
}

export async function importSegments(
  work: WorkingCopy,
  input: unknown,
  options: { locale?: string; dryRun?: boolean } = {},
) {
  const data = record(input) && input.ok === true ? input.data : input;
  const inputFile = z
    .union([z.array(editInputSchema), z.object({ locale: z.string(), segments: z.array(editInputSchema) })])
    .safeParse(data);
  if (!inputFile.success)
    throw new CliError("invalid_segments", "Use a segment file produced by 'locales export'.", {
      exitCode: EXIT.validation,
    });
  const rows = Array.isArray(inputFile.data) ? inputFile.data : inputFile.data.segments;
  const locale = requireLocale(
    work,
    options.locale ??
      (Array.isArray(inputFile.data)
        ? (parseRef(rows[0]?.ref ?? "file:translation.txt").locale ?? "")
        : inputFile.data.locale),
  );
  const run = (space: SpaceFile) => {
    const outdated: Array<{ ref: string; pointer: string }> = [];
    const items = new Map(work.itemStates(space).map((item) => [item.key, item]));
    const updates = new Map<
      string,
      {
        ref: SpaceRef;
        value: unknown;
        source: unknown;
        variant?: StoredVariant;
        definition?: Definition;
        coordinates: Map<string, Coordinate>;
        acknowledged: Set<string>;
      }
    >();
    let saved = 0;
    for (const row of rows) {
      if (row.translation === undefined) continue;
      const original = work.describe(row.ref);
      if (original.locale && original.locale !== locale)
        throw new CliError("invalid_segments", "The segment language differs from the import language.", {
          exitCode: EXIT.validation,
        });
      const ref = { ...original, locale };
      const key = itemKey(ref);
      let group = updates.get(key);
      if (!group) {
        const variant = variantAt(work, ref, space);
        const source = sourceAt(work, ref, items);
        const definition = canonicalSource(work, ref);
        group = {
          ref,
          value: effective(source, variant, translationSchema(definition)),
          source,
          definition,
          variant,
          coordinates: new Map(
            coordinates(ref, source, variant, definition).map((entry) => [entry.segment.pointer, entry]),
          ),
          acknowledged: new Set(),
        };
        updates.set(key, group);
      }
      const coordinate = group.coordinates.get(row.pointer);
      if (!coordinate || coordinate.segment.sourceHash !== row.sourceHash) {
        outdated.push({ ref: row.ref, pointer: row.pointer });
        continue;
      }
      group.value = applyJsonPatch(group.value, [
        { op: "replace", path: codePointer(coordinate.tokens), value: row.translation },
      ]);
      group.acknowledged.add(coordinate.hashPath);
      saved++;
    }
    const variants = [...updates.values()]
      .filter((entry) => entry.acknowledged.size)
      .map((entry) => ({
        ref: entry.ref,
        variant: buildVariant(
          work,
          entry.ref,
          entry.definition,
          entry.source,
          entry.value,
          entry.variant,
          entry.acknowledged,
        ),
      }));
    if (!options.dryRun && variants.length) {
      for (const { ref, variant } of variants) saveVariant(work, space, ref, variant);
      writeSpace(work.store, space);
    }
    return { locale, count: saved, outdated, dryRun: !!options.dryRun };
  };
  return options.dryRun ? run(readSpace(work.store, work.name)) : withSpace(work.store, work.name, run);
}

export function translationReference(work: WorkingCopy, input: string, locale?: string) {
  const parsed = parseRef(input);
  if (locale && parsed.locale && requireLocale(work, locale) !== requireLocale(work, parsed.locale))
    throw new CliError("invalid_locale", "The reference locale differs from --locale.", { exitCode: EXIT.usage });
  const ref = work.describe(input);
  return { ...ref, locale: requireLocale(work, locale ?? parsed.locale ?? "") };
}

function translationEditFile(work: WorkingCopy, ref: SpaceRef) {
  return path.join(work.store.spaceDir(work.name), ".edit", sha256Hex(itemKey(ref)) + ".json");
}

export async function editTranslation(
  work: WorkingCopy,
  input: string,
  options: {
    locale?: string;
    dryRun?: boolean;
    save?: boolean;
    apply?: (value: unknown) => unknown;
  } = {},
) {
  let locale = options.locale;
  if (options.save && !locale && !parseRef(input).locale) {
    const source = work.describe(input);
    const settings = work.manifest.localization;
    const editors = (settings?.supportedLocales ?? []).filter(
      (language) =>
        language !== settings?.defaultLocale &&
        fs.existsSync(translationEditFile(work, { ...source, locale: language })),
    );
    if (editors.length !== 1) {
      throw new CliError(
        editors.length ? "invalid_locale" : "edit_not_found",
        editors.length
          ? "Choose the translation to save with --locale."
          : "Open a translation with 'content edit --locale' first.",
        { exitCode: EXIT.usage },
      );
    }
    locale = editors[0];
  }
  const ref = translationReference(work, input, locale);
  const file = translationEditFile(work, ref);
  const run = (space: SpaceFile) => {
    const source = sourceAt(work, ref, new Map(work.itemStates(space).map((item) => [item.key, item])));
    if (source === undefined)
      throw new CliError("not_found", "Save the source content before translating.", { exitCode: EXIT.validation });
    const definition = canonicalSource(work, ref);
    const previous = variantAt(work, ref, space);
    const current = effective(source, previous, translationSchema(definition));
    const stamp = file + ".base.json";
    const result = { ref: formatRef(ref), file, dryRun: !!options.dryRun, changed: false };
    if (options.save || options.apply) {
      let value: unknown;
      if (options.apply) value = options.apply(current);
      else {
        if (!fs.existsSync(file))
          throw new CliError("edit_not_found", "Open the merged translation with 'content edit --locale' first.", {
            exitCode: EXIT.usage,
          });
        let baseline: { sourceHash?: string; variantHash?: string };
        try {
          baseline = JSON.parse(fs.readFileSync(stamp, "utf8"));
          value = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          throw new CliError("invalid_content", "The translation edit or its baseline is invalid.", {
            exitCode: EXIT.validation,
          });
        }
        if (baseline.sourceHash !== sourceDigest(source) || baseline.variantHash !== sourceDigest(previous))
          throw new CliError(
            "translation_outdated",
            "The source or saved translation changed while you were editing. Your edit file is still available.",
            { exitCode: EXIT.conflict },
          );
      }
      const acknowledged = new Set(
        coordinates(ref, source, previous, definition)
          .filter((entry) => {
            const get = (input: unknown) =>
              entry.tokens.reduce<unknown>(
                (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
                input,
              );
            return !equal(get(current), get(value));
          })
          .map((entry) => entry.hashPath),
      );
      const variant = buildVariant(work, ref, definition, source, value, previous, acknowledged);
      if (!options.dryRun) {
        saveVariant(work, space, ref, variant);
        writeSpace(work.store, space);
        if (options.save) {
          work.store.remove(file);
          work.store.remove(stamp);
        }
      }
      return { ...result, file: work.filename(ref), changed: true };
    }
    if (fs.existsSync(file)) return result;
    buildVariant(work, ref, definition, source, current, previous);
    if (!options.dryRun) {
      work.store.writeJson(stamp, { sourceHash: sourceDigest(source), variantHash: sourceDigest(previous) }, false);
      work.store.writeJson(file, current, false);
    }
    return { ...result, changed: true };
  };
  return options.dryRun ? run(readSpace(work.store, work.name)) : withSpace(work.store, work.name, run);
}

export function draftTranslationSource(work: WorkingCopy, ref: SpaceRef) {
  return sourceAt(work, ref, new Map(work.itemStates().map((item) => [item.key, item])));
}

export function outdatedTranslations(work: WorkingCopy) {
  if (!work.manifest.localization) return [];
  const space = readSpace(work.store, work.name);
  const items = work.itemStates(space);
  const result: Array<{ ref: string; locales: string[] }> = [];
  for (const item of items) {
    if (item.ref.locale || item.ref.kind === "public" || ["published", "remote-changed"].includes(item.state)) continue;
    const source = work.publishedValue(item.ref);
    const current = item.deleted || !item.sha256 ? undefined : work.value(item);
    if (source === undefined || Buffer.isBuffer(source) || Buffer.isBuffer(current)) continue;
    const schema = translationSchema(canonicalSource(work, item.ref));
    const locales = (work.manifest.localization?.supportedLocales ?? []).filter((locale) => {
      if (locale === work.manifest.localization?.defaultLocale) return false;
      const variant = variantAt(work, { ...item.ref, locale }, space);
      if (!variant) return false;
      const hashPath = sourceHashPath(item.ref, schema);
      const before = collectVariantSourceHashes(source, variant.data, hashPath, {}, schema);
      const after = collectVariantSourceHashes(current, variant.data, hashPath, {}, schema);
      return Object.entries(before).some(
        ([key, hash]) => hash !== after[key] && variant.sourceHashes[key] !== after[key],
      );
    });
    if (locales.length) result.push({ ref: formatRef(item.ref), locales });
  }
  return result;
}
