import type { AtMyAppHeadConfig } from "./headConfig.js";
export type Metadata = {
  [K in keyof AtMyAppHeadConfig]?: AtMyAppHeadConfig[K] | null;
};
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
export function resolveMetadata(
  page: Metadata,
  managed: Metadata,
  fallback: Metadata,
  url: URL,
  site?: URL,
  preview = false,
): Metadata {
  const out: Metadata = {};
  for (const source of [fallback, managed, page])
    for (const [key, value] of Object.entries(source)) {
      if (
        value !== undefined &&
        !(typeof value === "string" && !value.trim()) &&
        !(
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value).length === 0
        )
      )
        out[key] = value;
    }
  const title = out.title;
  if (typeof title === "string" && typeof out.titleTemplate === "string")
    out.title = out.titleTemplate.replace(/%s/g, title);
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
  for (const key of ["ogImage", "favicon", "appleTouchIcon", "sitemap"])
    if (typeof out[key] === "string") {
      const value = out[key] as string;
      if (site) out[key] = new URL(value, site).toString();
    }
  if (preview) out.robots = "noindex, nofollow";
  return out;
}
