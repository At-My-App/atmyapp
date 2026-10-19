import type { FieldDefinition, FieldKind } from "./types";
/** Shared compatibility fixtures, also consumed by server contract tests. */
export const contentContractCorpus: ReadonlyArray<{
  kind: FieldKind;
  field: FieldDefinition;
  valid: unknown;
  invalid: unknown;
}> = [
  {
    kind: "scalar",
    field: { kind: "scalar", scalar: "number", integer: true },
    valid: 42,
    invalid: 1.5,
  },
  {
    kind: "enum",
    field: { kind: "enum", values: ["a", "b"] },
    valid: "a",
    invalid: "c",
  },
  {
    kind: "object",
    field: {
      kind: "object",
      fields: { name: { kind: "scalar", scalar: "string" } },
      additionalProperties: false,
    },
    valid: { name: "A", _key: "a" },
    invalid: { name: 5 },
  },
  {
    kind: "array",
    field: {
      kind: "array",
      items: { kind: "scalar", scalar: "string" },
      uniqueItems: true,
    },
    valid: ["a", "b"],
    invalid: ["a", "a"],
  },
  {
    kind: "union",
    field: {
      kind: "union",
      variants: [
        { kind: "scalar", scalar: "string" },
        { kind: "scalar", scalar: "null" },
      ],
    },
    valid: null,
    invalid: 5,
  },
  {
    kind: "asset",
    field: { kind: "asset", assetKind: "image" },
    valid: { __blob: "image" },
    invalid: { other: true },
  },
  {
    kind: "reference",
    field: { kind: "reference", target: "posts" },
    valid: "entry",
    invalid: "",
  },
  {
    kind: "mdx",
    field: { kind: "mdx", config: "article" },
    valid: "# Article",
    invalid: 5,
  },
  {
    kind: "slug",
    field: { kind: "slug" },
    valid: "hello-world",
    invalid: "Hello world",
  },
  { kind: "order", field: { kind: "order" }, valid: 1024, invalid: 1.1 },
];
