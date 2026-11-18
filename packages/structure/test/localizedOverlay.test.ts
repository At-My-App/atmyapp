import {
  buildLocalizedDocumentOverlay,
  collectVariantSourceHashes,
  countOutdatedVariantPaths,
  mergeVariantOverlay,
  s,
  type FieldDefinition,
} from "../src";

const fields = {
  title: s.string({ localize: true }),
  slug: s.string(),
  blocks: s.array({
    identityField: "code",
    items: s.object({
      fields: {
        code: s.string(),
        label: s.string({ localize: true }),
        layout: s.string(),
      },
    }),
  }),
};
const definition: FieldDefinition = { kind: "object", fields };
const source = {
  title: "Menu",
  slug: "menu",
  blocks: [
    { code: "a.1", label: "Lunch", layout: "wide" },
    { code: "b/2", label: "Dinner", layout: "narrow" },
  ],
};

test("matches the server's document overlay and raw source history", () => {
  const translated = {
    ...source,
    title: "Speisekarte",
    blocks: [{ ...source.blocks[0], label: "Mittagessen" }, source.blocks[1]],
  };
  const raw = buildLocalizedDocumentOverlay(fields, source, translated);
  expect(raw).toEqual({ title: "Speisekarte", blocks: [{ code: "a.1", label: "Mittagessen" }] });
  expect(mergeVariantOverlay(source, raw, definition)).toEqual(translated);

  const hashes = collectVariantSourceHashes(source, raw, "", {}, definition);
  expect(hashes).toEqual({ title: '"Menu"', "blocks[code=a.1].label": '"Lunch"' });
  expect(countOutdatedVariantPaths(source, hashes)).toBe(0);
  expect(
    countOutdatedVariantPaths(
      { ...source, blocks: [source.blocks[1], { ...source.blocks[0], label: "Brunch" }] },
      hashes,
    ),
  ).toBe(1);
});

test("rejects changed source-only fields and unknown array identities", () => {
  expect(() => buildLocalizedDocumentOverlay(fields, source, { ...source, slug: "another-slug" })).toThrow(
    "not localizable",
  );
  expect(() =>
    buildLocalizedDocumentOverlay(fields, source, { ...source, blocks: [{ code: "unknown", label: "Missing" }] }),
  ).toThrow("does not match an existing item");
});
