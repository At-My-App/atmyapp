import chalk from "chalk";
import { Command } from "commander";
import { isPersonalCredential } from "../../runtime/auth";
import { CliError } from "../../runtime/errors";
import type { WhoamiResult } from "../../runtime/schemas/commands";
import { connect, connectAccount, runAction, withCommonOptions, type CommonOptions } from "../output";

interface VerifyResponse {
  valid: boolean;
  kind?: "projectKey" | "login" | "token";
  projectId: string | null;
  projectLimit?: unknown;
  keyName: string;
  scopes: string[];
  keyHint?: string;
  keyId?: string;
  createdAt?: string;
  expiresAt?: string | null;
  /** Scopes it may use now in the project (implied ones included). */
  effectiveScopes?: string[] | null;
  stoppedReason?: string | null;
}

export type { WhoamiResult } from "../../runtime/schemas/commands";

function reach(limit: unknown): string {
  const value = limit as { kind?: string; ids?: string[] } | null;
  if (!value?.kind) return "";
  if (value.kind === "all") return "all your projects";
  return `${value.kind === "orgs" ? "organisations" : "projects"}: ${(value.ids ?? []).join(", ")}`;
}

export function whoamiCommand(): Command {
  return withCommonOptions(new Command("whoami"))
    .description("Show the credential, how far it reaches, and what it may do in the project")
    .action((options: CommonOptions) =>
      runAction(
        options,
        async (): Promise<WhoamiResult> => {
          let connection: { api: ReturnType<typeof connect>["api"]; sources: Record<string, string>; url: string };
          try {
            const { session, api } = connect(options);
            connection = { api, sources: session.sources, url: session.url };
          } catch (error) {
            // A wide login with no project chosen still answers who it is.
            if (!(error instanceof CliError && error.code === "project_required")) throw error;
            const { api, source } = connectAccount(options);
            connection = { api, sources: { token: source, url: source, projectId: "none" }, url: api.session.url };
          }
          const verified = await connection.api.verifyKey<VerifyResponse>();
          const personal = isPersonalCredential(connection.api.session.token);
          return {
            projectId: verified.projectId ?? null,
            url: connection.url,
            key: {
              kind: verified.kind ?? (personal ? "login" : "projectKey"),
              name: verified.keyName,
              hint: verified.keyHint ?? null,
              id: verified.keyId ?? null,
              createdAt: verified.createdAt ?? null,
              expiresAt: verified.expiresAt ?? null,
              projectLimit: verified.projectLimit ?? null,
              scopes: verified.scopes ?? [],
              effectiveScopes: verified.effectiveScopes === undefined ? verified.scopes ?? [] : verified.effectiveScopes,
              stoppedReason: verified.stoppedReason ?? null,
            },
            sources: connection.sources,
          };
        },
        (result) => {
          const kinds = { projectKey: "Project key", login: "Browser login", token: "Personal token" };
          console.log(`${chalk.bold("Project")}  ${result.projectId ?? chalk.gray("none chosen ('atmyapp projects use <id>')")}`);
          console.log(`${chalk.bold("URL")}      ${result.url}`);
          console.log(`${chalk.bold(kinds[result.key.kind].padEnd(8))} ${result.key.name}${result.key.hint ? chalk.gray(` (${result.key.hint})`) : ""}`);
          if (result.key.projectLimit) console.log(`${chalk.bold("Reaches")}  ${reach(result.key.projectLimit)}`);
          if (result.key.expiresAt) console.log(`${chalk.bold("Expires")}  ${result.key.expiresAt}`);
          console.log(`${chalk.bold("May")}      ${result.key.effectiveScopes === null ? result.key.scopes.join(", ") : result.key.effectiveScopes.join(", ") || chalk.red("nothing")}`);
          if (result.key.stoppedReason) console.log(chalk.yellow(`Warning: ${result.key.stoppedReason}`));
          console.log(chalk.gray(`Credentials from: ${Object.entries(result.sources).map(([name, source]) => `${name}=${source}`).join(", ")}`));
        },
      ),
    );
}
