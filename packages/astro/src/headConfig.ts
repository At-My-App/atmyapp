export type AtMyAppHeadConfig = {
  title?: string;
  description?: string;
  robots?: string;
  canonical?: string;
  sitemap?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogType?: string;
  twitterCard?: string;
  favicon?: string;
  appleTouchIcon?: string;
  themeColor?: string;
  googleSiteVerification?: string;
  jsonLd?: Record<string, unknown>;
  analyticsId?: string;
  analyticsUrl?: string;
  [key: string]: unknown;
};

export const ASTRO_FRAMEWORK = "astro" as const;
export const WEBSITE_METADATA_SYSTEM_KEY = "website.metadata" as const;

export const normalizeHeadValue = <T>(value: T): T | undefined => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  ) {
    return undefined;
  }

  return value;
};

export const hasHeadValue = (value: unknown): boolean =>
  normalizeHeadValue(value) !== undefined;
