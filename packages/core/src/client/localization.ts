import { createFetch } from "@better-fetch/fetch";
import type {
  AtMyAppClientOptions,
  CollectionLocalizationSummary,
  LocalizationDiscovery,
  LocalizationClient,
  LocalizationStatus,
} from "./clientTypes";

type SuccessResponse<T> = {
  success: boolean;
  data: T;
};

export function createLocalizationClient(
  clientOptions: AtMyAppClientOptions,
): LocalizationClient {
  const $fetch = createFetch({
    baseURL: clientOptions.baseUrl,
    auth: {
      type: "Bearer",
      token: clientOptions.apiKey,
    },
    fetch: clientOptions.customFetch,
  });

  async function getData<T>(path: string, params: Record<string, string>) {
    const response = (await $fetch<SuccessResponse<T>>(path, { params })) as {
      data?: SuccessResponse<T>;
      error?: unknown;
    };
    if (!response.data?.success) {
      throw new Error("Localization discovery request failed");
    }
    return response.data.data;
  }

  return {
    getStorageLocales(path: string) {
      return getData<LocalizationDiscovery<LocalizationStatus>>(
        "/storage/locales/:path",
        { path },
      );
    },
    getCollectionLocales(collection: string) {
      return getData<LocalizationDiscovery<CollectionLocalizationSummary>>(
        "/collections/:collection/locales",
        { collection },
      );
    },
    getCollectionEntryLocales(collection: string, entryId: string | number) {
      return getData<LocalizationDiscovery<LocalizationStatus>>(
        "/collections/:collection/entries/:entryId/locales",
        { collection, entryId: String(entryId) },
      );
    },
  };
}
