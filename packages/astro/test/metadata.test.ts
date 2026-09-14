import { resolveMetadata, safeJson } from "../src/metadata";
import {
  fetchWebsiteMetadataOnce,
  clearWebsiteMetadataCache,
} from "../src/websiteMetadata";
it("resolves page metadata and intentional clears before social defaults", () => {
  const value = resolveMetadata(
    { title: "Page", description: null },
    { title: "Website", titleTemplate: "%s | Brand" },
    { description: "Fallback" },
    new URL("https://preview.example/post?amaPreviewKey=secret"),
    new URL("https://site.example"),
    true,
  );
  expect(value.title).toBe("Page | Brand");
  expect(value.ogTitle).toBe(value.title);
  expect(value.description).toBeNull();
  expect(value.ogDescription).toBeNull();
  expect(value.canonical).toBe("https://site.example/post");
  expect(value.robots).toBe("noindex, nofollow");
});
it("serializes untrusted JSON without allowing a script closing tag", () => {
  const input = { text: "</script><script>alert(1)</script>" };
  const json = safeJson(input);
  expect(json).not.toContain("<");
  expect(JSON.parse(json)).toEqual(input);
});
it("isolates clients and retries failed metadata reads", async () => {
  clearWebsiteMetadataCache();
  const get = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ config: { title: "A" } });
  const a = { systemConfig: { get } } as any;
  const b = {
    systemConfig: { get: jest.fn(async () => ({ config: { title: "B" } })) },
  } as any;
  await expect(fetchWebsiteMetadataOnce(a)).rejects.toThrow("offline");
  expect(await fetchWebsiteMetadataOnce(a)).toEqual({ title: "A" });
  expect(await fetchWebsiteMetadataOnce(b)).toEqual({ title: "B" });
  await fetchWebsiteMetadataOnce(a);
  expect(get).toHaveBeenCalledTimes(2);
});

it("inherits empty managed structured data and whitespace values", () => {
  const result = resolveMetadata(
    {},
    { title: "   ", jsonLd: {} },
    { title: "Fallback", jsonLd: { name: "Brand" } },
    new URL("https://site.example"),
  );
  expect(result.title).toBe("Fallback");
  expect(result.jsonLd).toEqual({ name: "Brand" });
});
