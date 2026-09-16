import type { AtMyAppClient } from "@atmyapp/core";
import type { AtMyAppHeadConfig } from "./headConfig.js";
let cache = new WeakMap<object, Map<string, Promise<AtMyAppHeadConfig>>>();
export function clearWebsiteMetadataCache() {
  cache = new WeakMap();
}
export function fetchWebsiteMetadataOnce(
  client: Pick<AtMyAppClient, "systemConfig">,
  _baseUrl?: string,
  systemKey = "website.metadata"
): Promise<AtMyAppHeadConfig> {
  let entries = cache.get(client);
  if (!entries) {
    entries = new Map();
    cache.set(client, entries);
  }
  const key = systemKey;
  const existing = entries.get(key);
  if (existing) return existing;
  const pending = client.systemConfig
    .get<AtMyAppHeadConfig>({ systemKey })
    .then((result) => result.config)
    .catch((error) => {
      entries!.delete(key);
      throw error;
    });
  entries.set(key, pending);
  return pending;
}
