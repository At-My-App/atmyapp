import { matchesFieldValue } from "./validation";
import type { FieldDefinition, SchemaDocument } from "./types";
import {
  generateUniqueSlug,
  isValidSlug,
  placeEntry,
  type Placement,
} from "./managedContent";

export type CollectionSnapshot = Record<
  string,
  Record<string, Record<string, unknown>>
>;
export interface ContentConstraintIssue {
  code:
    | "invalid-slug"
    | "duplicate-slug"
    | "immutable-slug"
    | "invalid-reference"
    | "duplicate-reference"
    | "invalid-order";
  collection: string;
  entryId: string;
  field: string;
  message: string;
  targetCollection?: string;
  targetEntryId?: string;
}
export class ContentConstraintError extends Error {
  readonly status = 400;
  readonly code = "content-constraint";
  readonly details: { issues: ContentConstraintIssue[] };
  constructor(readonly issues: ContentConstraintIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "ContentConstraintError";
    this.details = { issues };
  }
}

function fieldsFor(
  schema: SchemaDocument,
  collection: string,
): Record<string, FieldDefinition> {
  const definition = schema.definitions[collection];
  if (definition?.kind !== "collection") return {};
  const fields = { ...definition.fields };
  const slug = definition.systemFields?.slug;
  if (slug && (slug === true || slug.enabled !== false) && !fields.slug) {
    fields.slug = {
      kind: "slug",
      source: slug === true ? undefined : slug.source,
    };
  }
  return fields;
}

/** Validate an entire resulting snapshot; callers own transactions and scope isolation. */
export function validateCollectionSnapshot(
  schema: SchemaDocument,
  next: CollectionSnapshot,
  previous?: CollectionSnapshot,
): ContentConstraintIssue[] {
  const issues: ContentConstraintIssue[] = [];
  for (const [collection, entries] of Object.entries(next)) {
    const fields = fieldsFor(schema, collection);
    const slugs = new Map<string, Map<string, string>>();
    const ranks = new Map<string, Set<number>>();
    for (const [entryId, data] of Object.entries(entries)) {
      const visit = (
        field: FieldDefinition,
        value: unknown,
        path: string,
        old: unknown,
      ) => {
        const add = (
          code: ContentConstraintIssue["code"],
          message: string,
          extra: Partial<ContentConstraintIssue> = {},
        ) =>
          issues.push({
            code,
            collection,
            entryId,
            field: path,
            message: `${typeof (data.name ?? data.label ?? data.title) === "string" ? (data.name ?? data.label ?? data.title) : collection + "/" + entryId}: ${message}`,
            ...extra,
          });
        if (field.kind === "union") {
          const branch = field.variants.find((variant) =>
            matchesFieldValue(value, variant),
          );
          if (branch) visit(branch, value, path, old);
        } else if (
          field.kind === "object" &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          for (const [name, child] of Object.entries(field.fields))
            visit(
              child,
              (value as Record<string, unknown>)[name],
              `${path}.${name}`,
              old && typeof old === "object"
                ? (old as Record<string, unknown>)[name]
                : undefined,
            );
        } else if (field.kind === "array" && Array.isArray(value)) {
          if (field.items.kind === "reference")
            visit(
              { ...field.items, multiple: true, optional: field.optional },
              value,
              path,
              old,
            );
          else
            value.forEach((item, index) =>
              visit(
                field.items,
                item,
                `${path}[${index}]`,
                Array.isArray(old) ? old[index] : undefined,
              ),
            );
        } else if (field.kind === "slug") {
          if (old !== undefined && value !== old)
            add(
              "immutable-slug",
              `${path} cannot change after the entry is saved.`,
            );
          if (!isValidSlug(value)) {
            add("invalid-slug", `Enter a valid URL identifier for ${path}.`);
            return;
          }
          const seen = slugs.get(path) || new Map<string, string>();
          if (seen.has(value))
            add(
              "duplicate-slug",
              `The URL identifier "${value}" is already used by another entry.`,
              { targetEntryId: seen.get(value) },
            );
          seen.set(value, entryId);
          slugs.set(path, seen);
        } else if (
          field.kind === "reference" &&
          schema.definitions[field.target]?.kind === "collection"
        ) {
          if (
            (value === undefined || value === null || value === "") &&
            (field.optional || field.required === false)
          )
            return;
          const values = field.multiple ? value : [value];
          if (
            !Array.isArray(values) ||
            (!values.length && !field.optional && field.required !== false)
          ) {
            add("invalid-reference", `Choose an entry for ${path}.`);
            return;
          }
          const seen = new Set<string>();
          for (const key of values) {
            if (typeof key !== "string" || !key) {
              add("invalid-reference", `Choose a valid entry for ${path}.`);
              continue;
            }
            if (seen.has(key))
              add(
                "duplicate-reference",
                `${path} contains the same entry more than once.`,
              );
            seen.add(key);
            const targets = next[field.target] || {};
            const exists =
              field.by === "slug"
                ? Object.values(targets).some((target) => target.slug === key)
                : Object.prototype.hasOwnProperty.call(targets, key);
            if (!exists)
              add(
                "invalid-reference",
                `${path} references "${key}" in ${field.target}, which is missing from these changes. Include its creation or remove the reference.`,
                {
                  targetCollection: field.target,
                  targetEntryId: field.by === "slug" ? undefined : key,
                },
              );
          }
        } else if (field.kind === "order") {
          if (typeof value !== "number" || !Number.isSafeInteger(value)) {
            add("invalid-order", `${path} needs a managed order rank.`);
            return;
          }
          const group = JSON.stringify([
            path,
            field.groupBy ? (data[field.groupBy] ?? null) : null,
          ]);
          const seen = ranks.get(group) || new Set<number>();
          if (seen.has(value))
            add(
              "invalid-order",
              `${path} has a duplicate position in this group.`,
            );
          seen.add(value);
          ranks.set(group, seen);
        }
      };
      for (const [name, field] of Object.entries(fields))
        visit(
          field,
          data[name],
          name,
          previous?.[collection]?.[entryId]?.[name],
        );
    }
  }
  return issues;
}

export interface CollectionMutation {
  collection: string;
  entryId: string;
  /** Complete replacement; omitted data deletes the entry. */
  data?: Record<string, unknown>;
  placements?: Record<string, Placement>;
}

/** Pure preparation of a save. Inputs are never mutated, including on failure. */
export function prepareCollectionMutation(
  schema: SchemaDocument,
  previous: CollectionSnapshot,
  mutation: CollectionMutation,
  options: { deferReferences?: boolean } = {},
): CollectionSnapshot {
  const next = structuredClone(previous);
  const { collection, entryId, placements = {} } = mutation;
  const failure = (field: string, code: ContentConstraintIssue['code'], message: string, targetEntryId?: string): never => {
    throw new ContentConstraintError([{ code, collection, entryId, field, message, targetEntryId }]);
  };
  const attempt = <T>(field: string, code: ContentConstraintIssue['code'], action: () => T, targetEntryId?: string): T => {
    try { return action(); } catch (error) {
      if (error instanceof ContentConstraintError) throw error;
      return failure(field, code, error instanceof Error ? error.message : String(error), targetEntryId);
    }
  };
  const fields = fieldsFor(schema, collection);
  const entries = (next[collection] ||= {});
  const old = previous[collection]?.[entryId];
  if (mutation.data === undefined) {
    if (Object.keys(placements).length)
      failure("placements", "invalid-order", "A deletion cannot include placement.");
    delete entries[entryId];
  } else {
    const data = structuredClone(mutation.data);
    entries[entryId] = data;
    for (const name of Object.keys(placements))
      if (fields[name]?.kind !== "order")
        failure(name, "invalid-order", `${name} is not an order field.`);
    for (const [name, field] of Object.entries(fields)) {
      if (
        field.kind === "reference" &&
        (field.optional || field.required === false) &&
        data[name] === ""
      )
        data[name] = null;
      if (field.kind === "slug" && !old && data[name] === undefined) {
        const source = field.source ? data[field.source] : undefined;
        data[name] = attempt(name, "invalid-slug", () => generateUniqueSlug(
          typeof source === "string" ? source : "",
          new Set(
            Object.values(entries).flatMap((entry) =>
              typeof entry[name] === "string" ? [entry[name] as string] : [],
            ),
          ),
        ));
      }
      if (field.kind !== "order") continue;
      if (data[name] !== undefined && (!old || data[name] !== old[name]))
        failure(name, "invalid-order", `${name} is managed. Use placement instead of a rank number.`);
      if (old) data[name] = old[name];
      const groupChanged = Boolean(
        old &&
        field.groupBy &&
        (old[field.groupBy] ?? null) !== (data[field.groupBy] ?? null),
      );
      const placement =
        placements[name] ||
        (!old || groupChanged ? { position: "last" as const } : undefined);
      if (!placement) continue;
      const group = Object.entries(entries).filter(
        ([, entry]) =>
          !field.groupBy ||
          (entry[field.groupBy] ?? null) === (data[field.groupBy] ?? null),
      );
      const changed = attempt(name, "invalid-order", () => placeEntry(
        group.map(([id, entry]) => ({
          id,
          rank:
            typeof entry[name] === "number"
              ? (entry[name] as number)
              : undefined,
        })),
        entryId,
        placement,
      ), "entryId" in placement ? placement.entryId : undefined);
      for (const [id, rank] of Object.entries(changed))
        entries[id][name] = rank;
    }
  }
  const issues = validateCollectionSnapshot(schema, next, previous).filter(
    issue => !options.deferReferences || (issue.code !== "invalid-reference" && issue.code !== "duplicate-reference")
  );
  if (issues.length) throw new ContentConstraintError(issues);
  return next;
}
