// @ts-nocheck

import { clearHeadConfigCache, fetchHeadConfigOnce } from "../src/fetchOnce";

describe("fetchHeadConfigOnce", () => {
  beforeEach(() => {
    clearHeadConfigCache();
  });

  it("caches requests for the same baseUrl + siteId", async () => {
    const getHeadConfig = jest.fn(async () => ({ title: "Hello" }));
    const client = { meta: { getHeadConfig } } as any;

    const [first, second] = await Promise.all([
      fetchHeadConfigOnce(client, "site-a", "https://api.atmyapp.com"),
      fetchHeadConfigOnce(client, "site-a", "https://api.atmyapp.com"),
    ]);

    expect(first).toEqual({ title: "Hello" });
    expect(second).toEqual({ title: "Hello" });
    expect(getHeadConfig).toHaveBeenCalledTimes(1);
    expect(getHeadConfig).toHaveBeenCalledWith("site-a");
  });

  it("keeps separate cache entries per key", async () => {
    const getHeadConfig = jest.fn(async (siteId: string) => ({
      title: siteId,
    }));
    const client = { meta: { getHeadConfig } } as any;

    await fetchHeadConfigOnce(client, "site-a", "https://api.atmyapp.com");
    await fetchHeadConfigOnce(client, "site-a", "https://api.other.com");
    await fetchHeadConfigOnce(client, "site-b", "https://api.atmyapp.com");

    expect(getHeadConfig).toHaveBeenCalledTimes(3);
  });
});
