import { CliError, EXIT } from "./errors";
import { cliApiUrl } from "./auth";

/** The CLI's own credentials. Websites use ATMYAPP_API_URL / ATMYAPP_API_KEY instead. */
export const CLI_ENV = {
  url: "ATMYAPP_CLI_URL",
  token: "ATMYAPP_CLI_KEY",
  projectId: "ATMYAPP_PROJECT_ID",
} as const;

export interface CliSession {
  token: string;
  projectId: string;
  /** Project API base, e.g. https://api.atmyapp.com/v0/projects/<id>. */
  url: string;
}

export interface CredentialSources {
  /** Command-line flags (highest precedence). */
  flags?: { token?: string; url?: string; projectId?: string };
  /** Usually process.env. */
  env?: Record<string, string | undefined>;
  /** Contents of .ama/session.json, if any. */
  sessionFile?: Partial<CliSession> | null | (() => Partial<CliSession> | null);
  loginSession?: CliSession | null | (() => CliSession | null);
}

export type CredentialSource = "flag" | "env" | "login" | "session-file";

export interface ResolvedSession extends CliSession {
  sources: { token: CredentialSource; url: CredentialSource; projectId: CredentialSource | "url" };
}

export function connectionOverride(
  name: "token" | "url" | "projectId",
  sources: CredentialSources,
): { value?: string; source?: CredentialSource } {
  const flag = sources.flags?.[name]?.trim();
  if (flag) return { value: flag, source: "flag" };
  const env = sources.env?.[CLI_ENV[name]]?.trim();
  if (env) return { value: env, source: "env" };
  return {};
}

export function detectProjectIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/projects\/([^/?#]+)/i);
  try { return match ? decodeURIComponent(match[1]) : undefined; }
  catch { return undefined; }
}

/**
 * Credentials for a command: flags, then ATMYAPP_CLI_* environment variables,
 * then a matching browser login, then .ama/session.json.
 */
export function resolveCredentials(sources: CredentialSources): ResolvedSession {
  const requestedUrl = connectionOverride("url", sources);
  const requestedProject = connectionOverride("projectId", sources).value ??
    (requestedUrl.value && detectProjectIdFromUrl(requestedUrl.value));
  let login: CliSession | null | undefined;
  let file: Partial<CliSession> | null | undefined;
  let inspectedLogin = false;
  let inspectedFile = false;

  function pick(name: keyof CliSession): { value?: string; source?: CredentialSource } {
    const override = connectionOverride(name, sources);
    if (override.value) return override;
    if (!inspectedLogin) {
      login = typeof sources.loginSession === "function" ? sources.loginSession() : sources.loginSession;
      inspectedLogin = true;
      if (login && requestedProject && login.projectId !== requestedProject) login = null;
      if (login && requestedUrl.value) {
        try {
          if (cliApiUrl(login.url, "") !== cliApiUrl(requestedUrl.value, "")) login = null;
        } catch { login = null; }
      }
    }
    if (login) return { value: login[name], source: "login" };
    if (!inspectedFile) {
      file = typeof sources.sessionFile === "function" ? sources.sessionFile() : sources.sessionFile;
      inspectedFile = true;
    }
    const value = file?.[name]?.trim();
    return value ? { value, source: "session-file" } : {};
  }

  const token = pick("token");
  const url = pick("url");
  let projectId: { value?: string; source?: CredentialSource | "url" } = connectionOverride("projectId", sources);
  if (!projectId.value && requestedProject) projectId = { value: requestedProject, source: "url" };
  if (!projectId.value) projectId = pick("projectId");
  if (!projectId.value && url.value) {
    const fromUrl = detectProjectIdFromUrl(url.value);
    if (fromUrl) projectId = { value: fromUrl, source: "url" };
  }

  const connect = `Run 'atmyapp login' or set ${CLI_ENV.url} and ${CLI_ENV.token}.`;
  if (!token.value && !url.value) {
    throw new CliError("not_connected", "This folder is not connected to an AtMyApp project.", {
      exitCode: EXIT.auth,
      fix: connect,
    });
  }
  if (!token.value) {
    throw new CliError("missing_token", "The CLI key is missing.", { exitCode: EXIT.auth, fix: connect });
  }
  if (!url.value) {
    throw new CliError("missing_url", "The project URL is missing.", { exitCode: EXIT.auth, fix: connect });
  }
  if (!projectId.value) {
    throw new CliError(
      "missing_project_id",
      "The project ID is missing: the URL does not contain /projects/<id>.",
      { exitCode: EXIT.usage, fix: `Pass --project-id or set ${CLI_ENV.projectId}.` },
    );
  }

  return {
    token: token.value,
    url: url.value.replace(/\/+$/, ""),
    projectId: projectId.value,
    sources: { token: token.source!, url: url.source!, projectId: projectId.source! },
  };
}
