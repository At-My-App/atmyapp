import { defineSystemConfig, s } from './builder';

const optionalString = (description: string) =>
  s.string({
    description,
    optional: true,
    default: '',
  });

export const astroWebsiteMetadataSystemConfig = defineSystemConfig({
  description: 'Framework-managed website metadata for Astro sites.',
  framework: 'astro',
  systemKey: 'website.metadata',
  displayName: 'Website Configuration - Astro Metadata',
  path: '_SystemConfig/astro/website-metadata.json',
  managedBy: 'framework_preset',
  fields: {
    title: optionalString('Document title'),
    description: optionalString('Meta description'),
    robots: optionalString('Robots directives'),
    canonical: optionalString('Canonical URL'),
    sitemap: optionalString('Sitemap path or URL'),
    ogTitle: optionalString('Open Graph title'),
    ogDescription: optionalString('Open Graph description'),
    ogImage: optionalString('Open Graph image URL'),
    ogType: optionalString('Open Graph type'),
    twitterCard: optionalString('Twitter card type'),
    favicon: optionalString('Favicon path'),
    appleTouchIcon: optionalString('Apple touch icon path'),
    themeColor: optionalString('Theme color'),
    googleSiteVerification: optionalString('Google site verification token'),
    analyticsId: optionalString('AtMyApp analytics site id'),
    analyticsUrl: optionalString('AtMyApp analytics endpoint'),
    jsonLd: s.object({
      description: 'Structured data object (JSON-LD)',
      optional: true,
      default: {},
      additionalProperties: true,
      fields: {},
    }),
  },
});

export const frameworkSystemConfigs = {
  astro: {
    websiteMetadata: astroWebsiteMetadataSystemConfig,
  },
} as const;

export const frameworkPresets = {
  astro: {
    systemConfigDefinitions: ['astroWebsiteMetadata'],
  },
} as const;
