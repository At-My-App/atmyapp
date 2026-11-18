import { isDeepStrictEqual } from "node:util";
import { CliError, EXIT } from "./errors";
import { record } from "./workingCopy";

const operations = new Set(["add", "remove", "replace", "test", "copy", "move"]);

function invalid(message: string, pointer?: string): never {
  throw new CliError("invalid_patch", message, { exitCode: EXIT.validation, pointer });
}

function tokens(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) invalid("Invalid JSON pointer.", pointer);
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function slot(parent: unknown, token: string, pointer: string, add = false) {
  if (Array.isArray(parent)) {
    const index = add && token === "-" ? parent.length : /^(0|[1-9]\d*)$/.test(token) ? Number(token) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index > parent.length || (!add && index === parent.length))
      invalid("Array index is out of range.", pointer);
    return index;
  }
  if (!record(parent)) invalid("Path is not inside an object or array.", pointer);
  if (!add && !Object.prototype.hasOwnProperty.call(parent, token)) invalid("Path does not exist.", pointer);
  return token;
}

function lookup(root: unknown, route: string[], pointer: string): unknown {
  let value = root;
  for (const token of route) {
    const key = slot(value, token, pointer);
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

function change(
  root: unknown,
  route: string[],
  pointer: string,
  op: "add" | "replace" | "remove",
  value?: unknown,
): unknown {
  if (route.length === 0) {
    return op === "remove" ? undefined : structuredClone(value);
  }
  const parent = lookup(root, route.slice(0, -1), pointer);
  const key = slot(parent, route[route.length - 1], pointer, op === "add");
  if (Array.isArray(parent)) {
    if (op === "remove") parent.splice(key as number, 1);
    else parent.splice(key as number, op === "add" ? 0 : 1, structuredClone(value));
  } else if (op === "remove") {
    delete (parent as Record<string, unknown>)[key];
  } else {
    Object.defineProperty(parent, key, {
      value: structuredClone(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return root;
}

export function setJsonValue(input: unknown, pointer: string, value: unknown): unknown {
  const route = tokens(pointer);
  if (!route.length) return structuredClone(value);
  const root = structuredClone(input);
  const parent = lookup(root, route.slice(0, -1), pointer);
  const token = route[route.length - 1];
  const replace = Array.isArray(parent) && token !== "-" && Number(token) < parent.length;
  return change(root, route, pointer, replace ? "replace" : "add", value);
}

export function applyJsonPatch(input: unknown, patch: unknown): unknown {
  if (!Array.isArray(patch)) return invalid("A JSON Patch must be an array.");
  let value = structuredClone(input);
  for (const entry of patch) {
    if (!record(entry) || typeof entry.op !== "string" || !operations.has(entry.op) || typeof entry.path !== "string")
      invalid("Each patch operation needs a supported op and path.");
    const { op, path } = entry;
    const route = tokens(path);
    if (op === "add" || op === "replace" || op === "test") {
      if (!Object.prototype.hasOwnProperty.call(entry, "value")) invalid(`'${op}' requires a value.`, path);
      if (op === "test") {
        if (!isDeepStrictEqual(lookup(value, route, path), entry.value))
          invalid("JSON Patch test did not match.", path);
      } else value = change(value, route, path, op, entry.value);
    } else if (op === "remove") value = change(value, route, path, op);
    else {
      if (typeof entry.from !== "string") invalid(`'${op}' requires a source path.`, path);
      const from = tokens(entry.from);
      const copied = lookup(value, from, entry.from);
      if (op === "move") {
        if (from.length === route.length && from.every((part, index) => part === route[index])) continue;
        if (from.length < route.length && from.every((part, index) => part === route[index]))
          invalid("A value cannot be moved into itself.", path);
        value = change(value, from, entry.from, "remove");
      }
      value = change(value, route, path, "add", copied);
    }
  }
  return value;
}
