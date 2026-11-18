import { isDeepStrictEqual as equal } from "node:util";
import type { FieldDefinition } from "@atmyapp/structure";

export interface MergeConflict {
  pointer: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export type MergeSide = "ours" | "theirs";

export const pointerPart = (part: string) => part.replace(/~/g, "~0").replace(/\//g, "~1");

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

type Identity = string | number;

function keyed(values: unknown[], field: string) {
  const result = new Map<Identity, Record<string, unknown>>();
  for (const value of values) {
    if (!object(value)) return;
    const identity = value[field];
    if ((typeof identity !== "string" && typeof identity !== "number") || result.has(identity)) return;
    result.set(identity, value);
  }
  return result;
}

/** Merge JSON content. Undefined represents a missing property, item or resource. */
export function mergeContent(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  field?: FieldDefinition,
  choices: ReadonlyMap<string, MergeSide> = new Map(),
) {
  const conflicts: MergeConflict[] = [];
  function visit(b: unknown, o: unknown, t: unknown, pointer: string, schema?: FieldDefinition): unknown {
    if (equal(o, b)) return t;
    if (equal(t, b) || equal(o, t)) return o;

    if (Array.isArray(o) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
      const identity = schema?.kind === "array" ? (schema.identityField ?? "_key") : "_key";
      const old = keyed(b ?? [], identity);
      const local = keyed(o, identity);
      const remote = keyed(t, identity);
      if (old && local && remote) {
        const merged = new Map<Identity, unknown>();
        for (const id of new Set([...remote.keys(), ...local.keys()])) {
          const child = pointer + "/" + pointerPart(identity + "=" + encodeURIComponent(String(id)));
          const value = visit(
            old.get(id),
            local.get(id),
            remote.get(id),
            child,
            schema?.kind === "array" ? schema.items : undefined,
          );
          if (value !== undefined) merged.set(id, value);
        }
        // Use the published order, then insert local additions after their last
        // surviving predecessor. A remote deletion with a conflict still gets a slot.
        const order = [...remote.keys()].filter((id) => merged.has(id));
        let predecessor: Identity | undefined;
        for (const id of local.keys()) {
          if (!merged.has(id)) continue;
          if (!remote.has(id)) order.splice(predecessor === undefined ? 0 : order.indexOf(predecessor) + 1, 0, id);
          predecessor = id;
        }
        return order.map((id) => merged.get(id));
      }
    }
    if (object(o) && object(t) && (b === undefined || object(b))) {
      const keys = new Set([...Object.keys(o), ...Object.keys(t)]);
      return Object.fromEntries(
        [...keys].flatMap((key) => {
          const get = (value: Record<string, unknown> | undefined) =>
            value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
          const child = visit(
            get(b),
            get(o),
            get(t),
            pointer + "/" + pointerPart(key),
            schema?.kind === "object" ? schema.fields[key] : undefined,
          );
          return child === undefined ? [] : [[key, child]];
        }),
      );
    }

    const choice = choices.get(pointer);
    if (!choice) conflicts.push({ pointer, base: b, ours: o, theirs: t });
    return choice === "theirs" ? t : o;
  }

  return { value: visit(base, ours, theirs, "", field), conflicts };
}
