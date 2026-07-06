/// <reference types="astro/client" />
/// <reference types="@astrojs/starlight/locals" />
/// <reference types="@astrojs/starlight/virtual" />

declare module "virtual:starlight/components/*" {
  const Component: typeof import("*.astro").default;
  export default Component;
}

