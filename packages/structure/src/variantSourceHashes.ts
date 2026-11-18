import { findVariantArrayIdentity } from "./variantMerge";
import type { FieldDefinition } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function variantSourceValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(variantSourceValue).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${variantSourceValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function collectVariantSourceHashes(
  base: unknown,
  overlay: unknown,
  path = "",
  hashes: Record<string, string> = {},
  field?: FieldDefinition,
): Record<string, string> {
  if (Array.isArray(overlay)) {
    const identityField = findVariantArrayIdentity(
      overlay,
      Array.isArray(base) ? base : [],
      field?.kind === "array" ? (field.identityField ?? "_key") : undefined,
    );
    if (identityField && Array.isArray(base)) {
      for (const item of overlay) {
        if (!isRecord(item)) continue;
        const identity = item[identityField];
        const baseItem = base.find((candidate) => isRecord(candidate) && candidate[identityField] === identity);
        for (const [key, value] of Object.entries(item)) {
          if (key === identityField) continue;
          collectVariantSourceHashes(
            isRecord(baseItem) ? baseItem[key] : undefined,
            value,
            `${path}[${identityField}=${encodeURIComponent(String(identity))}].${key}`,
            hashes,
            field?.kind === "array" && field.items.kind === "object" ? field.items.fields[key] : undefined,
          );
        }
      }
      return hashes;
    }
    hashes[path] = variantSourceValue(base);
    return hashes;
  }

  if (isRecord(overlay)) {
    for (const [key, value] of Object.entries(overlay)) {
      collectVariantSourceHashes(
        isRecord(base) ? base[key] : undefined,
        value,
        path ? `${path}.${key}` : key,
        hashes,
        field?.kind === "object" ? field.fields[key] : undefined,
      );
    }
    return hashes;
  }

  hashes[path] = variantSourceValue(base);
  return hashes;
}

export function countOutdatedVariantPaths(base: unknown, hashes: Record<string, string>): number {
  return Object.entries(hashes).filter(([path, hash]) => {
    const value = path
      .replace(/\[[^\]]*\]/g, (selector) => selector.replace(/\./g, "%2E"))
      .split(".")
      .filter(Boolean)
      .reduce<unknown>((current, segment) => {
        const arraySegment = /^([^\[]+)\[([^=]+)=(.*)\]$/.exec(segment);
        if (!arraySegment) {
          return isRecord(current) ? current[segment] : undefined;
        }
        const [, field, identityField, encodedIdentity] = arraySegment;
        const items = isRecord(current) ? current[field] : undefined;
        const identity = decodeURIComponent(encodedIdentity);
        return Array.isArray(items)
          ? items.find((item) => isRecord(item) && String(item[identityField]) === identity)
          : undefined;
      }, base);
    return variantSourceValue(value) !== hash;
  }).length;
}
