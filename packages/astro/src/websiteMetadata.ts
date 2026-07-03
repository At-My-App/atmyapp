import type { AtMyAppClient } from "@atmyapp/core";
import {
  ASTRO_FRAMEWORK,
  type AtMyAppHeadConfig,
  WEBSITE_METADATA_SYSTEM_KEY,
} from "./headConfig";

const websiteMetadataCache = new Map<string, Promise<AtMyAppHeadConfig>>();

export const getWebsiteMetadataCacheKey = (
  baseUrl: string,
  framework = ASTRO_FRAMEWORK,
  systemKey = WEBSITE_METADATA_SYSTEM_KEY
): string => {
  return `${baseUrl}::${framework}::${systemKey}`;
};

export const clearWebsiteMetadataCache = (): void => {
  websiteMetadataCache.clear();
};

export const fetchWebsiteMetadataOnce = (
  client: Pick<AtMyAppClient, "systemConfig">,
  baseUrl: string,
  framework = ASTRO_FRAMEWORK,
  systemKey = WEBSITE_METADATA_SYSTEM_KEY
): Promise<AtMyAppHeadConfig> => {
  const cacheKey = getWebsiteMetadataCacheKey(baseUrl, framework, systemKey);
  const existing = websiteMetadataCache.get(cacheKey);

  if (existing) {
    return existing;
  }

  const pending = client.systemConfig
    .get<AtMyAppHeadConfig>({ framework, systemKey })
    .then((response) => response.config);
  websiteMetadataCache.set(cacheKey, pending);
  return pending;
};
