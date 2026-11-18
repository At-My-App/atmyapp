/**
 * Applies a translation overlay to its source (variant "overlay" mode).
 * Array items are matched by identity (`_key`, a declared identityField, or a
 * unique key the source also has), never by position.
 *
 */
import type { FieldDefinition } from "./types";
function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isScalarIdentity(value: unknown) {
  return typeof value === 'string' || typeof value === 'number';
}

export function findVariantArrayIdentity(
  items: unknown[],
  baseItems: unknown[] = [],
  declaredIdentity?: string
): string | null {
  if (!items.every(isPlainObject)) {
    return null;
  }
  for (const key of declaredIdentity
    ? [declaredIdentity]
    : ['_key', 'id', 'key', 'slug']) {
    if (items.every((item) => isScalarIdentity(item[key]))) {
      return key;
    }
  }
  if (declaredIdentity) return null;
  if (!baseItems.every(isPlainObject) || items.length === 0) {
    return null;
  }
  for (const key of Object.keys(items[0] as Record<string, unknown>)) {
    const identities = (items as Record<string, unknown>[]).map(
      (item) => item[key]
    );
    if (
      identities.every(isScalarIdentity) &&
      new Set(identities).size === identities.length &&
      identities.every((identity) =>
        (baseItems as Record<string, unknown>[]).some(
          (item) => item[key] === identity
        )
      )
    ) {
      return key;
    }
  }
  return null;
}

export function mergeVariantOverlay(
  base: any,
  overlay: any,
  field?: FieldDefinition
): any {
  if (
    !Array.isArray(base) &&
    Array.isArray(overlay) &&
    (field?.kind === 'array' ||
      overlay.some(
        (item) => isPlainObject(item) && typeof item._key === 'string'
      ))
  )
    return [];
  if (Array.isArray(base) && Array.isArray(overlay)) {
    const identityField = findVariantArrayIdentity(
      overlay,
      base,
      field?.kind === 'array' ? field.identityField || '_key' : undefined
    );
    if (!identityField) {
      return overlay;
    }
    const overlayById = new Map(
      overlay.map((item) => [item[identityField], item])
    );
    const merged = base.map((item) => {
      if (!isPlainObject(item) || !isScalarIdentity(item[identityField])) {
        return item;
      }
      const localized = overlayById.get(item[identityField]);
      overlayById.delete(item[identityField]);
      return localized
        ? mergeVariantOverlay(
            item,
            localized,
            field?.kind === 'array' ? field.items : undefined
          )
        : item;
    });
    return identityField === '_key' || field?.kind === 'array'
      ? merged
      : [...merged, ...overlayById.values()];
  }
  if ((isPlainObject(base) || base == null) && isPlainObject(overlay)) {
    const source = isPlainObject(base) ? base : {};
    const merged = { ...source };
    for (const [key, value] of Object.entries(overlay)) {
      merged[key] = mergeVariantOverlay(
        source[key],
        value,
        field?.kind === 'object' ? field.fields[key] : undefined
      );
    }
    return merged;
  }

  return overlay;
}
