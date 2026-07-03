interface ImportMetaEnv {
  readonly ATMYAPP_API_KEY?: string;
  readonly ATMYAPP_BASE_URL?: string;
  readonly DEV_MODE?: string;
  readonly DEV?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "@atmyapp/astro/client" {
  export { getClient } from "./client";
  export type { AtMyAppWindowConfig } from "./client";
}
