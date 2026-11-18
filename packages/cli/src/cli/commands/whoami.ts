import chalk from "chalk";
import { Command } from "commander";
import { connect, runAction, withCommonOptions, type CommonOptions } from "../output";

interface VerifyResponse {
  valid: boolean;
  projectId: string;
  keyName: string;
  scopes: string[];
  keyHint?: string;
  keyId?: string;
  createdAt?: string;
  /** Scopes the key may use now (implied ones included, narrowed by its creator). */
  effectiveScopes?: string[];
  stoppedReason?: string | null;
}

export interface WhoamiResult {
  projectId: string;
  url: string;
  key: {
    name: string;
    hint: string | null;
    id: string | null;
    createdAt: string | null;
    scopes: string[];
    effectiveScopes: string[];
    stoppedReason: string | null;
  };
  /** Where each credential came from: flag, env or session-file. */
  sources: Record<string, string>;
}

export function whoamiCommand(): Command {
  return withCommonOptions(new Command("whoami"))
    .description("Show the connected project, the CLI key and what it may do")
    .action((options: CommonOptions) =>
      runAction(
        options,
        async (): Promise<WhoamiResult> => {
          const { session, api } = connect(options);
          const verified = await api.verifyKey<VerifyResponse>();
          return {
            projectId: verified.projectId,
            url: session.url,
            key: {
              name: verified.keyName,
              hint: verified.keyHint ?? null,
              id: verified.keyId ?? null,
              createdAt: verified.createdAt ?? null,
              scopes: verified.scopes ?? [],
              effectiveScopes: verified.effectiveScopes ?? verified.scopes ?? [],
              stoppedReason: verified.stoppedReason ?? null,
            },
            sources: session.sources,
          };
        },
        (result) => {
          console.log(`${chalk.bold("Project")}  ${result.projectId}`);
          console.log(`${chalk.bold("URL")}      ${result.url}`);
          console.log(`${chalk.bold("Key")}      ${result.key.name}${result.key.hint ? chalk.gray(` (${result.key.hint})`) : ""}`);
          console.log(`${chalk.bold("May")}      ${result.key.effectiveScopes.join(", ") || chalk.red("nothing")}`);
          if (result.key.stoppedReason) console.log(chalk.yellow(`Warning: ${result.key.stoppedReason}`));
          console.log(chalk.gray(`Credentials from: ${Object.entries(result.sources).map(([name, source]) => `${name}=${source}`).join(", ")}`));
        },
      ),
    );
}
