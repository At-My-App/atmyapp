import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import atmyapp from "@atmyapp/astro";
export default defineConfig({
  site: "https://website.example",
  adapter:
    process.env.ASTRO_TEST_SSR === "1"
      ? node({ mode: "standalone" })
      : undefined,
  integrations: [atmyapp({ diagnostics: true })],
  vite: { ssr: { external: ["@atmyapp/core"] } },
});
