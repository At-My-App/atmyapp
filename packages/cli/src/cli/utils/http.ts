import { createFetch } from "@better-fetch/fetch";
export {
  buildCliAuthVerifyUrl,
  verifyCliAuthentication,
} from "../../runtime/auth";
export type {
  VerifiedCliAuth,
  VerifyCliAuthResponseBody,
} from "../../runtime/auth";
import { existsSync } from "fs";
import { join } from "path";
import { resolveCredentials } from "../../runtime/session";
import { browserLoginSession } from "../../runtime/credentials";
import { getConfig, type AmaConfig } from "./config";

export interface AmaSession {
  token: string;
  projectId: string;
  url: string;
}

export interface ProjectEnvironment {
  id: number;
  name: string;
  projectId: string;
}

export interface ProjectApiKey {
  id: string;
  name: string;
  projectId: string;
  environment_id: number;
}

export interface SessionOverrides {
  token?: string;
  projectId?: string;
  url?: string;
}

export type AmaFetch = ReturnType<typeof createAmaFetch>;

export interface SseEvent<T = unknown> {
  event?: string;
  id?: string;
  retry?: number;
  data: string;
  parsed?: T;
  raw: string;
}

export interface StreamSseOptions<T = unknown> {
  url: string;
  fetchInit?: RequestInit;
  signal?: AbortSignal;
  onEvent: (event: SseEvent<T>) => void | Promise<void>;
}

interface ApiResponseBody<T> {
  success: boolean;
  data: T | null;
  error: string;
}

/**
 * Credentials for older commands: overrides (flags), then the ATMYAPP_CLI_*
 * environment variables, browser login, then .ama/session.json (runtime/session.ts).
 */
export function resolveSession(overrides: SessionOverrides = {}): AmaSession {
  let sessionFile: AmaConfig | null = null;
  try {
    sessionFile = existsSync(join(process.cwd(), ".ama", "session.json")) ? getConfig() : null;
  } catch {
    sessionFile = null;
  }
  const target = overrides.projectId || process.env.ATMYAPP_PROJECT_ID || sessionFile?.projectId;
  const resolved = resolveCredentials({ flags: overrides, env: process.env, sessionFile, loginSession: () => browserLoginSession(target) });
  return { token: resolved.token, projectId: resolved.projectId, url: resolved.url };
}

export function createAmaFetch(session: AmaSession) {
  return createFetch({
    baseURL: ensureTrailingSlash(session.url),
    headers: {
      Authorization: `Bearer ${session.token}`,
    },
    throw: false,
  });
}

export function buildProjectApiUrl(
  url: string,
  projectId: string,
  subPath: string,
): string {
  const parsedUrl = new URL(stripTrailingSlashes(url));
  parsedUrl.search = "";
  parsedUrl.hash = "";

  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const projectSegmentIndex = pathSegments.findIndex(
    (segment) => segment === "projects",
  );
  const baseSegments =
    projectSegmentIndex !== -1 && pathSegments[projectSegmentIndex + 1]
      ? pathSegments.slice(0, projectSegmentIndex)
      : pathSegments;
  const hasV0 = baseSegments[baseSegments.length - 1] === "v0";
  const cleanSubPath = subPath.replace(/^\/+/, "");

  parsedUrl.pathname = `/${[
    ...baseSegments,
    ...(hasV0 ? [] : ["v0"]),
    "projects",
    projectId,
    cleanSubPath,
  ]
    .filter(Boolean)
    .join("/")}`;

  return parsedUrl.toString();
}

export { detectProjectIdFromUrl } from "../../runtime/session";

export function projectUrl(
  session: AmaSession,
  subPath: string,
  query?: Record<string, string | number | boolean | null | undefined>
): string {
  const base = ensureTrailingSlash(session.url);
  const cleanPath = subPath.replace(/^\/+/, "");
  const url = new URL(cleanPath, base);

  if (query) {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }

      params.append(key, typeof value === "boolean" ? String(value) : String(value));
    }

    const queryString = params.toString();
    if (queryString) {
      url.search = queryString;
    }
  }

  return url.toString();
}

async function getJsonResponse<T>(
  response: Response,
): Promise<ApiResponseBody<T> | null> {
  try {
    return (await response.json()) as ApiResponseBody<T>;
  } catch {
    return null;
  }
}

function getFetchImplementation(fetchImplementation?: typeof fetch): typeof fetch {
  const fetchApi = fetchImplementation ?? globalThis.fetch;
  if (typeof fetchApi !== "function") {
    throw new Error("Fetch is not available in this runtime.");
  }

  return fetchApi;
}

export async function listProjectEnvironments(options: {
  url: string;
  token: string;
  projectId: string;
  fetchImplementation?: typeof fetch;
}): Promise<ProjectEnvironment[]> {
  const fetchApi = getFetchImplementation(options.fetchImplementation);
  const requestUrl = buildProjectApiUrl(
    options.url,
    options.projectId,
    "environments",
  );
  const response = await fetchApi(requestUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.token}`,
    },
  });

  const responseBody = await getJsonResponse<ProjectEnvironment[]>(response);

  if (!response.ok || !responseBody?.success || !responseBody.data) {
    throw new Error(
      responseBody?.error ||
        `Failed to list environments (status ${response.status}).`,
    );
  }

  return responseBody.data;
}

export async function createProjectApiKey(options: {
  url: string;
  token: string;
  projectId: string;
  name: string;
  environmentId: number;
  fetchImplementation?: typeof fetch;
}): Promise<ProjectApiKey> {
  const fetchApi = getFetchImplementation(options.fetchImplementation);
  const requestUrl = buildProjectApiUrl(
    options.url,
    options.projectId,
    "api-keys/create",
  );
  const response = await fetchApi(requestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: options.name,
      environment_id: options.environmentId,
    }),
  });

  const responseBody = await getJsonResponse<ProjectApiKey>(response);

  if (!response.ok || !responseBody?.success || !responseBody.data) {
    throw new Error(
      responseBody?.error ||
        `Failed to create API key (status ${response.status}).`,
    );
  }

  return responseBody.data;
}

export async function streamSse<T = unknown>(
  options: StreamSseOptions<T>
): Promise<void> {
  const { url, onEvent, signal, fetchInit = {} } = options;
  const { signal: initSignal, headers: initHeaders, ...restInit } = fetchInit;

  const headers = new Headers(initHeaders ?? {});
  if (!headers.has("Accept")) {
    headers.set("Accept", "text/event-stream");
  }

  const requestInit: RequestInit = {
    method: restInit.method ?? "GET",
    ...restInit,
    headers,
    signal: signal ?? initSignal,
  };

  const response = await fetch(url, requestInit);

  if (!response.ok) {
    const errorBody = await safeReadText(response);
    throw new Error(
      `Request failed with status ${response.status}: ${errorBody ?? "<no body>"}`
    );
  }

  if (!response.body) {
    throw new Error("Streaming response body is not available.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = await dispatchSseBuffer(buffer, onEvent);
  }

  buffer += decoder.decode();
  await dispatchSseBuffer(buffer, onEvent, true);
}

export function encodePathSegment(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      segment === "" || segment === "." ? segment : encodeURIComponent(segment)
    )
    .join("/");
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function dispatchSseBuffer<T>(
  buffer: string,
  onEvent: (event: SseEvent<T>) => void | Promise<void>,
  flush = false
): Promise<string> {
  let working = buffer;

  while (true) {
    const delimiter = nextDelimiter(working);
    if (!delimiter) {
      break;
    }

    const { index, length } = delimiter;
    const rawEvent = working.slice(0, index);
    working = working.slice(index + length);

    if (!rawEvent.trim()) {
      continue;
    }

    const event = parseSseEvent<T>(rawEvent);
    if (event) {
      await onEvent(event);
    }
  }

  if (flush && working.trim()) {
    const event = parseSseEvent<T>(working);
    if (event) {
      await onEvent(event);
    }
    return "";
  }

  return working;
}

function nextDelimiter(buffer: string): { index: number; length: number } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");

  if (lfIndex === -1 && crlfIndex === -1) {
    return null;
  }

  if (lfIndex === -1) {
    return { index: crlfIndex, length: 4 };
  }

  if (crlfIndex === -1) {
    return { index: lfIndex, length: 2 };
  }

  return lfIndex < crlfIndex
    ? { index: lfIndex, length: 2 }
    : { index: crlfIndex, length: 4 };
}

function parseSseEvent<T>(raw: string): SseEvent<T> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  const dataLines: string[] = [];
  const event: SseEvent<T> = {
    data: "",
    raw: trimmed,
  };

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field =
      separatorIndex === -1 ? line : line.slice(0, separatorIndex).trim();
    const value =
      separatorIndex === -1
        ? ""
        : line
            .slice(separatorIndex + 1)
            .replace(/^\s+/, "");

    switch (field) {
      case "event":
        event.event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        event.id = value;
        break;
      case "retry":
        {
          const numeric = Number(value);
          if (!Number.isNaN(numeric)) {
            event.retry = numeric;
          }
        }
        break;
      default:
        break;
    }
  }

  event.data = dataLines.join("\n");

  if (event.data) {
    try {
      event.parsed = JSON.parse(event.data) as T;
    } catch (error) {
      // Non-JSON payloads are expected occasionally (e.g. [DONE])
    }
  }

  return event;
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch (error) {
    return null;
  }
}
