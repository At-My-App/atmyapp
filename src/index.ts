export { getClient } from "./client";
export { fetchHeadConfigOnce } from "./fetchOnce";

export type { AtMyAppWindowConfig } from "./client";
export type { AtMyAppHeadConfig, AtMyAppClient } from "@atmyapp/core";

export type ConflictStrategy = "atmyapp-wins" | "local-wins" | "merge";
