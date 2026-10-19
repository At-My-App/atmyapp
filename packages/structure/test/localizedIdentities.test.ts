import {
  pruneDeletedItemTranslations,
  validateLocalizedItemIdentities,
  validateLocalizedOverlayFields,
  type DocumentDefinition,
} from "../src";

const definition: DocumentDefinition = {
  kind: "document",
  path: "home.json",
  fields: {
    title: { kind: "scalar", scalar: "string", localize: true },
    color: { kind: "scalar", scalar: "string" },
    cards: {
      kind: "array",
      items: {
        kind: "object",
        fields: {
          label: { kind: "scalar", scalar: "string", localize: true },
          link: { kind: "scalar", scalar: "string" },
        },
      },
    },
  },
};
const source = (...keys: string[]) => ({
  cards: keys.map((key) => ({ _key: key, label: key, link: "/" })),
});

describe("pruneDeletedItemTranslations", () => {
  const overlay = {
    title: "Tytuł",
    cards: [
      { _key: "a", label: "A pl" },
      { _key: "b", label: "B pl" },
    ],
  };

  it("removes the translation of an item the source deleted", () => {
    const result = pruneDeletedItemTranslations(
      overlay,
      definition,
      { previous: source("a", "b"), next: source("a") },
      overlay,
    );
    expect(result).toEqual({
      changed: true,
      value: { title: "Tytuł", cards: [{ _key: "a", label: "A pl" }] },
    });
    expect(
      validateLocalizedItemIdentities(result.value, definition, source("a")),
    ).toEqual([]);
  });

  it("keeps a new translation of a deleted item, so it is still rejected", () => {
    const result = pruneDeletedItemTranslations(
      overlay,
      definition,
      { previous: source("a", "b"), next: source("a") },
      { cards: [{ _key: "a", label: "A pl" }] },
    );
    expect(result.changed).toBe(false);
    expect(
      validateLocalizedItemIdentities(result.value, definition, source("a")),
    ).toHaveLength(1);
  });

  it("leaves identities the previous source never had", () => {
    const stray = { cards: [{ _key: "x", label: "?" }] };
    expect(
      pruneDeletedItemTranslations(
        stray,
        definition,
        { previous: source("a"), next: source("a") },
        stray,
      ).changed,
    ).toBe(false);
  });
});

describe("validateLocalizedOverlayFields", () => {
  it("allows localized fields and item identities", () => {
    expect(
      validateLocalizedOverlayFields(
        { title: "Tytuł", cards: [{ _key: "a", label: "A pl" }] },
        definition,
      ),
    ).toEqual([]);
  });

  it("rejects fields that are not translated", () => {
    expect(
      validateLocalizedOverlayFields(
        { color: "red", cards: [{ _key: "a", link: "/pl" }], extra: 1 },
        definition,
      ).map((issue) => [issue.code, issue.path, issue.severity]),
    ).toEqual([
      ["not-localizable", "color", "hard"],
      ["not-localizable", "cards.0.link", "hard"],
      ["not-localizable", "extra", "hard"],
    ]);
  });
});
