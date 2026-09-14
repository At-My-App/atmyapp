/// <reference types="astro/client" />
declare module "virtual:atmyapp/config" {
  const config: { dynamic: boolean; env: Record<string, string | undefined> };
  export default config;
}
