import { hasMetadataValue } from "@atmyapp/core";
export type { Metadata as AtMyAppHeadConfig } from "@atmyapp/core";
export { WEBSITE_METADATA_SYSTEM_KEY } from "@atmyapp/core";
export const normalizeHeadValue = <T>(value: T): T | undefined =>
  hasMetadataValue(value) ? value : undefined;
export const hasHeadValue = hasMetadataValue;
