import type { AstroIntegration } from "astro";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { resolveDevMode, type Environment } from "./config.js";
export type AtMyAppIntegrationOptions = {
  apiKey?: string;
  baseUrl?: string;
  diagnostics?: boolean;
};
export default function atmyapp(
  options: AtMyAppIntegrationOptions = {},
): AstroIntegration {
  let dynamic = false;
  return {
    name: "@atmyapp/astro",
    hooks: {
      "astro:config:setup": ({
        config,
        command,
        updateConfig,
        injectRoute,
      }) => {
        const env: Environment = {};
        const mode = command === "dev" ? "development" : "production";
        for (const name of [
          ".env",
          ".env.local",
          `.env.${mode}`,
          `.env.${mode}.local`,
        ]) {
          try {
            Object.assign(
              env,
              parseEnv(readFileSync(new URL(name, config.root), "utf8")),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        Object.assign(env, process.env);
        dynamic = resolveDevMode(env, command === "dev");
        const defaults = {
          dynamic,
          env: Object.fromEntries(
            [
              "ATMYAPP_API_KEY",
              "ATMYAPP_BASE_URL",
              "ATMYAPP_API_URL",
              "ATMYAPP_PREVIEW_KEY",
              "ATMYAPP_CODE_COMMIT",
              "ATMYAPP_BUILD_TIME",
            ].map((key) => [key, env[key]]),
          ),
        };
        if (options.apiKey !== undefined)
          defaults.env.ATMYAPP_API_KEY = options.apiKey;
        if (options.baseUrl !== undefined)
          defaults.env.ATMYAPP_BASE_URL = options.baseUrl;
        updateConfig({
          output: dynamic ? "server" : "static",
          vite: {
            plugins: [
              {
                name: "atmyapp-config",
                resolveId(id) {
                  if (id === "virtual:atmyapp/config")
                    return "\0virtual:atmyapp/config";
                },
                load(id) {
                  if (id === "\0virtual:atmyapp/config")
                    return `export default ${JSON.stringify(defaults)}`;
                },
              },
            ],
          },
        });
        if (options.diagnostics)
          injectRoute({
            pattern: "/.well-known/atmyapp/diagnostics.json",
            entrypoint: fileURLToPath(
              new URL(
                import.meta.url.endsWith(".ts")
                  ? "./routes/diagnostics.ts"
                  : "../src/routes/diagnostics.ts",
                import.meta.url,
              ),
            ),
            prerender: !dynamic,
          });
      },
      "astro:route:setup": ({ route }) => {
        if (dynamic) route.prerender = false;
      },
    },
  };
}
