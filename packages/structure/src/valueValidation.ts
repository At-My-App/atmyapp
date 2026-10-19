import { isObjectArrayItem } from "./localizedIdentities";
import type {
  Definition,
  FieldDefinition,
  MdxConfigDefinition,
  ValidationIssue,
  ValidationResult,
} from "./types";
import { isValidSlug } from "./managedContent";

export type ValidationMode = "draft" | "publish";
export const CONTENT_ISSUE_CODES = [
  "invalid-slug",
  "duplicate-slug",
  "immutable-slug",
  "invalid-reference",
  "duplicate-reference",
  "invalid-order",
  "unique",
  "normalization-required",
  "invalid-type",
  "required",
  "invalid-integer",
  "invalid-date",
  "invalid-format",
  "invalid-enum",
  "minimum",
  "maximum",
  "min-length",
  "max-length",
  "pattern",
  "min-items",
  "max-items",
  "unique-items",
  "unexpected-property",
  "invalid-schema",
  "invalid-json",
  "invalid-identity",
  "duplicate-identity",
  "ambiguous-identity",
  "ambiguous-union",
  "not-localizable",
] as const;
export type ContentIssueCode = (typeof CONTENT_ISSUE_CODES)[number];
const editorialCodes = new Set<ContentIssueCode>([
  "invalid-format",
  "unique",
  "minimum",
  "maximum",
  "min-length",
  "max-length",
  "pattern",
  "min-items",
  "max-items",
  "unique-items",
]);
export function contentIssue(
  code: ContentIssueCode,
  path: string,
  message: string,
): ValidationIssue {
  return {
    code,
    path,
    severity: editorialCodes.has(code) ? "overridable" : "hard",
    message,
  };
}
export function assertNever(value: never): never {
  throw new Error(`Unsupported field kind: ${String(value)}`);
}
export function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function optional(field: FieldDefinition) {
  return field.optional ?? field.required === false;
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
function validDateTime(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  return (
    !!match &&
    validDate(match[1]) &&
    +match[2] < 24 &&
    +match[3] < 60 &&
    +(match[4] || 0) < 60 &&
    (match[5] === "Z" ||
      (+match[5].slice(1, 3) < 24 && +match[5].slice(4) < 60)) &&
    Number.isFinite(Date.parse(value))
  );
}
export function validateFieldValue(
  value: unknown,
  field: FieldDefinition,
  path = "",
  mode: ValidationMode = "publish",
  configs: Record<string, MdxConfigDefinition> = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: ContentIssueCode, message: string, at = path) =>
    issues.push(contentIssue(code, at, message));
  if (value === undefined) {
    if (mode === "publish" && !optional(field))
      add("required", "Required field is missing");
    return issues;
  }
  if (value === null && field.nullable === true) return issues;
  switch (field.kind) {
    case "scalar": {
      const expected = ["date", "datetime", "timestamp"].includes(field.scalar)
        ? "string"
        : field.scalar;
      const actual =
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (
        actual !== expected ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        add("invalid-type", `Expected ${expected}, got ${actual}`);
        break;
      }
      if (typeof value === "number") {
        if (
          (field.integer || field.format === "integer") &&
          !Number.isSafeInteger(value)
        )
          add("invalid-integer", "Expected a safe integer");
        if (field.minimum !== undefined && value < field.minimum)
          add("minimum", `Number less than minimum ${field.minimum}`);
        if (field.maximum !== undefined && value > field.maximum)
          add("maximum", `Number greater than maximum ${field.maximum}`);
      }
      if (typeof value === "string") {
        const format = field.scalar === "string" ? field.format : field.scalar;
        if (format === "date" && !validDate(value))
          add("invalid-date", "Expected a real calendar date (YYYY-MM-DD)");
        if (
          (format === "datetime" || format === "timestamp") &&
          !validDateTime(value)
        )
          add("invalid-date", "Expected an ISO date-time with a timezone");
        if (format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
          add("invalid-format", "Expected an email address");
        if (format === "url") {
          try {
            const url = new URL(value);
            if (!["http:", "https:"].includes(url.protocol)) throw new Error();
          } catch {
            add("invalid-format", "Expected an absolute HTTP or HTTPS URL");
          }
        }
        if (format === "slug" && !isValidSlug(value))
          add("invalid-format", "Expected a lowercase URL identifier");
        if (field.minLength !== undefined && value.length < field.minLength)
          add("min-length", `String shorter than minLength ${field.minLength}`);
        if (field.maxLength !== undefined && value.length > field.maxLength)
          add("max-length", `String longer than maxLength ${field.maxLength}`);
        if (field.pattern) {
          try {
            if (!new RegExp(field.pattern).test(value))
              add("pattern", `Value does not match pattern ${field.pattern}`);
          } catch {
            add("invalid-schema", "Invalid regular expression in schema");
          }
        }
      }
      if (field.enumValues && !field.enumValues.includes(value as never))
        add("invalid-enum", "Value not in enum");
      break;
    }
    case "enum":
      if (!field.values.includes(value as never))
        add("invalid-enum", "Value not in enum");
      break;
    case "order":
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        add("invalid-integer", "Expected a safe integer order rank");
      break;
    case "slug":
      if (!isValidSlug(value))
        add(
          "invalid-slug",
          "Expected a URL identifier of up to 96 lowercase letters, numbers, and single hyphens",
        );
      break;
    case "reference": {
      const values = field.multiple ? value : [value];
      if (!Array.isArray(values)) {
        add("invalid-type", "Expected an array of references");
        break;
      }
      values.forEach((item, index) => {
        if (typeof item !== "string" || !item.trim())
          add(
            "invalid-type",
            "Expected a non-empty reference",
            field.multiple ? `${path}.${index}` : path,
          );
      });
      break;
    }
    case "mdx":
      if (typeof value !== "string")
        add("invalid-type", "Expected an MDX string");
      if (!configs[field.config])
        add("invalid-schema", `Unknown mdx config "${field.config}"`);
      break;
    case "asset": {
      const valid = (item: unknown) => {
        if (typeof item === "string") return item.trim().length > 0;
        if (!item || typeof item !== "object" || Array.isArray(item))
          return false;
        const record = item as Record<string, unknown>;
        return (
          ["$asset", "__blob", "url"].some(
            (key) =>
              typeof record[key] === "string" &&
              (record[key] as string).trim().length > 0,
          ) ||
          (typeof record.data === "string" && record.data.startsWith("data:"))
        );
      };
      const values = field.multiple ? value : [value];
      if (!Array.isArray(values)) {
        add("invalid-type", "Expected an array of asset references");
        break;
      }
      values.forEach((item, index) => {
        if (!valid(item))
          add(
            "invalid-type",
            "Expected an asset reference",
            field.multiple ? `${path}.${index}` : path,
          );
      });
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        add("invalid-type", "Expected array");
        break;
      }
      if (field.minItems !== undefined && value.length < field.minItems)
        add("min-items", `Array shorter than minItems ${field.minItems}`);
      if (field.maxItems !== undefined && value.length > field.maxItems)
        add("max-items", `Array longer than maxItems ${field.maxItems}`);
      if (
        field.uniqueItems &&
        new Set(value.map((item) => canonicalValue(withoutItemKeys(item))))
          .size !== value.length
      )
        add("unique-items", "Array values must be unique");
      const identities = new Set<string>();
      value.forEach((item, index) => {
        const object =
          item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : undefined;
        const identityField =
          field.identityField ||
          (isObjectArrayItem(field.items) ? "_key" : undefined);
        if (identityField && object) {
          const identity = object[identityField];
          if (identity !== undefined) {
            if (typeof identity !== "string" || !identity.trim())
              add(
                "invalid-identity",
                `Expected a non-empty ${identityField}`,
                `${path}.${index}.${identityField}`,
              );
            else if (identities.has(identity))
              add(
                "duplicate-identity",
                "Duplicate item identity",
                `${path}.${index}.${identityField}`,
              );
            else identities.add(identity);
          } else if (field.identityField)
            add(
              "invalid-identity",
              `Missing identity ${identityField}`,
              `${path}.${index}.${identityField}`,
            );
        }
        issues.push(
          ...validateFieldValue(
            item,
            field.items,
            `${path}.${index}`,
            mode,
            configs,
          ),
        );
      });
      break;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        add("invalid-type", "Expected object");
        break;
      }
      const record = value as Record<string, unknown>;
      for (const [name, child] of Object.entries(field.fields))
        issues.push(
          ...validateFieldValue(
            record[name],
            child,
            path ? `${path}.${name}` : name,
            mode,
            configs,
          ),
        );
      if (field.additionalProperties === false)
        for (const name of Object.keys(record))
          if (!(name in field.fields) && name !== "_key")
            add(
              "unexpected-property",
              "Unexpected property",
              `${path}.${name}`,
            );
      break;
    }
    case "union": {
      const branches = field.variants.map((branch) =>
        validateFieldValue(value, branch, path, mode, configs),
      );
      const matched =
        branches.find((branch) => branch.length === 0) ||
        branches.find(
          (branch) => !branch.some((issue) => issue.severity === "hard"),
        );
      if (matched) issues.push(...matched);
      else add("invalid-type", "Value does not match any union variant");
      break;
    }
    default:
      assertNever(field);
  }
  return issues;
}
/** Extra top-level fields are retained content, including fields removed from the editor. */
export function validate(
  value: unknown,
  definition: Definition,
  mode: ValidationMode = "publish",
  configs: Record<string, MdxConfigDefinition> = {},
): ValidationResult {
  if (!("fields" in definition)) return { valid: true, issues: [] };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      valid: false,
      issues: [contentIssue("invalid-type", "root", "Expected object")],
    };
  const issues = Object.entries(definition.fields).flatMap(([name, field]) =>
    validateFieldValue(
      (value as Record<string, unknown>)[name],
      field,
      name,
      mode,
      configs,
    ),
  );
  return { valid: issues.length === 0, issues };
}

/** Internal item identity is excluded only from business comparisons and owner presentation. */
export function withoutItemKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutItemKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "_key")
      .map(([key, item]) => [key, withoutItemKeys(item)]),
  );
}
