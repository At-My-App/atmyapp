// @ts-nocheck

import {
  clearWebsiteMetadataCache,
  fetchWebsiteMetadataOnce,
} from "../src/websiteMetadata";

describe("fetchWebsiteMetadataOnce", () => {
  beforeEach(() => {
    clearWebsiteMetadataCache();
  });

  it("caches requests for the same baseUrl + system config key", async () => {
    const getSystemConfig = jest.fn(async () => ({
      config: { title: "Hello" },
    }));
    const client = { systemConfig: { get: getSystemConfig } } as any;

    const [first, second] = await Promise.all([
      fetchWebsiteMetadataOnce(client, "https://api.atmyapp.com"),
      fetchWebsiteMetadataOnce(client, "https://api.atmyapp.com"),
    ]);

    expect(first).toEqual({ title: "Hello" });
    expect(second).toEqual({ title: "Hello" });
    expect(getSystemConfig).toHaveBeenCalledTimes(1);
    expect(getSystemConfig).toHaveBeenCalledWith({
      framework: "astro",
      systemKey: "website.metadata",
    });
  });

  it("keeps separate cache entries per key", async () => {
    const getSystemConfig = jest.fn(async ({ systemKey }: { systemKey: string }) => ({
      config: { title: systemKey },
    }));
    const client = { systemConfig: { get: getSystemConfig } } as any;

    await fetchWebsiteMetadataOnce(client, "https://api.atmyapp.com");
    await fetchWebsiteMetadataOnce(client, "https://api.other.com");
    await fetchWebsiteMetadataOnce(
      client,
      "https://api.atmyapp.com",
      "astro",
      "website.other"
    );

    expect(getSystemConfig).toHaveBeenCalledTimes(3);
  });
});
