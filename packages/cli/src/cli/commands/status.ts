import chalk from "chalk";
import { Command } from "commander";
import { projectStatus } from "../../runtime/status";
import { connect, runAction, table, withCommonOptions, type CommonOptions } from "../output";

/** `atmyapp status`: the project at a glance, with the commands to act on it. */
export function statusCommand(): Command {
  return withCommonOptions(new Command("status"))
    .description("Show the project at a glance: websites, domains needing attention, open drafts, next steps")
    .addHelpText("after", "\nParts this credential can't read are marked unavailable instead of failing.\n\nExample: atmyapp status --json")
    .action((opts: CommonOptions) => runAction(opts, () => projectStatus(connect(opts).api), (result) => {
      console.log(chalk.bold(result.project.id) + chalk.gray(` · ${result.project.credential === "personal" ? "personal login" : "project key"}`));
      const show = (title: string, value: { available: boolean; reason?: string; items?: Array<Record<string, unknown>> }, columns: string[]) => {
        console.log("\n" + chalk.bold(title));
        if (!value.available) console.log(chalk.gray(`  not available: ${value.reason}`));
        else console.log(table(value.items ?? [], columns));
      };
      show("Websites", result.websites, ["name", "liveReleaseId", "publication"]);
      show("Domains needing attention", result.domains, ["hostname", "phase", "summary"]);
      show("Open drafts", result.drafts, ["name", "reviewState", "itemCount", "owner"]);
      if (result.next.length) {
        console.log("\n" + chalk.bold("Next"));
        result.next.forEach((step, index) => console.log(`${index + 1}. ${step.why}\n   ${chalk.cyan(step.command)}`));
      }
    }));
}
