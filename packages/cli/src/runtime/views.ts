import { escapePointerToken, resolvePointer } from "./refs";
import type { Outline, OutlineRow, ValueView } from "./schemas/content";

export type { Outline, OutlineRow, ValueView } from "./schemas/content";

/**
 * Large-value views (AgenticCliPlan.md §6.1). Values over `FULL_LIMIT`
 * characters come back as an outline of JSON pointers, the approach the
 * in-app assistant uses (assistant-service large-document.ts).
 */

export const FULL_LIMIT = 20_000;
const OUTLINE_ROWS = 400;
const LABEL_KEYS = ["name", "title", "label", "heading", "question", "slug", "id", "_key"];

function labelOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 60) || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of LABEL_KEYS) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]).replace(/\s+/g, " ").slice(0, 60);
  }
  return undefined;
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `list of ${value.length}`;
  if (value && typeof value === "object") return `${Object.keys(value as object).length} fields`;
  if (typeof value === "string") return `text, ${value.length} characters`;
  return value === null ? "null" : typeof value;
}

/** One row per field and per list item, three object levels deep. */
export function outlineOf(root: unknown, base = ""): Outline {
  const rows: OutlineRow[] = [];
  let truncated = false;
  const push = (row: OutlineRow) => {
    if (rows.length >= OUTLINE_ROWS) {
      truncated = true;
      return false;
    }
    rows.push(row);
    return true;
  };
  const visit = (value: unknown, pointer: string, depth: number) => {
    if (truncated) return;
    if (Array.isArray(value)) {
      if (!push({ pointer: pointer || "/", summary: summarize(value) })) return;
      value.forEach((item, index) => {
        const label = labelOf(item);
        push({ pointer: `${pointer}/${index}`, summary: summarize(item), ...(label ? { label } : {}) });
      });
      return;
    }
    if (value && typeof value === "object" && depth < 3) {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        const nestedPointer = `${pointer}/${escapePointerToken(key)}`;
        if (nested && typeof nested === "object") visit(nested, nestedPointer, depth + 1);
        else if (!push({ pointer: nestedPointer, summary: summarize(nested) })) return;
      }
      return;
    }
    push({ pointer: pointer || "/", summary: summarize(value) });
  };
  visit(root, base, 0);
  return { rows, truncated };
}

/**
 * The whole value when it is small or `full` is set; otherwise its outline.
 * With a pointer, the part at the pointer under the same rule.
 */
export function viewValue(value: unknown, options: { pointer?: string; full?: boolean } = {}): ValueView | null {
  let target = value;
  const pointer = options.pointer;
  if (pointer !== undefined && pointer !== "") {
    const resolved = resolvePointer(value, pointer);
    if (!resolved.found) return null;
    target = resolved.value;
  }
  const size = JSON.stringify(target)?.length ?? 0;
  if (options.full || size <= FULL_LIMIT) {
    return pointer ? { view: "part", pointer, value: target } : { view: "full", value: target };
  }
  return {
    view: "outline",
    pointer: pointer ?? "",
    size,
    outline: outlineOf(target, pointer && pointer !== "/" ? pointer : ""),
    note: `This value is large (${size} characters), so this is its outline. Read one part with --pointer <pointer>, or everything with --full.`,
  };
}

// --- Assets ------------------------------------------------------------------

/** What the website receives for an asset (`{ url, alt?, … }`). */
export type DeliveredAsset = Record<string, unknown> & { url: string };

/** The stored reference an asset value carries, if it is one. */
export function storedAssetRef(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.$asset === "string") return `$asset:${record.$asset}`;
  if (typeof record.__blob === "string") return `__blob:${record.__blob}`;
  return null;
}

function isDeliveredAsset(value: unknown): value is DeliveredAsset {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as any).url === "string";
}

/**
 * Pairs the stored and delivered forms of one value: every stored asset
 * reference with the delivered object at the same place. Local mode uses the
 * map to give websites the delivered shape without downloading media.
 */
export function collectAssetMap(stored: unknown, delivered: unknown, into: Record<string, DeliveredAsset> = {}) {
  const ref = storedAssetRef(stored);
  if (ref) {
    if (isDeliveredAsset(delivered)) into[ref] = delivered;
    return into;
  }
  // Entry blob fields can be stored as a bare blob ID string.
  if (typeof stored === "string" && isDeliveredAsset(delivered) && typeof delivered.blobId === "string" && delivered.blobId === stored) {
    into[`__blob:${stored}`] = delivered;
    return into;
  }
  if (Array.isArray(stored) && Array.isArray(delivered)) {
    stored.forEach((item, index) => collectAssetMap(item, delivered[index], into));
    return into;
  }
  if (stored && typeof stored === "object" && delivered && typeof delivered === "object" && !Array.isArray(delivered)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      collectAssetMap(value, (delivered as Record<string, unknown>)[key], into);
    }
  }
  return into;
}
