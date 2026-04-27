import { createFetch } from "@better-fetch/fetch";
import { AtMyAppClientOptions } from "./clientTypes";

const buildSystemConfigError = (
  framework: string,
  systemKey: string,
  status: number | string,
  message: string,
): Error =>
  new Error(
    `AtMyApp: failed to fetch system config "${framework}/${systemKey}". ` +
      `Status: ${status}. ` +
      `Message: ${message}`,
  );

export type SystemConfigGetInput = {
  framework: string;
  systemKey: string;
};

export type SystemConfigResponse<TConfig = Record<string, unknown>> = {
  framework: string;
  systemKey: string;
  displayName: string;
  path: string;
  config: TConfig;
};

export interface SystemConfigClient {
  get<TConfig = Record<string, unknown>>(
    input: SystemConfigGetInput,
  ): Promise<SystemConfigResponse<TConfig>>;
}

export const createSystemConfigClient = (
  clientOptions: AtMyAppClientOptions,
): SystemConfigClient => {
  const $fetch = createFetch({
    baseURL: `${clientOptions.baseUrl}/system-config`,
    auth: {
      type: "Bearer",
      token: clientOptions.apiKey,
    },
    fetch: clientOptions.customFetch,
  });

  const get = async <TConfig = Record<string, unknown>>({
    framework,
    systemKey,
  }: SystemConfigGetInput): Promise<SystemConfigResponse<TConfig>> => {
    try {
      const response = await $fetch<{
        success: boolean;
        data: SystemConfigResponse<TConfig>;
        error?: string;
      }>(`/${encodeURIComponent(framework)}/${encodeURIComponent(systemKey)}`);

      if (response.error || !response.data?.success) {
        throw buildSystemConfigError(
          framework,
          systemKey,
          response.error?.status ?? "unknown",
          response.error?.message ?? response.data?.error ?? "unknown",
        );
      }

      return response.data.data;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith(
          `AtMyApp: failed to fetch system config "${framework}/${systemKey}"`,
        )
      ) {
        throw error;
      }

      throw buildSystemConfigError(
        framework,
        systemKey,
        "unknown",
        error instanceof Error ? error.message : "unknown",
      );
    }
  };

  return { get };
};
