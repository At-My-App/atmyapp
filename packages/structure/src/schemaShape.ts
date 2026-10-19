import type { SchemaDocument, FieldDefinition, FieldKind } from "./types";
import { validateFieldValue } from "./valueValidation";

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: expected object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key) && value[key] !== undefined)
      throw new Error(`${path}.${key}: unknown schema property`);
}
const base = [
  "nullable",
  "kind",
  "description",
  "localize",
  "optional",
  "required",
  "unique",
  "default",
  "legacy",
  "storage",
  "ui",
];
const properties: Record<FieldKind, string[]> = {
  scalar: [
    "scalar",
    "min",
    "max",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "preferredLength",
    "step",
    "pattern",
    "enumValues",
    "format",
    "placeholder",
    "examples",
    "integer",
  ],
  enum: ["values"],
  object: ["fields", "additionalProperties"],
  array: ["items", "identityField", "minItems", "maxItems", "uniqueItems"],
  union: ["variants"],
  asset: [
    "assetKind",
    "multiple",
    "accept",
    "config",
    "imageOptions",
    "deletePolicy",
    "orphanPolicy",
  ],
  reference: ["target", "multiple", "by", "targetField", "onDelete"],
  mdx: ["config"],
  slug: ["source", "generated", "immutable", "updatePolicy"],
  order: ["groupBy"],
};
function fields(input: unknown, path: string) {
  for (const [name, value] of Object.entries(object(input, path))) {
    if (["_key", "__proto__", "constructor", "prototype"].includes(name))
      throw new Error(`${path}.${name}: reserved item identity`);
    field(value, `${path}.${name}`);
  }
}
function field(input: unknown, path: string) {
  const value = object(input, path);
  const kind = value.kind;
  if (
    typeof kind !== "string" ||
    !Object.prototype.hasOwnProperty.call(properties, kind)
  )
    throw new Error(`${path}.kind: unsupported field kind ${String(kind)}`);
  keys(value, [...base, ...properties[kind as FieldKind]], path);
  if (
    value.minLength !== undefined &&
    (!Number.isInteger(value.minLength) || Number(value.minLength) < 0)
  )
    throw new Error(`${path}.minLength: expected non-negative integer`);
  if (
    value.maxLength !== undefined &&
    (!Number.isInteger(value.maxLength) || Number(value.maxLength) < 0)
  )
    throw new Error(`${path}.maxLength: expected non-negative integer`);
  for (const name of ["minItems", "maxItems"])
    if (
      value[name] !== undefined &&
      (!Number.isInteger(value[name]) || Number(value[name]) < 0)
    )
      throw new Error(`${path}.${name}: expected non-negative integer`);
  for (const name of [
    "nullable",
    "optional",
    "required",
    "localize",
    "unique",
    "integer",
    "additionalProperties",
    "multiple",
    "uniqueItems",
    "generated",
    "immutable",
  ])
    if (value[name] !== undefined && typeof value[name] !== "boolean")
      throw new Error(`${path}.${name}: expected boolean`);
  for (const name of [
    "min",
    "max",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "preferredLength",
    "step",
    "minItems",
    "maxItems",
  ])
    if (
      value[name] !== undefined &&
      (typeof value[name] !== "number" || !Number.isFinite(value[name]))
    )
      throw new Error(`${path}.${name}: expected finite number`);
  for (const name of [
    "description",
    "identityField",
    "target",
    "targetField",
    "by",
    "onDelete",
    "source",
    "groupBy",
    "updatePolicy",
    "placeholder",
    "format",
  ])
    if (value[name] !== undefined && typeof value[name] !== "string")
      throw new Error(`${path}.${name}: expected string`);
  for (const name of ["enumValues", "values", "examples"])
    if (
      value[name] !== undefined &&
      (!Array.isArray(value[name]) ||
        (value[name] as unknown[]).some(
          (item) =>
            item !== null &&
            !["string", "number", "boolean"].includes(typeof item),
        ))
    )
      throw new Error(`${path}.${name}: expected primitive values`);
  for (const [low, high] of [
    ["minLength", "maxLength"],
    ["minimum", "maximum"],
    ["minItems", "maxItems"],
  ])
    if (
      value[low] !== undefined &&
      value[high] !== undefined &&
      Number(value[low]) > Number(value[high])
    )
      throw new Error(`${path}: ${low} must not exceed ${high}`);
  if (
    value.optional !== undefined &&
    value.required !== undefined &&
    value.optional === value.required
  )
    throw new Error(`${path}: conflicting required and optional`);
  if (
    kind === "scalar" &&
    ![
      "string",
      "number",
      "boolean",
      "null",
      "date",
      "datetime",
      "timestamp",
    ].includes(String(value.scalar))
  )
    throw new Error(`${path}.scalar: unsupported scalar type`);
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== "string")
      throw new Error(`${path}.pattern: expected string`);
    try {
      new RegExp(value.pattern);
    } catch {
      throw new Error(`${path}.pattern: invalid regular expression`);
    }
  }
  if (kind === "object") fields(value.fields, `${path}.fields`);
  if (kind === "array") {
    field(value.items, `${path}.items`);
    if (value.identityField !== undefined) {
      const item = object(value.items, `${path}.items`);
      const child = object(
        object(item.fields, `${path}.items.fields`)[
          String(value.identityField)
        ],
        `${path}.identityField`,
      );
      if (
        item.kind !== "object" ||
        child.kind !== "scalar" ||
        child.scalar !== "string" ||
        child.localize === true
      )
        throw new Error(
          `${path}.identityField: expected a non-localized string field`,
        );
    }
  }
  if (kind === "union") {
    if (!Array.isArray(value.variants) || !value.variants.length)
      throw new Error(`${path}.variants: expected non-empty array`);
    value.variants.forEach((item, index) =>
      field(item, `${path}.variants.${index}`),
    );
  }
  if (kind === "enum" && (!Array.isArray(value.values) || !value.values.length))
    throw new Error(`${path}.values: expected non-empty array`);
  if (
    kind === "reference" &&
    (typeof value.target !== "string" || !value.target)
  )
    throw new Error(`${path}.target: expected definition name`);
  if (
    kind === "asset" &&
    !["image", "file", "gallery"].includes(String(value.assetKind))
  )
    throw new Error(`${path}.assetKind: unsupported asset kind`);
}
/** Checks the declared vocabulary before normalization can discard unsupported input. */
export function assertSchemaShape(input: SchemaDocument): void {
  const root = object(input, "schema");
  keys(
    root,
    [
      "version",
      "description",
      "localization",
      "definitions",
      "events",
      "args",
      "mdx",
      "submissions",
      "metadata",
      "generatedAt",
    ],
    "schema",
  );
  if (root.localization !== undefined) {
    const localization = object(root.localization, "localization");
    keys(localization, ["enabled"], "localization");
    if (typeof localization.enabled !== "boolean")
      throw new Error("localization.enabled: expected boolean");
  }
  for (const [name, raw] of Object.entries(
    object(root.definitions || {}, "definitions"),
  )) {
    if (["__proto__", "constructor", "prototype"].includes(name))
      throw new Error(`definitions.${name}: reserved name`);
    const definition = object(raw, `definitions.${name}`);
    if (
      definition.localize !== undefined &&
      typeof definition.localize !== "boolean"
    )
      throw new Error(`definitions.${name}.localize: expected boolean`);
    if (definition.systemFields !== undefined)
      for (const [key, input] of Object.entries(
        object(definition.systemFields, `definitions.${name}.systemFields`),
      )) {
        if (!["id", "createdAt", "updatedAt", "slug"].includes(key))
          throw new Error(
            `definitions.${name}.systemFields.${key}: unknown system field`,
          );
        if (typeof input === "boolean") continue;
        keys(
          object(input, `systemFields.${key}`),
          [
            "enabled",
            "readable",
            "queryable",
            "generated",
            "immutable",
            "unique",
            "settable",
            "requiredInStoredShape",
            "source",
            "updatePolicy",
          ],
          `systemFields.${key}`,
        );
      }
    const kind = definition.kind;
    if (
      !["collection", "document", "system_config", "file", "image"].includes(
        String(kind),
      )
    )
      throw new Error(`definitions.${name}.kind: unsupported definition kind`);
    keys(
      definition,
      [
        "kind",
        "name",
        "description",
        "localize",
        "systemFields",
        ...(kind === "collection"
          ? ["fields", "indexes"]
          : kind === "document"
            ? ["path", "fields"]
            : kind === "system_config"
              ? [
                  "framework",
                  "systemKey",
                  "displayName",
                  "path",
                  "fields",
                  "managedBy",
                ]
              : ["path", "config"]),
      ],
      `definitions.${name}`,
    );
    if (["collection", "document", "system_config"].includes(String(kind)))
      fields(definition.fields, `definitions.${name}.fields`);
  }
  for (const [name, raw] of Object.entries(input.submissions || {})) {
    const submission = object(raw, `submissions.${name}`);
    if ("hcaptchaSecret" in submission)
      throw new Error(
        "Submission CAPTCHA secrets must be configured on the server",
      );
    keys(
      submission,
      [
        "description",
        "fields",
        "captcha",
        "requiresCaptcha",
        "captchaProvider",
      ],
      `submissions.${name}`,
    );
    fields(submission.fields, `submissions.${name}.fields`);
    if (submission.captcha && "secret" in object(submission.captcha, "captcha"))
      throw new Error(
        "Submission CAPTCHA secrets must be configured on the server",
      );
    if ("hcaptchaSecret" in submission)
      throw new Error(
        "Submission CAPTCHA secrets must be configured on the server",
      );
    if (submission.captcha)
      keys(
        object(submission.captcha, "captcha"),
        ["required", "provider"],
        "captcha",
      );
  }
  for (const [name, raw] of Object.entries(input.events || {})) {
    const event = object(raw, `events.${name}`);
    keys(event, ["description", "columns"], `events.${name}`);
    if (
      !Array.isArray(event.columns) ||
      event.columns.some((column) => typeof column !== "string")
    )
      throw new Error(`events.${name}.columns: expected string array`);
  }
}
export function assertSchemaDefaults(schema: SchemaDocument): void {
  const visit = (value: FieldDefinition, path: string) => {
    if (value.default !== undefined) {
      const issues = validateFieldValue(
        value.default,
        value,
        path,
        "publish",
        schema.mdx,
      );
      if (issues.length)
        throw new Error(`${path}.default: ${issues[0].message}`);
    }
    if (value.kind === "object")
      for (const [name, child] of Object.entries(value.fields))
        visit(child, `${path}.${name}`);
    if (value.kind === "array") visit(value.items, `${path}[]`);
    if (value.kind === "union")
      value.variants.forEach((child, index) =>
        visit(child, `${path}|${index}`),
      );
  };
  for (const [name, definition] of Object.entries(schema.definitions))
    if ("fields" in definition)
      for (const [key, value] of Object.entries(definition.fields))
        visit(value, `${name}.${key}`);
  for (const [name, submission] of Object.entries(schema.submissions || {}))
    for (const [key, value] of Object.entries(submission.fields || {}))
      visit(value, `${name}.${key}`);
}
