import { parseSchema } from "./compiler";
import type { LegacyStructureDocument, SchemaDocument } from "./types";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

/** Normalized contract identity, independent of transport metadata and object key order. */
export function serializeSchema(
  input: string | SchemaDocument | LegacyStructureDocument,
): string {
  return JSON.stringify(sortValue(parseSchema(input)));
}
