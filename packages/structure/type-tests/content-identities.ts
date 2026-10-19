import type { FieldValue } from "../src";
type Items = FieldValue<{ kind: "array"; items: { kind: "union"; variants: [{ kind: "object"; fields: { name: { kind: "scalar"; scalar: "string" } } }] } }>;
const items: Items = [{ name: "One", _key: "optional-key" }, { name: "Old content" }];
const key: string | undefined = items[0]._key;
void key;
