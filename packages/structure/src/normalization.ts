import { isObjectArrayItem } from "./localizedIdentities";
import type {
  Definition,
  FieldDefinition,
  MdxConfigDefinition,
  ValidationIssue,
} from "./types";
import {
  assertNever,
  canonicalValue,
  contentIssue,
  validateFieldValue,
} from "./valueValidation";

export interface NormalizeContentOptions {
  /** Immutable content version, never the incoming edited value. Undefined means creation. */
  base?: unknown;
  /** Stable document/entry identity, shared by every draft of this resource. */
  resourceIdentity: string;
  /** Caller owns randomness; staging persists the returned value before acknowledging a save. */
  createKey: () => string;
  configs?: Record<string, MdxConfigDefinition>;
}
export interface NormalizationResult {
  value: unknown;
  issues: ValidationIssue[];
  changed: boolean;
}
export function createItemKey(): string {
  return `n_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}
/** 128-bit deterministic namespace; a collision is rejected, never silently reassigned. */
export function legacyItemKey(context: string): string {
  const input = new TextEncoder().encode(context);
  const parts = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map((seed) => {
    let hash = seed;
    for (const byte of input) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash.toString(16).padStart(8, "0");
  });
  return `b_${parts.join("")}`;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const withoutKey = (value: unknown) => {
  const item = record(value);
  if (!item) return value;
  const { _key, ...rest } = item;
  return rest;
};

/** Pure: never mutates a base or a draft; callers must discard the result on hard issues. */
export function normalizeContent(
  value: unknown,
  definition: Definition,
  options: NormalizeContentOptions,
): NormalizationResult {
  const issues: ValidationIssue[] = [];
  const newKeys = new Map<string, string>();
  const visit = (
    input: unknown,
    field: FieldDefinition,
    base: unknown,
    path: string,
    creating: boolean,
  ): unknown => {
    let next = input;
    if (next === undefined && creating && field.default !== undefined)
      next = structuredClone(field.default);
    if (next === undefined) return undefined;
    switch (field.kind) {
      case "object": {
        const object = record(next);
        if (!object) return next;
        const old = record(base);
        const result = { ...object };
        for (const [name, child] of Object.entries(field.fields)) {
          const childValue = visit(
            object[name],
            child,
            old?.[name],
            `${path}.${name}`,
            creating,
          );
          if (childValue !== undefined) result[name] = childValue;
        }
        return result;
      }
      case "array": {
        if (!Array.isArray(next)) return next;
        const previous = Array.isArray(base) ? base : [];
        if (!isObjectArrayItem(field.items))
          return next.map((item, index) =>
            visit(
              item,
              field.items,
              previous[index],
              `${path}.${index}`,
              creating,
            ),
          );
        const identityField = field.identityField || "_key";
        const baseItems = previous.map((item, index) => {
          const object = record(item);
          const identity =
            object?.[identityField] ??
            (!field.identityField
              ? legacyItemKey(
                  canonicalValue([
                    options.resourceIdentity,
                    path,
                    previous,
                    index,
                  ]),
                )
              : undefined);
          return {
            value: item,
            identity,
            signature: canonicalValue(withoutKey(item)),
          };
        });
        const assigned = new Set<unknown>();
        const identicalBase = canonicalValue(next) === canonicalValue(previous);
        // Explicit identities claim their base items before missing identities are recovered.
        for (const item of next) {
          const key = record(item)?.[identityField];
          if (key !== undefined) assigned.add(key);
        }
        const result = next.map((item, index) => {
          const object = record(item);
          if (!object) return item;
          let identity = object[identityField];
          let matched = baseItems.find(
            (baseItem) =>
              baseItem.identity === identity && identity !== undefined,
          );
          if (
            !field.identityField &&
            typeof identity === "string" &&
            identity.startsWith("b_") &&
            !matched &&
            previous.length > 0
          ) {
            issues.push(
              contentIssue(
                "invalid-identity",
                `${path}.${index}._key`,
                "This item identity belongs to an older content base. Read the published and saved versions, preserve their established identities, and repair the edit. The saved draft is unchanged.",
              ),
            );
            return item;
          }
          if (identity === undefined && !field.identityField) {
            const candidates = baseItems.filter(
              (baseItem) =>
                !assigned.has(baseItem.identity) &&
                baseItem.signature === canonicalValue(withoutKey(item)),
            );
            matched = identicalBase
              ? baseItems[index]
              : candidates.length === 1
                ? candidates[0]
                : undefined;
            if (matched) identity = matched.identity;
            else {
              const unclaimed = baseItems.filter(
                (baseItem) => !assigned.has(baseItem.identity),
              );
              if (unclaimed.length) {
                issues.push(
                  contentIssue(
                    "ambiguous-identity",
                    `${path}.${index}`,
                    "Item identities were omitted and cannot be recovered safely. Read the current draft, preserve each existing _key, and retry the edit.",
                  ),
                );
                return item;
              }
              const keyContext = `${path}.${index}`;
              identity = newKeys.get(keyContext) || options.createKey();
              newKeys.set(keyContext, String(identity));
            }
          }
          if (identity !== undefined) {
            if (typeof identity !== "string" || !identity.trim())
              issues.push(
                contentIssue(
                  "invalid-identity",
                  `${path}.${index}.${identityField}`,
                  "Item identity must be a non-empty string",
                ),
              );
            else if (
              next.some(
                (other, at) =>
                  at < index && record(other)?.[identityField] === identity,
              )
            )
              issues.push(
                contentIssue(
                  "duplicate-identity",
                  `${path}.${index}.${identityField}`,
                  "Item identities must be unique",
                ),
              );
            assigned.add(identity);
          }
          const normalized = visit(
            {
              ...object,
              ...(identity !== undefined ? { [identityField]: identity } : {}),
            },
            field.items,
            matched?.value,
            `${path}[${String(identity)}]`,
            !matched,
          );
          return normalized;
        });
        const seen = new Set<unknown>();
        for (const [index, item] of result.entries()) {
          const key = record(item)?.[identityField];
          if (key !== undefined && seen.has(key))
            issues.push(
              contentIssue(
                "duplicate-identity",
                `${path}.${index}.${identityField}`,
                "Item identity collision. Retry adding this item with a fresh key.",
              ),
            );
          seen.add(key);
        }
        return result;
      }
      case "union": {
        const complete = field.variants.filter(
          (variant) =>
            !validateFieldValue(
              next,
              variant,
              path,
              "publish",
              options.configs,
            ).some((issue) => issue.severity === "hard"),
        );
        const compatible = complete.length
          ? complete
          : field.variants.filter(
              (variant) =>
                !validateFieldValue(
                  next,
                  variant,
                  path,
                  "draft",
                  options.configs,
                ).some((issue) => issue.severity === "hard"),
            );
        if (!compatible.length) return next;
        if (compatible.length === 1)
          return visit(next, compatible[0], base, path, creating);
        const results = compatible.map((variant) =>
          visit(next, variant, base, path, creating),
        );
        if (
          results.some(
            (result) => canonicalValue(result) !== canonicalValue(results[0]),
          )
        ) {
          issues.push(
            contentIssue(
              "ambiguous-union",
              path,
              "Several union alternatives match but require different defaults or item identities. Supply a discriminator or make the alternatives distinct before saving.",
            ),
          );
          return next;
        }
        return results[0];
      }
      case "scalar":
      case "enum":
      case "asset":
      case "reference":
      case "mdx":
      case "slug":
      case "order":
        return next;
      default:
        return assertNever(field);
    }
  };
  if (!("fields" in definition)) return { value, issues, changed: false };
  const normalized = visit(
    value,
    { kind: "object", fields: definition.fields },
    options.base,
    "root",
    options.base === undefined,
  );
  return {
    value: normalized,
    issues,
    changed: canonicalValue(value) !== canonicalValue(normalized),
  };
}
