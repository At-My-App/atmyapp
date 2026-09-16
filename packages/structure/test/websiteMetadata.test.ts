import {
  compileSchema,
  validateContentAtPath,
  createDefaultWebsiteSettings,
  websiteMetadataSystemConfig,
  resolveWebsiteMetadata,
} from "../src";
const site = new URL("https://example.com/");
const url = new URL("https://preview.example/menu?amaPreviewKey=private");
const settings = {
  ...createDefaultWebsiteSettings(),
  icon: undefined,
  siteName: "Altana",
  title: "Altana — cucina i ogród",
  description: "Default description",
  image: "/sharing.jpg",
};
const resolve = (page = {}, managed = settings, fallback = {}) =>
  resolveWebsiteMetadata(page, managed, fallback, url, site);

describe("website settings", () => {
  it("compiles a framework-independent configuration with real image fields", () => {
    const compiled = compileSchema({
      version: 1,
      definitions: { websiteMetadata: websiteMetadataSystemConfig },
    });
    expect(compiled.assetFields.map((field) => field.path)).toEqual([
      "websiteMetadata.icon",
      "websiteMetadata.image",
    ]);
    expect(
      validateContentAtPath(
        compiled,
        websiteMetadataSystemConfig.path,
        JSON.stringify(settings),
        "application/json"
      ).valid
    ).toBe(true);
    expect(websiteMetadataSystemConfig).not.toHaveProperty("framework");
  });
  it("validates uploaded, committed, removed and invalid images", () => {
    const compiled = compileSchema({
      version: 1,
      definitions: { websiteMetadata: websiteMetadataSystemConfig },
    });
    const valid = (icon: unknown) =>
      validateContentAtPath(
        compiled,
        websiteMetadataSystemConfig.path,
        JSON.stringify({ ...settings, icon }),
        "application/json"
      ).valid;
    expect(valid({ data: "data:image/png;base64,YQ==" })).toBe(true);
    expect(valid({ $asset: "_assets/icon.png", sha256: "abc" })).toBe(true);
    expect(valid(null)).toBe(true);
    expect(valid({ anything: true })).toBe(false);
    expect(valid(123)).toBe(false);
  });
  it("uses server-generated icons and drops them for a page-specific source", () => {
    const managed = {
      icon: "/source.png",
      iconVariants: {
        source: "/source.png",
        favicon: "/32.png",
        appleTouchIcon: "/180.png",
        manifest: "/site.webmanifest",
      },
    };
    const resolve = (page = {}) =>
      resolveWebsiteMetadata(page, managed, {}, site, site);
    expect(resolve()).toMatchObject({
      favicon: "https://example.com/32.png",
      appleTouchIcon: "https://example.com/180.png",
      manifest: "https://example.com/site.webmanifest",
    });
    expect(resolve({ icon: "/local.png" })).toMatchObject({
      favicon: "https://example.com/local.png",
      manifest: undefined,
    });
    expect(resolve({ icon: null })).toMatchObject({
      favicon: null,
      manifest: undefined,
    });
  });
  it("leaves the default title intact and formats page titles", () => {
    expect(resolve().title).toBe("Altana — cucina i ogród");
    expect(resolve({ title: "Menu" }).title).toBe("Menu · Altana");
    expect(resolve({ title: "Altana" }).title).toBe("Altana");
    expect(resolve({ title: "Menu", titleMode: "absolute" }).title).toBe(
      "Menu"
    );
    expect(
      resolve({ title: "Menu" }, { ...settings, appendSiteName: false }).title
    ).toBe("Menu");
  });
  it("derives social values from the resolved page before applying intentional clears", () => {
    const result = resolve({
      title: "Menu",
      description: null,
      image: "/menu.jpg",
    });
    expect(result.ogTitle).toBe("Menu · Altana");
    expect(result.ogDescription).toBeNull();
    expect(result.ogImage).toBe("https://example.com/menu.jpg");
    expect(resolve({ ogImage: null }).ogImage).toBeNull();
  });
  it("ignores disabled custom sharing text but preserves it for re-enabling", () => {
    const managed = {
      ...settings,
      ogTitle: "Sharing title",
      ogDescription: "Sharing description",
    };
    expect(resolve({ title: "Menu" }, managed).ogTitle).toBe("Menu · Altana");
    expect(resolve({}, { ...managed, customizeSharing: true }).ogTitle).toBe(
      "Sharing title"
    );
    expect(
      resolve(
        { ogTitle: "Page sharing" },
        { ...managed, customizeSharing: true }
      ).ogTitle
    ).toBe("Page sharing");
  });
  it("uses page then managed then local fallback and keeps null distinct from empty", () => {
    const managed = { ...settings, description: "" };
    expect(resolve({}, managed, { description: "Local" }).description).toBe(
      "Local"
    );
    expect(
      resolve({ description: "Page" }, managed, { description: "Local" })
        .description
    ).toBe("Page");
    expect(
      resolve({ description: null }, managed, { description: "Local" })
        .description
    ).toBeNull();
  });
  it("creates basic website structured data only at the production homepage", () => {
    expect(resolve().jsonLd).toBeUndefined();
    expect(
      resolveWebsiteMetadata(
        {},
        settings,
        {},
        new URL("https://preview.example/"),
        site
      ).jsonLd
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Altana",
      url: "https://example.com/",
    });
    expect(
      resolveWebsiteMetadata({ jsonLd: null }, settings, {}, site, site).jsonLd
    ).toBeNull();
  });
  it("uses production canonical URLs and excludes previews from indexing", () => {
    const result = resolveWebsiteMetadata({}, settings, {}, url, site, true);
    expect(result.canonical).toBe("https://example.com/menu");
    expect(result.robots).toBe("noindex, nofollow");
  });
});
