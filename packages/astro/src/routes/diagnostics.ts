import type { APIRoute } from "astro";
import defaults from "virtual:atmyapp/config";
import { createAstroDiagnosticsRoute } from "../diagnostics.js";
import { getAtMyApp } from "../server.js";
export const GET: APIRoute = (context) =>
  createAstroDiagnosticsRoute(() => getAtMyApp(context), {
    execution: defaults.dynamic ? "runtime" : "build",
    codeCommit: defaults.env.ATMYAPP_CODE_COMMIT,
    builtAt: defaults.env.ATMYAPP_BUILD_TIME,
  })(context);
