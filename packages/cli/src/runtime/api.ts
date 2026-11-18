import { buildCliAuthVerifyUrl } from "./auth";
import { CliError, EXIT } from "./errors";
import type { CliSession } from "./session";

type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | readonly QueryScalar[] | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Expected statuses besides 2xx that should not throw (e.g. 404 → null). */
  allow?: number[];
}

export interface BytesResponse {
  status: number;
  bytes: Uint8Array;
  contentType: string;
  /** Parsed X-Atma-Metadata header. */
  metadata: Record<string, unknown>;
  /** Git commit the read model reflected (X-Atma-Storage-Commit), when stamped. */
  commitSha: string | null;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  /** Sent as X-AtMyApp-CLI-Version so the server can ask for an upgrade. */
  cliVersion?: string;
}

/** `/v0/projects/<id>/<subPath>` for a session URL in any of the accepted shapes. */
export function projectApiUrl(
  sessionUrl: string,
  projectId: string,
  subPath: string,
  query?: Record<string, QueryValue>,
): string {
  const parsed = new URL(sessionUrl.replace(/\/+$/, ""));
  parsed.search = "";
  parsed.hash = "";
  const segments = parsed.pathname.split("/").filter(Boolean);
  const projectIndex = segments.indexOf("projects");
  const base =
    projectIndex !== -1 && segments[projectIndex + 1] ? segments.slice(0, projectIndex) : segments;
  const hasV0 = base[base.length - 1] === "v0";
  const rest = subPath.replace(/^\/+/, "");
  parsed.pathname = `/${[...base, ...(hasV0 ? [] : ["v0"]), "projects", encodeURIComponent(projectId), rest]
    .filter(Boolean)
    .join("/")}`;
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      parsed.searchParams.append(key, String(item));
    }
  }
  return parsed.toString();
}

/** Encodes each segment of a storage path, keeping the slashes. */
export function encodeStoragePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

interface ErrorBody {
  success?: boolean;
  error?: string;
  code?: string;
  scopes?: string[];
  capability?: string;
  minVersion?: string;
  details?: Record<string, unknown>;
  data?: unknown;
  sessions?: unknown[];
}

function errorFromResponse(status: number, body: ErrorBody | null, path: string): CliError {
  const message = body?.error || `Request failed with status ${status}.`;
  const code = body?.code;
  if (status === 426 && code === "cli_upgrade_required") {
    const minVersion = body?.minVersion;
    return new CliError(
      "upgrade_required",
      minVersion ? `This server requires AtMyApp CLI ${minVersion} or newer.` : "This server requires a newer AtMyApp CLI.",
      {
        exitCode: EXIT.error,
        status,
        details: { minVersion },
        fix: "npm install --save-dev @atmyapp/cli@latest",
      },
    );
  }
  if (status === 400 && code === "invalid_cursor") {
    return new CliError("invalid_cursor", message, { exitCode: EXIT.usage, status });
  }
  if (code === "named_session_not_found" || code === "named_session_gone") {
    return new CliError("session_expired", "The named draft has ended.", {
      status, exitCode: EXIT.session, fix: "Run 'atmyapp stage push' to start a new draft.",
    });
  }
  if (code === "session_in_review" || code === "session_review_changed") {
    return new CliError(code, message, { status, exitCode: EXIT.session, fix: "Check 'atmyapp stage status'." });
  }
  if (code === "staged-version-conflict" || code === "staged_version_conflict") {
    return new CliError("staged_version_conflict", message, {
      status, exitCode: EXIT.conflict, details: body?.details, fix: "Review 'atmyapp stage diff' and pull the draft changes.",
    });
  }
  if (code === "named_session_limit") {
    return new CliError(code, message, { status, exitCode: EXIT.session, details: { sessions: body?.sessions ?? [] } });
  }
  if (code === "project_key_scope") {
    return new CliError("missing_scope", message, {
      exitCode: EXIT.auth,
      status,
      details: { scopes: body?.scopes ?? [] },
      fix: `Create a CLI key with ${(body?.scopes ?? []).join(" or ") || "the needed scope"} in Settings → CLI keys, then run 'atmyapp use' with it.`,
    });
  }
  if (code === "project_key_not_accepted") {
    return new CliError("keys_not_accepted", message, { exitCode: EXIT.auth, status });
  }
  if (code === "project_key_stopped") {
    return new CliError("key_stopped", message, {
      exitCode: EXIT.auth,
      status,
      fix: "Ask someone who can still do this to create a new CLI key.",
    });
  }
  if (status === 401) {
    return new CliError("unauthenticated", "The CLI key was not accepted. It may be revoked or for another project.", {
      exitCode: EXIT.auth,
      status,
      fix: "Run 'atmyapp whoami' to check the connection, or 'atmyapp use' with a current key.",
    });
  }
  if (status === 403) return new CliError("forbidden", message, { exitCode: EXIT.auth, status });
  if (status === 404) return new CliError("not_found", message, { status, details: { path } });
  if (status === 409) return new CliError("conflict", message, { exitCode: EXIT.conflict, status });
  if (status === 410) return new CliError("gone", message, { status });
  if (status === 429) return new CliError("rate_limited", message, { status, fix: "Wait a minute and try again." });
  if (status >= 500) return new CliError("server_error", message, { status });
  return new CliError(code || "request_failed", message, { status });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `{ success, data }` envelopes are unwrapped; anything else is returned as is. */
function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && "success" in body && "data" in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

/** Typed access to the project API with one place for auth, headers and errors. */
export class ApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cliVersion?: string;

  constructor(
    readonly session: CliSession,
    options: ApiClientOptions = {},
  ) {
    const impl = options.fetch ?? globalThis.fetch;
    if (typeof impl !== "function") throw new CliError("no_fetch", "fetch is not available in this Node version.");
    this.fetchImpl = impl;
    this.cliVersion = options.cliVersion;
  }

  url(subPath: string, query?: Record<string, QueryValue>): string {
    return projectApiUrl(this.session.url, this.session.projectId, subPath, query);
  }

  get projectBase(): string {
    const { origin, pathname } = new URL(this.url(""));
    return origin + pathname;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.session.token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.cliVersion ? { "X-AtMyApp-CLI-Version": this.cliVersion } : {}),
    };
  }

  async send(method: string, url: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new CliError(
        "network",
        `Could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`,
        { fix: "Check your connection and the project URL ('atmyapp whoami')." },
      );
    }
  }

  /** A JSON request against the project API; `{ success, data }` is unwrapped. */
  async json<T>(method: string, subPath: string, options: RequestOptions = {}): Promise<T | null> {
    const response = await this.send(method, this.url(subPath, options.query), options.body);
    const body = await readJson(response);
    if (!response.ok) {
      if (options.allow?.includes(response.status)) return null;
      throw errorFromResponse(response.status, body as ErrorBody, subPath);
    }
    if (body && typeof body === "object" && (body as ErrorBody).success === false) {
      throw errorFromResponse(response.status, body as ErrorBody, subPath);
    }
    return unwrap(body) as T;
  }

  /** Raw bytes, with the storage headers the server sets on reads. */
  async bytes(subPath: string, options: RequestOptions = {}): Promise<BytesResponse | null> {
    const response = await this.send(options.body === undefined ? "GET" : "POST", this.url(subPath, options.query), options.body);
    if (!response.ok) {
      const body = await readJson(response);
      if (options.allow?.includes(response.status)) return null;
      throw errorFromResponse(response.status, body as ErrorBody, subPath);
    }
    let metadata: Record<string, unknown> = {};
    const header = response.headers.get("X-Atma-Metadata");
    if (header) {
      try {
        metadata = JSON.parse(header);
      } catch {
        metadata = {};
      }
    }
    return {
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("Content-Type") || "application/octet-stream",
      metadata,
      commitSha: response.headers.get("X-Atma-Storage-Commit"),
    };
  }

  /** The key check outside project scope (`/v0/cli-keys/auth/verify`). */
  async verifyKey<T>(): Promise<T> {
    const response = await this.send("GET", buildCliAuthVerifyUrl(this.session.url));
    const body = await readJson(response);
    if (!response.ok || (body as ErrorBody)?.success === false) {
      throw errorFromResponse(response.status || 401, body as ErrorBody, "cli-keys/auth/verify");
    }
    return unwrap(body) as T;
  }
}
