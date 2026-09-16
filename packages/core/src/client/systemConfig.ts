import { createFetch } from "@better-fetch/fetch";
import { AtMyAppClientOptions } from "./clientTypes";

const buildSystemConfigError = (
  systemKey: string,
  status: number | string,
  message: string
): Error =>
  new Error(
    `AtMyApp: failed to fetch system config "${systemKey}". ` +
      `Status: ${status}. ` +
      `Message: ${message}`
  );

export type SystemConfigGetInput = {
  systemKey: string;
};

export type SystemConfigResponse<TConfig = Record<string, unknown>> = {
  systemKey: string;
  displayName: string;
  path: string;
  config: TConfig;
};

export interface SystemConfigClient {
  get<TConfig = Record<string, unknown>>(
    input: SystemConfigGetInput
  ): Promise<SystemConfigResponse<TConfig>>;
}

export const createSystemConfigClient = (
  clientOptions: AtMyAppClientOptions
): SystemConfigClient => {
  const $fetch = createFetch({
    baseURL: `${clientOptions.baseUrl}/system-config`,
    auth: {
      type: "Bearer",
      token: clientOptions.apiKey,
    },
    customFetchImpl: clientOptions.customFetch,
  });

  const get = async <TConfig = Record<string, unknown>>({
    systemKey,
  }: SystemConfigGetInput): Promise<SystemConfigResponse<TConfig>> => {
    try {
      const response = await $fetch<{
        success: boolean;
        data: SystemConfigResponse<TConfig>;
        error?: string;
      }>(`/${encodeURIComponent(systemKey)}`, {
        query: clientOptions.previewKey
          ? { amaPreviewKey: clientOptions.previewKey }
          : undefined,
        headers: { "Cache-Control": "no-store" },
      });

      if (response.error || !response.data?.success) {
        throw buildSystemConfigError(
          systemKey,
          response.error?.status ?? "unknown",
          response.error?.message ?? response.data?.error ?? "unknown"
        );
      }

      return response.data.data;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith(
          `AtMyApp: failed to fetch system config "${systemKey}"`
        )
      ) {
        throw error;
      }

      throw buildSystemConfigError(
        systemKey,
        "unknown",
        error instanceof Error ? error.message : "unknown"
      );
    }
  };

  return { get };
};
