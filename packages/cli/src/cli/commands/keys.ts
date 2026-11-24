import { Command } from "commander";
import { createKey, listKeys, revokeKey } from "../../runtime/keys";
import { CliError, EXIT } from "../../runtime/errors";
import { KEY_PRESETS, keyScopes } from "../../runtime/scopes";
import { connect, runAction, table, withCommonOptions, type CommonOptions } from "../output";

export const keysCommand = () => new Command("keys")
  .description("Manage project keys using a browser login")
  .addCommand(withCommonOptions(new Command("ls"))
    .description("List project key hints and content API keys")
    .addHelpText("after", "\nExample: atmyapp keys ls --json")
    .action((options: CommonOptions) => runAction(options, () => listKeys(connect(options).api), (result) => {
      console.log("Project keys");
      console.log(table(result.projectKeys, ["id", "name", "key_hint", "scopes", "status"]));
      console.log("Content API keys");
      console.log(table(result.contentApiKeys, ["id", "name", "environment_id"]));
    })))
  .addCommand(withCommonOptions(new Command("create"))
    .description("Create a key and write its value to an env file")
    .requiredOption("--name <name>", "Key name")
    .option("--preset <name>", `What it's for: ${Object.keys(KEY_PRESETS).join(", ")}`)
    .option("--scopes <list>", "Comma-separated project key scopes, instead of --preset")
    .option("--env-file <path>", "Where to write ATMYAPP_CLI_KEY", ".env.local")
    .option("--dry-run", "Show the target file and scopes before creating anything")
    .option("--replace", "Revoke the active key with this name and create its replacement")
    .addHelpText("after", "\nProject keys are for CI and servers and belong to the project; on your own computer, use 'atmyapp login'.\nNames are unique among active keys. If a key was created but its secret was lost (key_secret_lost), run the same command with --replace.\n\nExample: atmyapp keys create --name CI --preset ci-deploy --env-file .env.local")
    .action((options: CommonOptions & { name: string; preset?: string; scopes?: string; envFile: string; dryRun?: boolean; replace?: boolean }) =>
      runAction(options, () => {
        const scopes = keyScopes(options);
        if (!scopes) throw new CliError("invalid_options", "Pass --preset or --scopes.", { exitCode: EXIT.usage, fix: `Presets: ${Object.keys(KEY_PRESETS).join(", ")}.` });
        return createKey(connect(options).api, { ...options, scopes });
      },
        (result) => console.log(result.dryRun
          ? "Would create " + result.name + " with " + result.scopes.join(", ") + " and write " + result.envFile + "."
          : "Created " + result.hint + ". Saved in " + result.envFile + "."))))
  .addCommand(withCommonOptions(new Command("revoke"))
    .description("Revoke one project key by row ID")
    .argument("<id>", "Project key ID from keys ls")
    .option("--dry-run", "Show the requested revocation without changing the key")
    .addHelpText("after", "\nExample: atmyapp keys revoke <id> --dry-run")
    .action((id: string, options: CommonOptions & { dryRun?: boolean }) =>
      runAction(options, () => revokeKey(connect(options).api, id, options.dryRun),
        (result) => console.log((result.dryRun ? "Would revoke " : "Revoked ") + result.id + "."))));
