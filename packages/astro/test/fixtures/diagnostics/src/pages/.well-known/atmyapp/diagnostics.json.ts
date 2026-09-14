import { createAstroDiagnosticsRoute } from "../../../../../../../src/diagnostics";
import { createAtMyAppClient } from "@atmyapp/core";
export const prerender = true;
export const GET = createAstroDiagnosticsRoute((request) =>
  createAtMyAppClient({
    baseUrl: "https://fixture.invalid/v0/projects/fixture",
    apiKey: "fixture-private-key",
    previewKey:
      new URL(request.url).searchParams.get("amaPreviewKey") || undefined,
    customFetch: async (_url, init) =>
      Response.json({
        version: 1,
        projectId: "fixture",
        credentials: { status: "passed", code: "credentials_valid" },
        preview: new Headers(init?.headers).has("X-AtMyApp-Preview")
          ? {
              status: "passed",
              code: "preview_valid",
              identity: "a".repeat(64),
              revision: 1,
            }
          : {
              status: "unsupported",
              code: "preview_absent",
              identity: null,
              revision: null,
            },
      }),
  }),
);
