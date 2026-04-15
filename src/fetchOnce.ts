import type { AtMyAppClient, AtMyAppHeadConfig } from "@atmyapp/core";

const headConfigCache = new Map<string, Promise<AtMyAppHeadConfig>>();

export const getHeadConfigCacheKey = (baseUrl: string, siteId: string): string => {
  return `${baseUrl}::${siteId}`;
};

export const clearHeadConfigCache = (): void => {
  headConfigCache.clear();
};

export const fetchHeadConfigOnce = (
  client: Pick<AtMyAppClient, "meta">,
  siteId: string,
  baseUrl: string
): Promise<AtMyAppHeadConfig> => {
  const cacheKey = getHeadConfigCacheKey(baseUrl, siteId);
  const existing = headConfigCache.get(cacheKey);

  if (existing) {
    return existing;
  }

  const pending = client.meta.getHeadConfig(siteId);
  headConfigCache.set(cacheKey, pending);
  return pending;
};
