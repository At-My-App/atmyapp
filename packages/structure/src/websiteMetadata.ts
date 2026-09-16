import { defineSystemConfig, s } from "./builder";
import type { FieldDefinition } from "./types";

export const SYSTEM_CONFIG_ROOT = "_SystemConfig";
export const WEBSITE_METADATA_SYSTEM_KEY = "website.metadata";
export const WEBSITE_METADATA_DEFINITION_NAME = "websiteMetadata";
export const WEBSITE_METADATA_PATH = "_SystemConfig/website/metadata.json";
export const WEBSITE_METADATA_DISPLAY_NAME = "Website settings";

export type WebsiteImage =
  | null
  | string
  | { data: string; name?: string; type?: string }
  | { __blob: string }
  | {
      $asset: string;
      sha256?: string;
      mime?: string;
      size?: number;
      name?: string;
    };
export interface WebsiteSettings {
  siteName: string;
  title: string;
  description: string;
  appendSiteName: boolean;
  icon?: WebsiteImage;
  image?: WebsiteImage;
  customizeSharing: boolean;
  ogTitle: string;
  ogDescription: string;
}

const text = (description: string) =>
  s.string({ description, optional: true, default: "" });
export const websiteMetadataSystemConfig = defineSystemConfig({
  name: WEBSITE_METADATA_DEFINITION_NAME,
  systemKey: WEBSITE_METADATA_SYSTEM_KEY,
  displayName: WEBSITE_METADATA_DISPLAY_NAME,
  path: WEBSITE_METADATA_PATH,
  managedBy: "framework_preset",
  description: "Your website identity, search appearance, and shared links.",
  fields: {
    siteName: text("Website name"),
    title: text("Default page title"),
    description: text("Default description"),
    appendSiteName: s.boolean({
      description: "Add website name to page titles",
      default: true,
      optional: true,
    }),
    icon: s.image({
      description: "Website icon",
      optional: true,
      config: { ratioHint: { x: 1, y: 1 }, optimizeFormat: "none" },
    }),
    image: s.image({
      description: "Sharing image",
      optional: true,
      config: { ratioHint: { x: 191, y: 100 } },
    }),
    customizeSharing: s.boolean({
      description: "Use different text for shared links",
      default: false,
      optional: true,
    }),
    ogTitle: text("Sharing title"),
    ogDescription: text("Sharing description"),
  },
});

/** Shared schema-derived defaults; callers receive independent objects. */
export function buildDefaultsFromFields(
  fields: Record<string, FieldDefinition>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.default !== undefined) out[key] = structuredClone(field.default);
    else if (field.kind === "object")
      out[key] = buildDefaultsFromFields(field.fields);
  }
  return out;
}
export const createDefaultWebsiteSettings = (): WebsiteSettings =>
  buildDefaultsFromFields(
    websiteMetadataSystemConfig.fields
  ) as unknown as WebsiteSettings;

export type Metadata = {
  title?: string | null;
  description?: string | null;
  siteName?: string | null;
  appendSiteName?: boolean;
  titleMode?: "template" | "absolute";
  titleTemplate?: string | null;
  icon?: string | null;
  iconVariants?: {
    source: string;
    favicon?: string;
    appleTouchIcon?: string;
    manifest?: string;
  };
  manifest?: string | null;
  image?: string | null;
  customizeSharing?: boolean;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  ogType?: string | null;
  twitterCard?: string | null;
  canonical?: string | null;
  robots?: string | null;
  sitemap?: string | null;
  favicon?: string | null;
  appleTouchIcon?: string | null;
  themeColor?: string | null;
  googleSiteVerification?: string | null;
  jsonLd?: Record<string, unknown> | null;
};

export function hasMetadataValue(value: unknown): boolean {
  return (
    value !== undefined &&
    !(typeof value === "string" && !value.trim()) &&
    !(
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    )
  );
}
export function safeMetadataJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/** Page overrides win per field, then site defaults, then local fallbacks. */
export function resolveWebsiteMetadata(
  page: Metadata,
  managed: Metadata,
  fallback: Metadata,
  url: URL,
  site?: URL,
  preview = false
): Metadata {
  const out: Metadata = {};
  for (const [sourceIndex, source] of [fallback, managed, page].entries()) {
    for (const [key, value] of Object.entries(source)) {
      if (
        sourceIndex === 1 &&
        managed.customizeSharing === false &&
        ["ogTitle", "ogDescription"].includes(key)
      )
        continue;
      if (hasMetadataValue(value))
        (out as Record<string, unknown>)[key] = value;
    }
  }
  if (typeof out.title === "string" && page.titleMode !== "absolute") {
    if (typeof out.titleTemplate === "string")
      out.title = out.titleTemplate.replace(/%s/g, out.title);
    else if (
      typeof page.title === "string" &&
      page.title.trim() &&
      out.appendSiteName !== false &&
      typeof out.siteName === "string" &&
      out.siteName.trim() &&
      out.title !== out.siteName
    )
      out.title = `${out.title} · ${out.siteName}`;
  }
  if (out.canonical === undefined && site)
    out.canonical = new URL(url.pathname, site).toString();
  if (typeof out.canonical === "string") {
    const canonical = new URL(out.canonical, site ?? url);
    canonical.searchParams.delete("amaPreviewKey");
    canonical.hash = "";
    out.canonical = canonical.toString();
  }
  if (out.ogTitle === undefined) out.ogTitle = out.title;
  if (out.ogDescription === undefined) out.ogDescription = out.description;
  if (out.ogImage === undefined) out.ogImage = out.image;
  if (out.ogType === undefined) out.ogType = "website";
  if (out.twitterCard === undefined)
    out.twitterCard = out.ogImage ? "summary_large_image" : "summary";
  const variants =
    out.iconVariants?.source === out.icon ? out.iconVariants : undefined;
  if (out.favicon === undefined) out.favicon = variants?.favicon ?? out.icon;
  if (out.appleTouchIcon === undefined)
    out.appleTouchIcon = variants?.appleTouchIcon ?? out.icon;
  if (out.manifest === undefined) out.manifest = variants?.manifest;
  for (const key of [
    "icon",
    "ogImage",
    "favicon",
    "appleTouchIcon",
    "sitemap",
    "manifest",
  ] as const) {
    const value = out[key];
    if (typeof value === "string" && site)
      out[key] = new URL(value, site).toString();
  }
  if (
    out.jsonLd === undefined &&
    site &&
    url.pathname === site.pathname &&
    out.siteName
  ) {
    out.jsonLd = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: out.siteName,
      url: site.toString(),
    };
  }
  if (preview) out.robots = "noindex, nofollow";
  return out;
}
