import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ApiClient, projectApiUrl, type ApiClientOptions } from "./api";
import { type BrowserLogin, projectLimitSchema, readBrowserLogin, removeBrowserLogin, saveBrowserLogin } from "./credentials";
import { CliError, EXIT } from "./errors";
import { PROJECT_KEY_SCOPES } from "./scopes";

export { PROJECT_KEY_SCOPES };
export const DEFAULT_LOGIN_URL = "https://api.atmyapp.com";
/** The login protocol that may reach several projects (CliEverywherePlan E34). */
export const LOGIN_PROTOCOL = 2;

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
  z.object({
    token: z.string().regex(/^ama_cs_[a-f0-9]{64}$/),
    projectId: z.string().min(1).nullable(),
    expiresAt: z.iso.datetime({ offset: true }),
    projectLimit: projectLimitSchema.nullable().optional(),
  }),
]);
export const loginResultSchema = z.discriminatedUnion("dryRun", [
  z.object({ dryRun: z.literal(true), projectId: z.string().nullable(), url: z.string(), scopes: z.array(z.string()) }),
  z.object({
    dryRun: z.literal(false),
    /** Set when the login is limited to one project. */
    projectId: z.string().nullable(),
    projectLimit: projectLimitSchema.nullable(),
    url: z.string(),
    expiresAt: z.string(),
    storage: z.enum(["file", "keychain"]),
  }),
]);
export const logoutResultSchema = z.object({ loggedOut: z.boolean(), dryRun: z.boolean() });

async function revokeLogin(login: BrowserLogin, options?: ApiClientOptions) {
  const api = new ApiClient({ ...login, projectId: login.projectId ?? "" }, options);
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
  const requested = await api.cliAuth("POST", "device", {
    body: { protocol: LOGIN_PROTOCOL, projectId: input.projectId, scopes: input.scopes }, signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    // A server from before multi-project logins doesn't know the newer scopes.
    if (error instanceof CliError && error.status === 400) {
      throw new CliError("login_unsupported", "This server doesn't accept these login permissions yet.", {
        exitCode: EXIT.usage,
        status: 400,
        fix: "Ask for the older scopes instead, for example: atmyapp login --project <id> --scopes schema.read,content.read",
      });
    }
    throw error;
  });
  const started = deviceSchema.safeParse(requested);
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
    const approved = result.data;
    // One project: keep that project's URL, as before. Wider: keep the API URL.
    const entry: BrowserLogin = {
      token: approved.token,
      projectId: approved.projectId,
      url: approved.projectId ? projectApiUrl(apiUrl, approved.projectId, "") : new URL(apiUrl).origin,
      expiresAt: approved.expiresAt,
      projectLimit: approved.projectLimit ?? (approved.projectId ? { kind: "projects", ids: [approved.projectId] } : null),
      lastProjectId: null,
    };
    try {
      if (input.projectId && entry.projectId !== input.projectId)
        throw new CliError("project_mismatch", "The server approved a different project.", { exitCode: EXIT.auth });
      const { backend, replaced } = saveBrowserLogin(entry, options.file);
      if (replaced && replaced.token !== entry.token) await revokeLogin(replaced, options).catch(() => undefined);
      return {
        dryRun: false, projectId: entry.projectId, projectLimit: entry.projectLimit ?? null,
        url: entry.url, expiresAt: entry.expiresAt, storage: backend,
      };
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
