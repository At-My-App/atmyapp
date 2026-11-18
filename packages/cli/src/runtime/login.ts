import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ApiClient, projectApiUrl, type ApiClientOptions } from "./api";
import { type BrowserLogin, readBrowserLogin, removeBrowserLogin, saveBrowserLogin } from "./credentials";
import { CliError, EXIT } from "./errors";

export const PROJECT_KEY_SCOPES = [
  "schema.read", "content.read", "content.stage", "schema.push", "snapshot",
  "forms.tail", "content.publish", "hosting.read", "hosting.deploy",
] as const;
const loginScopes = [...PROJECT_KEY_SCOPES, "keys.manage"] as const;
export const DEFAULT_LOGIN_URL = "https://api.atmyapp.com";

export function parseScopes(input: string | undefined, forLogin: boolean): string[] {
  const accepted: readonly string[] = forLogin ? loginScopes : PROJECT_KEY_SCOPES;
  const requested = input === undefined && forLogin ? ["schema.read", "content.read"] : (input ?? "").trim().split(/[,\s]+/).filter(Boolean);
  if (!requested.length || requested.some((scope) => !accepted.includes(scope))) {
    throw new CliError("invalid_scopes", "Choose scopes from " + accepted.join(", ") + ".", { exitCode: EXIT.usage });
  }
  return [...new Set(requested)];
}

function requireSecureUrl(input: string): URL {
  try {
    const url = new URL(input);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol === "https:" || (loopback && url.protocol === "http:")) && !url.username && !url.password) return url;
  } catch { /* Handled below. */ }
  throw new CliError("invalid_url", "Browser login requires an HTTPS URL or a local loopback URL.", { exitCode: EXIT.usage });
}

const deviceSchema = z.object({
  deviceCode: z.string().regex(/^[a-f0-9]{64}$/),
  userCode: z.string().regex(/^[A-Z2-9]{8}$/),
  verificationUrl: z.string(),
  interval: z.int().positive(),
  expiresIn: z.int().positive().max(900),
});
const exchangeSchema = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({ token: z.string().regex(/^ama_cs_[a-f0-9]{64}$/), projectId: z.string().min(1), expiresAt: z.iso.datetime({ offset: true }) }),
]);
export const loginResultSchema = z.discriminatedUnion("dryRun", [
  z.object({ dryRun: z.literal(true), projectId: z.string().nullable(), url: z.string(), scopes: z.array(z.string()) }),
  z.object({ dryRun: z.literal(false), projectId: z.string(), url: z.string(), expiresAt: z.string(), storage: z.enum(["file", "keychain"]) }),
]);
export const logoutResultSchema = z.object({ loggedOut: z.boolean(), dryRun: z.boolean() });

async function revokeLogin(login: BrowserLogin, options?: ApiClientOptions) {
  const api = new ApiClient(login, options);
  await api.cliAuth("DELETE", "session", { allow: [401], signal: AbortSignal.timeout(15_000) });
}

export async function login(
  input: { url: string; projectId?: string; scopes: string[]; dryRun?: boolean },
  options: ApiClientOptions & {
    verify: (verificationUrl: string, userCode: string) => void;
    pause?: (ms: number) => Promise<unknown>;
    file?: string;
  },
): Promise<z.infer<typeof loginResultSchema>> {
  const apiUrl = requireSecureUrl(input.url).href;
  if (input.dryRun) return { dryRun: true, url: apiUrl, projectId: input.projectId ?? null, scopes: input.scopes };
  const api = new ApiClient({ token: "", url: apiUrl, projectId: input.projectId ?? "" }, options);
  const started = deviceSchema.safeParse(await api.cliAuth("POST", "device", {
    body: { projectId: input.projectId, scopes: input.scopes }, signal: AbortSignal.timeout(15_000),
  }));
  if (!started.success) throw new CliError("invalid_response", "The server returned an invalid CLI login request.");
  const device = started.data;
  const deadline = Date.now() + device.expiresIn * 1000;
  const pause = options.pause ?? delay;
  let interval = device.interval * 1000;
  options.verify(requireSecureUrl(device.verificationUrl).href, device.userCode);
  while (Date.now() + interval < deadline) {
    await pause(interval);
    const remaining = deadline - Date.now();
    if (remaining < 1) break;
    const exchanged = await api.cliAuth("POST", "token", {
      body: { deviceCode: device.deviceCode }, signal: AbortSignal.timeout(Math.min(remaining, 15_000)),
    }).catch((error: unknown) => {
      if (!(error instanceof CliError)) throw error;
      if (error.code === "slow_down") interval += 5000;
      else if (error.code !== "network" && error.code !== "server_error") throw error;
      return { status: "pending" };
    });
    const result = exchangeSchema.safeParse(exchanged);
    if (!result.success) throw new CliError("invalid_response", "The server returned an invalid CLI login response.");
    if ("status" in result.data) continue;
    const entry = { ...result.data, url: projectApiUrl(apiUrl, result.data.projectId, "") };
    try {
      if (input.projectId && entry.projectId !== input.projectId)
        throw new CliError("project_mismatch", "The server approved a different project.", { exitCode: EXIT.auth });
      const { backend, replaced } = saveBrowserLogin(entry, options.file);
      if (replaced && replaced.token !== entry.token) await revokeLogin(replaced, options).catch(() => undefined);
      return { dryRun: false, projectId: entry.projectId, url: entry.url, expiresAt: entry.expiresAt, storage: backend };
    } catch (error) {
      await revokeLogin(entry, options).catch(() => undefined);
      throw error;
    }
  }
  throw new CliError("device_expired", "The CLI login request expired.", {
    exitCode: EXIT.auth, fix: "Run 'atmyapp login' again.",
  });
}

export async function logout(options: ApiClientOptions & { dryRun?: boolean; file?: string } = {}) {
  const entry = readBrowserLogin({ includeExpired: true, requireAvailable: true, file: options.file });
  if (!entry || options.dryRun) return { loggedOut: false, dryRun: Boolean(options.dryRun) };
  if (Date.parse(entry.expiresAt) > Date.now()) await revokeLogin(entry, options);
  removeBrowserLogin(entry, options.file);
  return { loggedOut: true, dryRun: false };
}
