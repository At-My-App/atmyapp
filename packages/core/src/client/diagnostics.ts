import type { AtMyAppClientOptions } from "./clientTypes";
import { loadManifest } from "./localFallback";

export const DIAGNOSTICS_PATH = "/.well-known/atmyapp/diagnostics.json";
export type DiagnosticStatus =
  "passed" | "failed" | "pending" | "unknown" | "unsupported";
export type DiagnosticCheck = { status: DiagnosticStatus; code: string };
export type DiagnosticsOptions = {
  execution?: "runtime" | "build";
  builtAt?: string;
  codeCommit?: string;
  astroVersion?: string;
};
export type IntegrationReport = {
  version: 1;
  generatedAt: string;
  checkedAt: string | null;
  builtAt: string | null;
  execution: "runtime" | "build";
  sdk: { core: string; astro: string | null };
  configuration: {
    mode: "online" | "local" | "with-fallback";
    previewPresent: boolean;
  };
  projectId: string | null;
  codeCommit: string | null;
  content: {
    source: "local" | "unknown";
    commit: string | null;
    snapshotId: string | null;
    generatedAt: string | null;
    fallbackUsed: boolean | null;
  };
  preview: { identity: string | null; revision: number | null };
  checks: {
    connection: DiagnosticCheck;
    credentials: DiagnosticCheck;
    preview: DiagnosticCheck;
    content: DiagnosticCheck;
  };
};
const hex = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value) ? value : null;
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const version = (value: unknown) =>
  typeof value === "string" &&
  /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : null;
const id = (value: unknown) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_-]{1,100}$/.test(value) &&
  !value.startsWith("pk-ama-")
    ? value
    : null;
const check = (status: DiagnosticStatus, code: string): DiagnosticCheck => ({
  status,
  code,
});

async function readJson(response: Response): Promise<any> {
  if (
    !response.headers.get("content-type")?.includes("application/json") ||
    !response.body
  )
    throw new Error("invalid_report");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("invalid_report");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createDiagnosticsClient(options: AtMyAppClientOptions) {
  return {
    async report(
      metadata: DiagnosticsOptions = {},
    ): Promise<IntegrationReport> {
      const now = new Date().toISOString();
      const mode = options.clientMode ?? "online";
      const report: IntegrationReport = {
        version: 1,
        generatedAt: now,
        checkedAt: null,
        builtAt:
          timestamp(metadata.builtAt) ??
          (metadata.execution === "build" ? now : null),
        execution: metadata.execution ?? "runtime",
        sdk: {
          core: version(require("../../package.json").version) || "0.0.0",
          astro: version(metadata.astroVersion),
        },
        configuration: { mode, previewPresent: !!options.previewKey },
        projectId: null,
        codeCommit: hex(metadata.codeCommit),
        content: {
          source: "unknown",
          commit: null,
          snapshotId: null,
          generatedAt: null,
          fallbackUsed: null,
        },
        preview: { identity: null, revision: null },
        checks: {
          connection: check("unsupported", "local_mode"),
          credentials: check("unknown", "not_checked"),
          preview: check(
            options.previewKey ? "unknown" : "unsupported",
            options.previewKey ? "not_checked" : "preview_absent",
          ),
          content: check("unknown", "content_identity_unknown"),
        },
      };
      if (mode === "local" || mode === "with-fallback") {
        try {
          const manifest = loadManifest(options) as any;
          if (manifest) {
            report.content.snapshotId =
              hex(manifest.snapshotId) ??
              (/^[a-f0-9-]{36}$/i.test(manifest.snapshotId || "")
                ? manifest.snapshotId
                : null);
            report.content.generatedAt = timestamp(manifest.generatedAt);
            if (mode === "local") {
              report.content.source = "local";
              report.content.commit = hex(manifest.commitSha);
              report.checks.content = check("passed", "snapshot_available");
            }
          } else if (mode === "local")
            report.checks.content = check(
              options.localDataSource ? "unknown" : "failed",
              options.localDataSource
                ? "content_identity_unknown"
                : "snapshot_unavailable",
            );
        } catch {
          report.checks.content = check("unknown", "snapshot_unavailable");
        }
      }
      if (mode === "local") return report;
      report.checkedAt = now;
      let url: URL;
      try {
        url = new URL(`${options.baseUrl.replace(/\/$/, "")}/diagnostics`);
        if (
          url.username ||
          url.password ||
          !["https:", "http:"].includes(url.protocol)
        )
          throw new Error();
      } catch {
        report.checks.connection = check("failed", "configuration_invalid");
        return report;
      }
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          (async () => {
            const response = await (options.customFetch ?? fetch)(
              url.toString(),
              {
                headers: {
                  Authorization: `Bearer ${options.apiKey}`,
                  ...(options.previewKey
                    ? { "X-AtMyApp-Preview": options.previewKey }
                    : {}),
                },
                signal: controller.signal,
                cache: "no-store",
                redirect: "error",
              },
            );
            if (response.status === 404) return { missing: true };
            if (!response.ok)
              throw new Error(
                response.status === 429 ? "rate_limited" : "connection_failed",
              );
            return readJson(response);
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("timeout"));
            }, 5000);
          }),
        ]);
        if (result.missing) {
          report.checks.connection = check("unsupported", "probe_unavailable");
          return report;
        }
        const credentialCodes: Record<string, DiagnosticStatus> = {
          credentials_valid: "passed",
          credentials_rejected: "failed",
          project_mismatch: "failed",
          authentication_unavailable: "unknown",
        };
        const previewCodes: Record<string, DiagnosticStatus> = {
          preview_valid: "passed",
          preview_invalid: "failed",
          preview_absent: "unsupported",
          preview_unavailable: "unknown",
        };
        if (
          result.version !== 1 ||
          !Object.prototype.hasOwnProperty.call(
            credentialCodes,
            result.credentials?.code,
          ) ||
          !Object.prototype.hasOwnProperty.call(
            previewCodes,
            result.preview?.code,
          )
        )
          throw new Error("invalid_report");
        report.checks.connection = check("passed", "connected");
        report.checks.credentials = check(
          credentialCodes[result.credentials.code],
          result.credentials.code,
        );
        report.checks.preview = check(
          previewCodes[result.preview.code],
          result.preview.code,
        );
        if (report.checks.credentials.status === "passed")
          report.projectId = id(result.projectId);
        if (report.checks.preview.status === "passed") {
          report.preview.identity = hex(result.preview.identity);
          report.preview.revision =
            Number.isSafeInteger(result.preview.revision) &&
            result.preview.revision >= 0
              ? result.preview.revision
              : null;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        report.checks.connection = check(
          "unknown",
          ["timeout", "invalid_report", "rate_limited"].includes(message)
            ? message
            : "connection_failed",
        );
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
      return report;
    },
  };
}

/** Mount explicitly. Supply the same request-scoped client factory as the website. */
export function createDiagnosticsHandler(
  getClient: (
    request: Request,
  ) =>
    | { diagnostics: ReturnType<typeof createDiagnosticsClient> }
    | Promise<{ diagnostics: ReturnType<typeof createDiagnosticsClient> }>,
  metadata: DiagnosticsOptions = {},
) {
  return async (request: Request): Promise<Response> => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };
    if (request.method !== "GET")
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: "GET" },
      });
    try {
      return new Response(
        JSON.stringify(
          await (await getClient(request)).diagnostics.report(metadata),
        ),
        { headers },
      );
    } catch {
      return new Response(
        JSON.stringify({ error: "diagnostics_unavailable" }),
        { status: 503, headers },
      );
    }
  };
}
