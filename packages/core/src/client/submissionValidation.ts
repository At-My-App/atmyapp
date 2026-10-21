import { validateFieldValue, type FieldDefinition } from "@atmyapp/structure";
import type { SubmissionFieldErrors } from "./submissionError";

const TRUE_VALUES = new Set(["on", "true", "1", "yes"]);
const FALSE_VALUES = new Set(["off", "false", "0", "no"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) === "[object Object]"
  );
}

function isBinaryLike(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function isFileValue(value: unknown): boolean {
  return isBinaryLike(value) || (isPlainObject(value) && isBinaryLike(value.file));
}

/** "Not filled in" exactly as the service sees it: blank strings, empty lists and objects. */
function dropEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(dropEmpty).filter((entry) => entry !== undefined);
    return items.length ? items : undefined;
  }
  if (isPlainObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = dropEmpty(entry);
      if (cleaned !== undefined) next[key] = cleaned;
    }
    return Object.keys(next).length ? next : undefined;
  }
  if (typeof value === "string" && value.trim() === "") return undefined;
  if (value === null || value === undefined) return undefined;
  return value;
}

/** Form strings to the field's type, as the service does for HTML posts. */
function coerce(value: unknown, field: FieldDefinition): unknown {
  if (value === undefined || value === null) return value;
  switch (field.kind) {
    case "scalar": {
      if (typeof value !== "string") return value;
      const text = value.trim();
      if (field.scalar === "number") {
        const parsed = Number(text.replace(",", "."));
        return Number.isFinite(parsed) ? parsed : value;
      }
      if (field.scalar === "boolean") {
        const lower = text.toLowerCase();
        if (TRUE_VALUES.has(lower)) return true;
        if (FALSE_VALUES.has(lower)) return false;
      }
      return value;
    }
    case "enum": {
      if (typeof value !== "string") return value;
      const match = field.values.find((candidate) => String(candidate) === value);
      return match === undefined ? value : match;
    }
    case "array":
      return (Array.isArray(value) ? value : [value]).map((item) => coerce(item, field.items));
    case "object": {
      if (!isPlainObject(value)) return value;
      const next: Record<string, unknown> = { ...value };
      for (const [key, child] of Object.entries(field.fields)) {
        const coerced = coerce(value[key], child);
        if (coerced === undefined) delete next[key];
        else next[key] = coerced;
      }
      return next;
    }
    default:
      return value;
  }
}

const required = (field: FieldDefinition) => !field.optional && !field.nullable;

/** FormData as a plain object: repeated keys and `name[]` become lists. */
export function formDataToObject(form: FormData): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  form.forEach((value, rawKey) => {
    const list = rawKey.endsWith("[]");
    const key = list ? rawKey.slice(0, -2) : rawKey;
    if (key in data) {
      const current = data[key];
      data[key] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      data[key] = list ? [value] : value;
    }
  });
  return data;
}

/**
 * The service's field checks, run before sending: required fields, types,
 * formats, lengths and file counts. Fields the schema doesn't list are left
 * to the service (it drops them by default).
 */
export function validateSubmissionData(
  data: Record<string, unknown>,
  fields: Record<string, FieldDefinition>
): SubmissionFieldErrors {
  const errors: SubmissionFieldErrors = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.kind === "asset") {
      const value = data[key];
      const count = (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(isFileValue).length;
      if (count === 0 && required(field)) errors[key] = "required";
      else if (count > 1 && !field.multiple && field.assetKind !== "gallery") errors[key] = "max_items";
      continue;
    }
    const value = coerce(dropEmpty(data[key]), field);
    const issues = validateFieldValue(value, field, key, "publish");
    const issue = issues.find((candidate) => candidate.severity === "hard") ?? issues[0];
    if (issue) errors[issue.path || key] = issue.code.replace(/-/g, "_");
  }
  return errors;
}
