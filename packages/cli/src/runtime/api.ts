import { buildCliAuthVerifyUrl, cliApiUrl, isPersonalCredential } from "./auth";
import { CliError, EXIT, needsPerson } from "./errors";
import type { CliSession } from "./session";

type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | readonly QueryScalar[] | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Expected statuses besides 2xx that should not throw (e.g. 404 → null). */
  allow?: number[];
  signal?: AbortSignal;
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
  /** Sent as X-AtMyApp-Agent (runtime/agent.ts); advisory only. */
  agent?: string;
  /** Called when the server renewed a browser login (X-AtMyApp-Credential-Expires). */
  onCredentialRenewed?: (expiresAt: string) => void;
  /** How a request that needs the owner's approval waits (CliEverywherePlan §4.4.2). */
  approval?: ApprovalOptions;
}

/** A request waiting for its owner (the server's 428 `approval_required`). */
export interface PendingApproval {
  id: string;
  code: string;
  url: string;
  summary: string;
  class?: string;
  expiresAt: string;
  pollAfterMs?: number;
}

export interface ApprovalOptions {
  /** `--no-wait`: stop at once with needs_person. */
  wait?: boolean;
  /** `--approval-timeout`, in milliseconds (default 3 minutes). */
  timeoutMs?: number;
  /** The command that continues after approving, for `details.resume`. */
  resume?: string;
  /** Progress for people, on stderr. */
  onWaiting?: (approval: PendingApproval) => void;
  onStale?: (message: string) => void;
  sleep?: (ms: number) => Promise<unknown>;
}

/** Set when any response this run was a replay of an approved request (x-atmyapp-replayed). */
export const replayState = { replayed: false };

const APPROVAL_DEFAULT_TIMEOUT_MS = 3 * 60_000;

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

function errorFromResponse(status: number, body: ErrorBody | null, path: string, usesLogin = false): CliError {
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
      fix: usesLogin ? "Run 'atmyapp login --scopes' with the required scopes."
        : `Create a project key with ${(body?.scopes ?? []).join(" or ") || "the needed scope"} in Settings → Project keys, then run 'atmyapp use' with it.`,
    });
  }
  // Approvals (CliEverywherePlan §4.4).
  if (code === "approval_denied") {
    return new CliError(code, message, { exitCode: EXIT.auth, status, fix: "Nothing was changed. Ask the owner, or change the request." });
  }
  if (code === "approval_limit") {
    return new CliError(code, message, { status, fix: "Answer or let the waiting requests expire, then try again." });
  }
  if (code === "approval_in_progress") {
    return new CliError(code, message, { exitCode: EXIT.conflict, status, fix: "Run the command again in a moment to see its result." });
  }
  if (code === "key_secret_lost") {
    const name = typeof body?.details?.name === "string" ? body.details.name : "<name>";
    return new CliError(code, message, {
      status, details: body?.details,
      fix: `The key exists but its secret is gone. Replace it: atmyapp keys create --name "${name}" --replace --preset <preset>`,
    });
  }
  if (code === "key_name_taken") {
    return new CliError(code, message, {
      exitCode: EXIT.conflict, status, details: body?.details,
      fix: "Choose another name, or replace that key with --replace.",
    });
  }
  if (code === "project_key_not_accepted") {
    return new CliError("keys_not_accepted", message, { exitCode: EXIT.auth, status });
  }
  if (code === "project_key_stopped") {
    return new CliError("key_stopped", message, {
      exitCode: EXIT.auth,
      status,
      fix: "Ask someone who can still do this to create a new project key.",
    });
  }
  // The inbox's record-level refusals (CliEverywherePlan §5.3).
  if (code === "live_messages_refused") {
    return new CliError(code, message, {
      exitCode: EXIT.auth, status, fix: "This credential sees test messages only. List them with '--env test'.",
    });
  }
  if (code === "erase_not_allowed") {
    return new CliError(code, message, {
      exitCode: EXIT.auth, status, fix: "Ask a project admin, or move the submissions to the trash with '--trash'.",
    });
  }
  if (code === "export_too_large") {
    return new CliError(code, message, { exitCode: EXIT.usage, status, fix: "Narrow the filters and export again." });
  }
  if (status === 401) {
    return new CliError("unauthenticated", usesLogin ? "The CLI login was not accepted. It may have expired or been revoked." : "The CLI key was not accepted. It may be revoked or for another project.", {
      exitCode: EXIT.auth,
      status,
      fix: usesLogin ? "Run 'atmyapp login' again." : "Run 'atmyapp whoami' to check the connection, or 'atmyapp use' with a current key.",
    });
  }
  if (code === "publication-warnings" || code === "commit-conflict" || code === "hard-validation-failure" ||
      code === "commit-in-progress" || code === "stale-resolutions-token" || code === "build_failed" || code === "slow_down" ||
      code === "device_expired" || code === "device_denied") {
    const details = body?.details ?? (body?.data && typeof body.data === "object" ? body.data as Record<string, unknown> : undefined);
    const exitCode = code === "hard-validation-failure" ? EXIT.validation : code === "commit-conflict" ? EXIT.conflict :
      code === "device_expired" || code === "device_denied" ? EXIT.auth : EXIT.error;
    return new CliError(code, message, { status, details, exitCode });
  }
  // Project creation refusals (CliEverywherePlan E29) and reach limits keep their reason.
  if (code && ["partner_quota", "staff_limit", "creation_not_allowed", "credential_project_limit", "not_a_business", "organization_not_found", "project_key_expired"].includes(code)) {
    return new CliError(code, message, { exitCode: EXIT.auth, status, details: body?.details });
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
  private readonly agent?: string;
  private readonly onCredentialRenewed?: (expiresAt: string) => void;
  private readonly approval: ApprovalOptions;

  constructor(
    readonly session: CliSession,
    options: ApiClientOptions = {},
  ) {
    const impl = options.fetch ?? globalThis.fetch;
    if (typeof impl !== "function") throw new CliError("no_fetch", "fetch is not available in this Node version.");
    this.fetchImpl = impl;
    this.cliVersion = options.cliVersion;
    this.agent = options.agent;
    this.onCredentialRenewed = options.onCredentialRenewed;
    this.approval = options.approval ?? {};
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
      ...(this.session.token ? { Authorization: `Bearer ${this.session.token}` } : {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.cliVersion ? { "X-AtMyApp-CLI-Version": this.cliVersion } : {}),
      ...(this.agent ? { "X-AtMyApp-Agent": this.agent } : {}),
    };
  }

  async send(method: string, url: string, body?: unknown, raw = false, signal?: AbortSignal, redirect?: RequestRedirect): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: raw ? { ...this.headers(false), "Content-Type": "application/octet-stream" } : this.headers(body !== undefined),
        body: raw ? body as ArrayBuffer : body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect,
      });
      const renewed = response.headers?.get?.("X-AtMyApp-Credential-Expires");
      if (renewed && this.onCredentialRenewed) {
        try { this.onCredentialRenewed(renewed); } catch { /* Saving the new expiry is best effort. */ }
      }
      return response;
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
    return this.jsonAt<T>(method, this.url(subPath, options.query), subPath, options);
  }

  async cliAuth<T>(method: string, subPath: string, options: RequestOptions = {}): Promise<T | null> {
    return this.jsonAt<T>(method, cliApiUrl(this.session.url, "cli-auth/" + subPath), "cli-auth/" + subPath, options, "error");
  }

  private async jsonAt<T>(method: string, url: string, subPath: string, options: RequestOptions, redirect?: RequestRedirect): Promise<T | null> {
    const usesLogin = isPersonalCredential(this.session.token);
    let response = await this.send(method, url, options.body, false, options.signal, redirect);
    let body = await readJson(response);
    // Approvals: wait for the owner, then send the same request again. A
    // changed state (approval_stale) asks once more with the new state.
    for (let stale = 0; ; ) {
      const code = (body as ErrorBody | null)?.code;
      if (response.status === 428 && code === "approval_required") {
        await this.waitForApproval((body as { approval?: PendingApproval }).approval);
      } else if (response.status === 409 && code === "approval_stale" && stale === 0) {
        stale += 1;
        const details = (body as ErrorBody).details as { now?: string } | undefined;
        this.approval.onStale?.(`What you approved changed. Asking again${details?.now ? `: ${details.now}` : "."}`);
      } else break;
      // The first signal may have run out while waiting; the resend gets its own.
      response = await this.send(method, url, options.body, false, AbortSignal.timeout(120_000), redirect);
      body = await readJson(response);
    }
    if (response.headers?.get?.("x-atmyapp-replayed") === "1") replayState.replayed = true;
    if (!response.ok) {
      if (options.allow?.includes(response.status)) return null;
      throw errorFromResponse(response.status, body as ErrorBody, subPath, usesLogin);
    }
    if (body && typeof body === "object" && (body as ErrorBody).success === false) {
      throw errorFromResponse(response.status, body as ErrorBody, subPath, usesLogin);
    }
    return unwrap(body) as T;
  }

  /**
   * Polls the credential's own approval until the owner decides (§4.4.2 step
   * 4). Approved returns; denied, expired or the timeout throw.
   */
  private async waitForApproval(pending: PendingApproval | undefined): Promise<void> {
    if (!pending?.id) throw new CliError("invalid_response", "The server asked for an approval without saying which.");
    const resume = this.approval.resume;
    const stop = (message: string) => needsPerson("approval", message, {
      url: pending.url, resume, expiresAt: pending.expiresAt,
      details: { approvalId: pending.id, code: pending.code, summary: pending.summary },
      fix: resume ? `Approve it on your phone, in the dashboard or at ${pending.url}, then run '${resume}' again.` : undefined,
    });
    if (this.approval.wait === false) throw stop(`Waiting for your approval: ${pending.summary}`);
    this.approval.onWaiting?.(pending);
    const sleep = this.approval.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (this.approval.timeoutMs ?? APPROVAL_DEFAULT_TIMEOUT_MS);
    const url = cliApiUrl(this.session.url, "cli-approvals/" + encodeURIComponent(pending.id));
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw stop(`Still waiting for your approval: ${pending.summary}`);
      await sleep(Math.min(Math.max(pending.pollAfterMs ?? 2000, 1000), remaining));
      const response = await this.send("GET", url, undefined, false, AbortSignal.timeout(15_000)).catch(() => null);
      if (!response) continue;
      const body = await readJson(response) as { data?: { approval?: { status?: string } } } | null;
      const status = response.ok ? body?.data?.approval?.status : undefined;
      if (status === "approved" || status === "used") return;
      if (status === "denied") {
        throw new CliError("approval_denied", `You denied this: ${pending.summary}`, { exitCode: EXIT.auth, fix: "Nothing was changed." });
      }
      if (status === "expired") throw stop(`The approval request expired: ${pending.summary}`);
    }
  }

  async upload(subPath: string, data: Uint8Array, query: Record<string, QueryValue>) {
    const response = await this.send("PUT", this.url(subPath, query), new Uint8Array(data).buffer, true);
    const body = await readJson(response);
    if (!response.ok || (body as ErrorBody)?.success === false)
      throw errorFromResponse(response.status, body as ErrorBody, subPath);
    return unwrap(body);
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
    if (isPersonalCredential(this.session.token)) {
      const query = this.session.projectId ? `?projectId=${encodeURIComponent(this.session.projectId)}` : "";
      return (await this.cliAuth<T>("GET", "session" + query))!;
    }
    const response = await this.send("GET", buildCliAuthVerifyUrl(this.session.url));
    const body = await readJson(response);
    if (!response.ok || (body as ErrorBody)?.success === false) {
      throw errorFromResponse(response.status || 401, body as ErrorBody, "cli-keys/auth/verify");
    }
    return unwrap(body) as T;
  }
}
