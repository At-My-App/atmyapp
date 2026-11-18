import { CliError, EXIT } from "./errors";

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
  sessionFile?: { token?: string; url?: string; projectId?: string } | null;
}

export type CredentialSource = "flag" | "env" | "session-file";

export interface ResolvedSession extends CliSession {
  sources: { token: CredentialSource; url: CredentialSource; projectId: CredentialSource | "url" };
}

function pick(
  name: "token" | "url" | "projectId",
  sources: CredentialSources,
): { value?: string; source?: CredentialSource } {
  const flag = sources.flags?.[name]?.trim();
  if (flag) return { value: flag, source: "flag" };
  const env = sources.env?.[CLI_ENV[name]]?.trim();
  if (env) return { value: env, source: "env" };
  const file = sources.sessionFile?.[name]?.trim();
  if (file) return { value: file, source: "session-file" };
  return {};
}

export function detectProjectIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/projects\/([^/?#]+)/i);
  return match?.[1];
}

/**
 * Credentials for a command: flags, then ATMYAPP_CLI_* environment variables,
 * then .ama/session.json. The project ID falls back to the one in the URL.
 */
export function resolveCredentials(sources: CredentialSources): ResolvedSession {
  const token = pick("token", sources);
  const url = pick("url", sources);
  let projectId: { value?: string; source?: CredentialSource | "url" } = pick("projectId", sources);
  if (!projectId.value && url.value) {
    const fromUrl = detectProjectIdFromUrl(url.value);
    if (fromUrl) projectId = { value: fromUrl, source: "url" };
  }

  const connect = `Run 'atmyapp use --url <cli-url> --token <cli-key>', or set ${CLI_ENV.url} and ${CLI_ENV.token}.`;
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
