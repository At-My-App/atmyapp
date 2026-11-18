import type { FieldDefinition } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildLocalizedOverlayField(
  field: FieldDefinition | undefined,
  base: unknown,
  localized: unknown,
  path: string,
): unknown {
  if (valuesEqual(base, localized)) {
    return undefined;
  }

  if (field?.kind === "object") {
    if (!isRecord(localized)) {
      throw new Error(`Localized field '${path}' must be an object.`);
    }
    const overlay: Record<string, unknown> = Object.create(null);
    for (const [name, value] of Object.entries(localized)) {
      const child = Object.prototype.hasOwnProperty.call(field.fields, name) ? field.fields[name] : undefined;
      if (!child) {
        throw new Error(`Field '${path}.${name}' is not defined.`);
      }
      const childOverlay = buildLocalizedOverlayField(
        child,
        isRecord(base) ? base[name] : undefined,
        value,
        `${path}.${name}`,
      );
      if (childOverlay !== undefined) {
        overlay[name] = childOverlay;
      }
    }
    return Object.keys(overlay).length > 0 ? overlay : undefined;
  }

  if (field?.kind === "array") {
    if (!Array.isArray(localized)) {
      throw new Error(`Localized field '${path}' must be an array.`);
    }
    if (field.items?.kind !== "object") {
      if (field.localize === true || field.items?.localize === true) {
        return localized;
      }
      throw new Error(`Field '${path}' is not localizable.`);
    }

    const { fields: itemFields } = field.items;
    const identityField = field.identityField || "_key";
    const baseItems = Array.isArray(base) ? base : [];
    const overlayItems = localized.flatMap((item, index) => {
      if (!isRecord(item) || item[identityField] == null) {
        throw new Error(`Localized field '${path}.${index}' requires identity '${identityField}'.`);
      }
      const baseItem = baseItems.find(
        (candidate) => isRecord(candidate) && candidate[identityField] === item[identityField],
      );
      if (!baseItem)
        throw new Error(
          `Localized item '${path}.${index}' does not match an existing item. Refresh the source content and preserve its identity.`,
        );
      const itemOverlay: Record<string, unknown> = {
        [identityField]: item[identityField],
      };
      for (const [name, value] of Object.entries(item)) {
        if (name === identityField) continue;
        const child = Object.prototype.hasOwnProperty.call(itemFields, name) ? itemFields[name] : undefined;
        if (!child) {
          throw new Error(`Field '${path}.${index}.${name}' is not defined.`);
        }
        const childOverlay = buildLocalizedOverlayField(
          child,
          isRecord(baseItem) ? baseItem[name] : undefined,
          value,
          `${path}.${index}.${name}`,
        );
        if (childOverlay !== undefined) {
          itemOverlay[name] = childOverlay;
        }
      }
      return Object.keys(itemOverlay).length > 1 ? [itemOverlay] : [];
    });
    return overlayItems.length > 0 ? overlayItems : undefined;
  }

  if (field?.localize === true) {
    return localized;
  }
  throw new Error(`Field '${path}' is not localizable.`);
}

export function buildLocalizedDocumentOverlay(
  fields: Record<string, FieldDefinition>,
  base: unknown,
  localized: unknown,
): Record<string, unknown> {
  if (!isRecord(localized)) {
    throw new Error("Localized document content must be a JSON object.");
  }
  const overlay: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(localized)) {
    const field = Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : undefined;
    if (!field) {
      throw new Error(`Field '${name}' is not defined.`);
    }
    const fieldOverlay = buildLocalizedOverlayField(field, isRecord(base) ? base[name] : undefined, value, name);
    if (fieldOverlay !== undefined) {
      overlay[name] = fieldOverlay;
    }
  }
  return { ...overlay };
}
