import { Command } from "commander";
import { CLI_SESSION_PREFIX } from "../../runtime/auth";
import * as fs from "fs";
import * as path from "path";
import { ApiClient } from "../../runtime/api";
import type { VerifiedCliAuth } from "../../runtime/auth";
import { CliError, EXIT } from "../../runtime/errors";
import { CLI_ENV, detectProjectIdFromUrl } from "../../runtime/session";
import type { UseResult } from "../../runtime/schemas/commands";
import { ensureStoreIgnored } from "../../runtime/store";
import { CLI_VERSION, requireTerminal, runAction } from "../output";
import { setConfig } from "../utils/config";

interface UseCommandOptions {
  token?: string;
  url?: string;
  projectId?: string;
  verbose?: boolean;
  json?: boolean;
}

function ask(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stderr });
    rl.question(query, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function value(given: string | undefined, envName: string, question: string, flag: string, label: string): Promise<string> {
  const provided = given?.trim() || process.env[envName]?.trim();
  if (provided) return provided;
  requireTerminal(`The ${label} is required.`, `${flag} (or set ${envName})`);
  return (await ask(question)).trim();
}

function ignoreSessionFile(cwd: string) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = "\n# AtMyApp configuration\n.ama/session.json\n";
  if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, entry);
  else if (!fs.readFileSync(gitignorePath, "utf8").includes(".ama/session.json")) fs.appendFileSync(gitignorePath, entry);
}

export function useCommand(): Command {
  return new Command("use")
    .description("Connect this folder to an AtMyApp project with a CLI key")
    .option("-t, --token <token>", `CLI key (or ${CLI_ENV.token})`)
    .option("-u, --url <url>", `Project CLI URL (or ${CLI_ENV.url})`)
    .option("-p, --project-id <id>", "Project identifier override")
    .option("--json", "Print the result as JSON", false)
    .option("--verbose", "Enable verbose logging")
    .addHelpText(
      "after",
      `\nIn CI or agent shells you can skip 'use': set ${CLI_ENV.url} and ${CLI_ENV.token} and every command reads them.`,
    )
    .action((options: UseCommandOptions) =>
      runAction(
        options,
        async ({ logger }): Promise<UseResult> => {
          const projectUrl = await value(options.url, CLI_ENV.url, "Enter the project URL: ", "--url", "project URL");
          const authToken = await value(options.token, CLI_ENV.token, "Enter the CLI key: ", "--token", "CLI key");
          if (!projectUrl) throw new CliError("missing_url", "Project URL is required.", { exitCode: EXIT.usage });
          if (!authToken) throw new CliError("missing_token", "CLI key is required.", { exitCode: EXIT.usage });
          if (authToken.startsWith(CLI_SESSION_PREFIX)) {
            throw new CliError("browser_login_token", "Browser login tokens are saved by 'atmyapp login'.", { exitCode: EXIT.auth });
          }

          logger.info("Verifying CLI authentication...");
          let verified: VerifiedCliAuth & { valid: boolean };
          try {
            const api = new ApiClient({ url: projectUrl, token: authToken, projectId: "" }, { cliVersion: CLI_VERSION });
            verified = await api.verifyKey<VerifiedCliAuth & { valid: boolean }>();
            if (!verified?.valid) throw new Error("CLI authentication failed.");
          } catch (error) {
            if (error instanceof CliError && error.code === "upgrade_required") throw error;
            throw new CliError("unauthenticated", error instanceof Error ? error.message : String(error), {
              exitCode: EXIT.auth,
              fix: "Copy a current key from Settings → CLI keys.",
            });
          }

          const requested = options.projectId || detectProjectIdFromUrl(projectUrl);
          if (requested && requested !== verified.projectId) {
            throw new CliError(
              "project_mismatch",
              `CLI key belongs to project '${verified.projectId}', but '${requested}' was provided in the URL or --project-id option.`,
              { exitCode: EXIT.auth },
            );
          }

          const cwd = process.cwd();
          fs.mkdirSync(path.join(cwd, ".ama"), { recursive: true });
          ignoreSessionFile(cwd);
          ensureStoreIgnored(cwd);
          const configData = { token: authToken, projectId: verified.projectId, url: projectUrl };
          setConfig(configData);
          return {
            projectId: verified.projectId,
            keyName: verified.keyName,
            url: projectUrl,
            sessionFile: path.join(cwd, ".ama", "session.json"),
          };
        },
        (result, { logger }) => {
          logger.success(`CLI authentication verified for project '${result.projectId}' (${result.keyName}).`);
          logger.info(`Session file stored at ${result.sessionFile} (added to .gitignore).`);
          logger.warn("Keep your .ama/session.json file private and exclude it from version control.");
        },
      ),
    );
}
