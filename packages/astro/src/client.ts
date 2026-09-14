import { createAtMyAppClient, type AtMyAppClient } from "@atmyapp/core";

export type AtMyAppWindowConfig = {
  apiKey: string;
  baseUrl: string;
  preview?: boolean;
  trackPageView?: boolean;
  previewKey?: string | null;
  dynamic?: boolean;
};

declare global {
  interface Window {
    __ATMYAPP__?: AtMyAppWindowConfig;
  }
}

let cachedClient: AtMyAppClient | null = null;
let cachedClientKey: string | null = null;

export const resetClientCache = (): void => {
  cachedClient = null;
  cachedClientKey = null;
};

export const getClient = (): AtMyAppClient => {
  if (typeof window === "undefined") {
    throw new Error("AtMyApp: getClient() called outside the browser.");
  }

  if (!window.__ATMYAPP__) {
    throw new Error(
      "AtMyApp: AtMyAppHead is missing from your layout (window.__ATMYAPP__ not found).",
    );
  }

  const { apiKey, baseUrl } = window.__ATMYAPP__;
  if (!apiKey || !baseUrl) {
    throw new Error(
      "AtMyApp: invalid window.__ATMYAPP__ config. Expected apiKey and baseUrl.",
    );
  }

  const previewKey =
    window.__ATMYAPP__.previewKey !== undefined
      ? window.__ATMYAPP__.previewKey || undefined
      : window.__ATMYAPP__.dynamic
        ? new URL(window.location.href).searchParams.get("amaPreviewKey") ||
          undefined
        : undefined;
  const nextKey = `${baseUrl}::${apiKey}::${previewKey || ""}`;
  if (!cachedClient || cachedClientKey !== nextKey) {
    cachedClient = createAtMyAppClient({
      apiKey,
      baseUrl,
      previewKey,
    });
    cachedClientKey = nextKey;
  }

  return cachedClient;
};
