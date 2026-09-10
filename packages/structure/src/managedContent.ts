/** Shared, deterministic primitives. Persistence must protect the snapshot revision. */
export const ORDER_SPACING = 1024;
export const MAX_SLUG_LENGTH = 96;
export type Placement =
  | { position: "first" }
  | { position: "last" }
  | { position: "before"; entryId: string }
  | { position: "after"; entryId: string };

export function normalizeSlug(value: string): string {
  return value
    .replace(/[łŁ]/g, "l")
    .replace(/[ß]/g, "ss")
    .replace(/[æÆ]/g, "ae")
    .replace(/[œŒ]/g, "oe")
    .replace(/[øØ]/g, "o")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

export function isValidSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SLUG_LENGTH &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

export function generateUniqueSlug(
  source: string,
  existing: ReadonlySet<string>,
): string {
  const base = normalizeSlug(source);
  if (!base)
    throw new Error("Enter a URL identifier containing letters or numbers.");
  if (!existing.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const tail = `-${suffix}`;
    const candidate =
      base.slice(0, MAX_SLUG_LENGTH - tail.length).replace(/-+$/g, "") + tail;
    if (!existing.has(candidate)) return candidate;
  }
}

export interface RankedEntry {
  id: string;
  rank?: number;
}

/** Returns only changed ranks. The caller supplies exactly one field/group. */
export function placeEntry(
  entries: readonly RankedEntry[],
  entryId: string,
  placement: Placement,
): Record<string, number> {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error("Duplicate entry IDs.");
  if (!entries.some((entry) => entry.id === entryId))
    throw new Error("The entry no longer exists.");
  if (
    !placement ||
    !["first", "last", "before", "after"].includes(placement.position)
  )
    throw new Error("Choose first, last, before, or after.");
  if ("entryId" in placement && placement.entryId === entryId)
    throw new Error("An entry cannot be placed relative to itself.");
  const sorted = [...entries].sort((a, b) => {
    const aRank = Number.isSafeInteger(a.rank)
      ? a.rank!
      : Number.MAX_SAFE_INTEGER;
    const bRank = Number.isSafeInteger(b.rank)
      ? b.rank!
      : Number.MAX_SAFE_INTEGER;
    return aRank - bRank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const moving = sorted.find((entry) => entry.id === entryId)!;
  const rest = sorted.filter((entry) => entry.id !== entryId);
  let index = placement.position === "first" ? 0 : rest.length;
  if ("entryId" in placement) {
    const anchor = rest.findIndex((entry) => entry.id === placement.entryId);
    if (anchor < 0)
      throw new Error("The placement target no longer exists in this group.");
    index = anchor + (placement.position === "after" ? 1 : 0);
  }
  const result = [...rest.slice(0, index), moving, ...rest.slice(index)];
  const valid =
    rest.every((entry) => Number.isSafeInteger(entry.rank)) &&
    new Set(rest.map((entry) => entry.rank)).size === rest.length;
  if (
    valid &&
    Number.isSafeInteger(moving.rank) &&
    new Set(sorted.map((entry) => entry.rank)).size === sorted.length &&
    sorted.every((entry, i) => entry.id === result[i].id)
  )
    return {};
  const before = result[index - 1]?.rank;
  const after = result[index + 1]?.rank;
  const rank =
    before === undefined
      ? after === undefined
        ? ORDER_SPACING
        : after - ORDER_SPACING
      : after === undefined
        ? before + ORDER_SPACING
        : before + Math.floor((after - before) / 2);
  if (
    valid &&
    Number.isSafeInteger(rank) &&
    (before === undefined || rank > before) &&
    (after === undefined || rank < after)
  ) {
    return { [entryId]: rank };
  }
  return Object.fromEntries(
    result.flatMap((entry, i) => {
      const next = (i + 1) * ORDER_SPACING;
      return entry.rank === next ? [] : [[entry.id, next]];
    }),
  );
}
