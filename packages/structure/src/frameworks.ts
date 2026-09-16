import {
  websiteMetadataSystemConfig,
  WEBSITE_METADATA_SYSTEM_KEY,
} from "./websiteMetadata";
export const systemConfigRegistry = {
  [WEBSITE_METADATA_SYSTEM_KEY]: websiteMetadataSystemConfig,
} as const;
export const frameworkPresets = {
  astro: { systemConfigs: [WEBSITE_METADATA_SYSTEM_KEY] },
} as const;
