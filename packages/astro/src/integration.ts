import type { AstroIntegration } from "astro";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { ENV_KEYS, resolveDevMode, type Environment } from "./config.js";
import { LOCAL_CONTENT_ROUTE, serveLocalContent } from "./localContent.js";
export type AtMyAppIntegrationOptions = {
  apiKey?: string;
  baseUrl?: string;
  diagnostics?: boolean;
};
export default function atmyapp(
  options: AtMyAppIntegrationOptions = {},
): AstroIntegration {
  let dynamic = false;
  let projectRoot = pathToFileURL(`${process.cwd()}/`);
  return {
    name: "@atmyapp/astro",
    hooks: {
      "astro:config:setup": ({
        config,
        command,
        updateConfig,
        injectRoute,
        injectScript,
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
        projectRoot = config.root;
        dynamic = resolveDevMode(env, command === "dev");
        const defaults = {
          dynamic,
          env: Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]])),
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
        const formOrigins = [options.baseUrl, env.ATMYAPP_BASE_URL, env.ATMYAPP_API_URL]
          .filter((value): value is string => !!value)
          .flatMap((value) => { try { return [new URL(value).origin]; } catch { return []; } });
        injectScript("page", `import { installSubmissionVisit } from "@atmyapp/core/visit"; installSubmissionVisit(${JSON.stringify({ formOrigins })});`);
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
      // `atmyapp content pull` and agents editing a space write .ama/content;
      // reload the page so local mode shows the change.
      "astro:server:setup": ({ server }) => {
        const root = fileURLToPath(new URL(".ama/content/", projectRoot));
        // Local mode's images and files: same-origin URLs instead of file://,
        // which browsers refuse to load from an http page.
        server.middlewares.use(LOCAL_CONTENT_ROUTE, serveLocalContent(root));
        process.env.ATMYAPP_LOCAL_ASSET_BASE ??= LOCAL_CONTENT_ROUTE;
        server.watcher.add(root);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reload = (file: string) => {
          if (!file.startsWith(root) || file.endsWith(".tmp") || file.endsWith(".lock")) return;
          clearTimeout(timer);
          timer = setTimeout(() => server.ws.send({ type: "full-reload" }), 150);
        };
        server.watcher.on("add", reload);
        server.watcher.on("change", reload);
        server.watcher.on("unlink", reload);
      },
    },
  };
}
