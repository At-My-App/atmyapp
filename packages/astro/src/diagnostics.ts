import { ASTRO_SDK_VERSION } from "./packageVersion.js";
import {
  createDiagnosticsHandler,
  type DiagnosticsOptions,
} from "@atmyapp/core";
import type { APIRoute, AstroIntegration } from "astro";

/** Use in src/pages/.well-known/atmyapp/diagnostics.json.ts; mounting is opt-in. */
export function createAstroDiagnosticsRoute(
  getClient: Parameters<typeof createDiagnosticsHandler>[0],
  options: DiagnosticsOptions = {},
): APIRoute {
  const astroVersion = ASTRO_SDK_VERSION;
  return (context) =>
    createDiagnosticsHandler(getClient, {
      ...options,
      execution:
        options.execution ?? (context.isPrerendered ? "build" : "runtime"),
      builtAt: options.builtAt ?? process.env.ATMYAPP_BUILD_TIME,
      codeCommit: options.codeCommit ?? process.env.ATMYAPP_CODE_COMMIT,
      astroVersion,
    })(context.request);
}

/** Keep the opt-in endpoint request-scoped in development (Astro >=4.14). */
export function atMyAppDiagnostics(): AstroIntegration {
  let development = false;
  return {
    name: "atmyapp-diagnostics",
    hooks: {
      "astro:config:setup": ({ command }) => {
        development = command === "dev";
      },
      "astro:route:setup": ({ route }) => {
        if (
          development &&
          /\/\.well-known\/atmyapp\/diagnostics\.json\.[jt]s$/.test(
            route.component.replace(/\\/g, "/"),
          )
        ) {
          route.prerender = false;
        }
      },
    },
  };
}
