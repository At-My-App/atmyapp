import { defineConfig } from "astro/config";
import { atMyAppDiagnostics } from "../../../src/diagnostics";
export default defineConfig({
  output: "static",
  integrations: [atMyAppDiagnostics()],
  vite: { ssr: { external: ["@atmyapp/core"] } },
});
