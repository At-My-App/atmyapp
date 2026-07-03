export { getClient } from "./client";
export { fetchWebsiteMetadataOnce } from "./websiteMetadata";

export type { AtMyAppWindowConfig } from "./client";
export type { AtMyAppClient } from "@atmyapp/core";
export type { AtMyAppHeadConfig } from "./headConfig";

export type ConflictStrategy = "atmyapp-wins" | "local-wins" | "merge";
