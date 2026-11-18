import type { FieldDefinition } from "@atmyapp/structure";
import { mergeContent } from "../../src/runtime/merge";

const key = (_key: string, title = _key, order?: number) => ({
  _key,
  title,
  ...(order === undefined ? {} : { order }),
});
const custom: FieldDefinition = { kind: "array", identityField: "code", items: { kind: "object", fields: {} } };
const pair = (code: number, text: string, info?: number) => ({ code, text, ...(info ? { info } : {}) });

type Case = [string, unknown, unknown, unknown, unknown, string[], FieldDefinition?];
const cases: Case[] = [
  ["unchanged", 1, 1, 1, 1, []],
  ["theirs changed", 1, 1, 2, 2, []],
  ["ours changed", 1, 2, 1, 2, []],
  ["both agree", 1, 2, 2, 2, []],
  ["scalar conflict", 1, 2, 3, 2, [""]],
  ["null is a value", 1, null, 3, null, [""]],
  ["ours added", undefined, 1, undefined, 1, []],
  ["theirs added", undefined, undefined, 1, 1, []],
  ["same addition", undefined, 1, 1, 1, []],
  ["different addition", undefined, 1, 2, 1, [""]],
  ["ours deleted", 1, undefined, 1, undefined, []],
  ["theirs deleted", 1, 1, undefined, undefined, []],
  ["both deleted", 1, undefined, undefined, undefined, []],
  ["delete versus edit", 1, undefined, 2, undefined, [""]],
  ["edit versus delete", 1, 2, undefined, 2, [""]],
  ["different fields", { a: 1, b: 2 }, { a: 3, b: 2 }, { a: 1, b: 4 }, { a: 3, b: 4 }, []],
  ["nested fields", { a: { b: 1, c: 2 } }, { a: { b: 3, c: 2 } }, { a: { b: 1, c: 4 } }, { a: { b: 3, c: 4 } }, []],
  ["nested removal", { a: { b: 1 } }, { a: {} }, { a: { b: 3 } }, { a: {} }, ["/a/b"]],
  ["object addition merges", undefined, { a: 1 }, { b: 2 }, { a: 1, b: 2 }, []],
  ["object replaced with scalar", { a: 1 }, false, { a: 2 }, false, [""]],
  ["pointer escaping", { "a~/": 1 }, { "a~/": 2 }, { "a~/": 3 }, { "a~/": 2 }, ["/a~0~1"]],
  ["key order ignored", { a: 1, b: 2 }, { b: 2, a: 1 }, { a: 2 }, { a: 2 }, []],
  ["atomic primitive array", [0, 1], [1, 1], [0, 2], [1, 1], [""]],
  ["atomic non-keyed objects", [{ a: 1 }], [{ a: 2 }], [{ a: 3 }], [{ a: 2 }], [""]],
  ["duplicate identities", [key("a")], [key("a"), key("a")], [key("a", "server")], [key("a"), key("a")], [""]],
  ["keyed distinct edits", [key("a")], [key("a", "local")], [key("a", "a", 1)], [key("a", "local", 1)], []],
  ["keyed same field", [key("a")], [key("a", "local")], [key("a", "server")], [key("a", "local")], ["/_key=a/title"]],
  [
    "keyed remove unchanged",
    [key("a"), key("b")],
    [key("b")],
    [key("b", "server"), key("a")],
    [key("b", "server")],
    [],
  ],
  ["keyed remove versus edit", [key("a")], [], [key("a", "server")], [], ["/_key=a"]],
  ["keyed edit versus remove", [key("a")], [key("a", "local")], [], [key("a", "local")], ["/_key=a"]],
  [
    "insertion after predecessor",
    [key("a"), key("b")],
    [key("a"), key("c"), key("b")],
    [key("b"), key("a")],
    [key("b"), key("a"), key("c")],
    [],
  ],
  ["insertion at start", [key("a")], [key("b"), key("a")], [key("a"), key("c")], [key("b"), key("a"), key("c")], []],
  [
    "insertions with missing predecessor",
    [key("a"), key("b")],
    [key("a"), key("c"), key("b")],
    [key("b")],
    [key("c"), key("b")],
    [],
  ],
  [
    "escaped item identity",
    [key("a/b")],
    [key("a/b", "mine")],
    [key("a/b", "new")],
    [key("a/b", "mine")],
    ["/_key=a%2Fb/title"],
  ],
  ["custom numeric identity", [pair(7, "old")], [pair(7, "new")], [pair(7, "old", 4)], [pair(7, "new", 4)], [], custom],
];

for (const [name, base, ours, theirs, expected, pointers, schema] of cases) {
  test(name, () => {
    const result = mergeContent(base, ours, theirs, schema);
    expect(result.value).toEqual(expected);
    expect(result.conflicts.map(({ pointer }) => pointer)).toEqual(pointers);
  });
}

test("per-field choices preserve unrelated edits", () => {
  expect(mergeContent({ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }, undefined, new Map([["/x", "theirs"]]))).toEqual({
    value: { x: 3, y: 2 },
    conflicts: [],
  });
});
