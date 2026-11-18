import type { AtMyAppClientOptions } from "@atmyapp/core";
export type Environment = Record<string, string | undefined>;
export type AstroClientOptions = Partial<
  Omit<AtMyAppClientOptions, "previewKey">
> & { previewKey?: string | null; env?: Environment };
export function resolveDevMode(env: Environment, development = false): boolean {
  const value = env.DEV_MODE ?? env.IS_DYNAMIC;
  if (value === undefined) return development;
  if (["1", "true"].includes(value.trim().toLowerCase())) return true;
  if (["0", "false"].includes(value.trim().toLowerCase())) return false;
  throw new Error(
    "AtMyApp: DEV_MODE (or IS_DYNAMIC) must be true, false, 1, or 0.",
  );
}
export function resolveClientOptions(
  env: Environment,
  requestUrl: URL | undefined,
  dynamic: boolean,
  options: AstroClientOptions = {},
): AtMyAppClientOptions {
  const source = { ...env, ...options.env };
  const clientMode = options.clientMode ?? resolveClientModeEnv(source);
  // Local mode renders the pulled copy (.ama/content) and needs no keys.
  const local = clientMode === "local";
  const apiKey = options.apiKey ?? source.ATMYAPP_API_KEY ?? (local ? "local" : undefined);
  const baseUrl =
    options.baseUrl ?? source.ATMYAPP_BASE_URL ?? source.ATMYAPP_API_URL ?? (local ? "http://localhost.invalid" : undefined);
  if (!apiKey?.trim()) throw new Error("AtMyApp: set ATMYAPP_API_KEY.");
  if (!baseUrl?.trim())
    throw new Error(
      "AtMyApp: set ATMYAPP_BASE_URL or ATMYAPP_API_URL to your project API URL.",
    );
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("AtMyApp: expected an absolute project API URL.");
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("AtMyApp: invalid project API URL.");
  const previewKey =
    options.previewKey !== undefined
      ? options.previewKey
      : ((dynamic
          ? requestUrl?.searchParams.get("amaPreviewKey")
          : undefined) ?? source.ATMYAPP_PREVIEW_KEY);
  const { env: _env, ...rest } = options;
  const space = options.localStorage?.space ?? source.ATMYAPP_SPACE;
  return {
    ...rest,
    ...(clientMode ? { clientMode } : {}),
    ...(space ? { localStorage: { ...options.localStorage, space } } : {}),
    apiKey,
    baseUrl: parsed.toString().replace(/\/$/, ""),
    previewKey: previewKey || undefined,
    mode: options.mode ?? (dynamic ? "priority" : "client"),
    errorPolicy: options.errorPolicy ?? "throw",
  };
}

const CLIENT_MODES = ["online", "with-fallback", "local"] as const;

/** ATMYAPP_CLIENT_MODE=local renders the local content copy (atmyapp content pull). */
export function resolveClientModeEnv(env: Environment): AtMyAppClientOptions["clientMode"] {
  const value = env.ATMYAPP_CLIENT_MODE?.trim();
  if (!value) return undefined;
  if (!(CLIENT_MODES as readonly string[]).includes(value)) {
    throw new Error("AtMyApp: ATMYAPP_CLIENT_MODE must be online, with-fallback or local.");
  }
  return value as AtMyAppClientOptions["clientMode"];
}

export const ENV_KEYS = [
  "ATMYAPP_CLIENT_MODE",
  "ATMYAPP_SPACE",
  "ATMYAPP_API_KEY",
  "ATMYAPP_BASE_URL",
  "ATMYAPP_API_URL",
  "ATMYAPP_PREVIEW_KEY",
  "ATMYAPP_CODE_COMMIT",
  "ATMYAPP_BUILD_TIME",
] as const;
