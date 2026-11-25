import * as fs from "node:fs";
import chalk from "chalk";
import { Command } from "commander";
import { CliError, EXIT } from "../../runtime/errors";
import { applyPlan, describePlan, exportProject, planProject, PROJECT_FILE, readProjectFile } from "../../runtime/desired";
import { connect, runAction, withCommonOptions, type CommonOptions } from "../output";
import { confirm } from "./draftOptions";

/** `atmyapp export | plan | apply`: the project as a file (CliEverywherePlan §5.6). */

type Opts = CommonOptions & { file?: string };

const fileOption = (command: Command) => command.option("--file <path>", `Project file (default: ${PROJECT_FILE})`);

const mark = { create: chalk.green("+"), update: chalk.yellow("~"), delete: chalk.red("-") } as const;
const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null));

type PlanView = ReturnType<typeof describePlan>;
type StepView = PlanView["steps"][number];

function printStep(step: StepView) {
  console.log(`${mark[step.action as keyof typeof mark] ?? " "} ${step.action} ${step.resource} ${chalk.bold(step.key)}`);
  for (const [field, [before, after]] of Object.entries(step.changes)) {
    console.log(chalk.gray(`    ${field}: ${show(before)} → ${show(after)}`));
  }
}

/** Plans are printed from their view: a request body (with a secret value) never reaches output. */
function printPlan(plan: PlanView) {
  if (!plan.steps.length) console.log(chalk.gray("The project already matches the file."));
  for (const step of plan.steps) printStep(step);
  if (plan.pruneWouldDelete.length) {
    console.log(chalk.gray(`\nNot in the file (deleted only with --prune):`));
    for (const step of plan.pruneWouldDelete) printStep(step);
  }
}

export function exportCommand(): Command {
  return fileOption(withCommonOptions(new Command("export")))
    .description("Write the project's websites, presets, domains, languages, forms and secret names to a project file")
    .option("--force", "Replace an existing file")
    .option("--stdout", "Print the file instead of writing it")
    .addHelpText("after", "\nSecret values are never exported: 'apply' reads each from the environment variable of the same name.")
    .action((opts: Opts & { force?: boolean; stdout?: boolean }) => runAction(opts, async () => {
      const file = opts.file ?? PROJECT_FILE;
      if (!opts.stdout && !opts.json && fs.existsSync(file) && !opts.force) {
        throw new CliError("already_exists", `${file} already exists.`, { exitCode: EXIT.conflict, fix: "Pass --force to replace it, or --stdout to print it." });
      }
      const { project, incomplete } = await exportProject(connect(opts).api);
      if (!opts.stdout && !opts.json) fs.writeFileSync(file, JSON.stringify(project, null, 2) + "\n");
      return { file: opts.stdout || opts.json ? null : file, project, incomplete };
    }, (result) => {
      if (result.file) console.log(chalk.green(`Wrote ${result.file}.`) + chalk.gray(" Check it in; 'atmyapp plan' shows what differs."));
      else console.log(JSON.stringify(result.project, null, 2));
      // A section that couldn't be read is left out, so apply won't manage it.
      for (const item of result.incomplete) console.error(chalk.yellow(`Left out ${item.section}: ${item.reason}`));
    }));
}

export function planCommand(): Command {
  return fileOption(withCommonOptions(new Command("plan")))
    .description("Show what 'apply' would change to make the project match the file")
    .option("--prune", "Also delete what the file doesn't list")
    .action((opts: Opts & { prune?: boolean }) => runAction(opts,
      async () => describePlan(await planProject(connect(opts).api, readProjectFile(opts.file), { prune: opts.prune })),
      printPlan));
}

export function applyCommand(): Command {
  return fileOption(withCommonOptions(new Command("apply")))
    .description("Make the project match the file (asks for approval once, as the whole plan)")
    .option("--prune", "Also delete what the file doesn't list")
    .option("--yes", "Don't ask for confirmation")
    .option("--dry-run", "Show the plan and stop (same as 'atmyapp plan')")
    .addHelpText("after", [
      "",
      "Nothing is deleted without --prune. Secrets the file lists that don't exist yet take",
      "their value from the environment variable of the same name.",
      "",
      "Example: STRIPE_KEY=sk_live_… atmyapp apply --yes",
    ].join("\n"))
    .action((opts: Opts & { prune?: boolean; yes?: boolean; dryRun?: boolean }) => runAction(opts, async ({ json }) => {
      const api = connect(opts).api;
      const plan = await planProject(api, readProjectFile(opts.file), { prune: opts.prune });
      const view = describePlan(plan);
      if (!json) printPlan(view);
      if (!plan.steps.length || opts.dryRun) return { ...view, results: [], applied: 0, failed: 0 };
      const deletions = plan.steps.filter((step) => step.action === "delete").length;
      await confirm(opts as never, `\nApply ${plan.steps.length} change${plan.steps.length === 1 ? "" : "s"}${deletions ? `, ${deletions} of them deleting` : ""}?`);
      const outcome = await applyPlan(api, plan, {
        onStep: json ? undefined : (step, result) => {
          if (result !== "done") console.error(chalk[result === "failed" ? "red" : "gray"](`  ${result}: ${step.action} ${step.resource} ${step.key}`));
        },
      });
      if (outcome.failed) {
        throw new CliError("apply_incomplete", `${outcome.applied} of ${plan.steps.length} changes applied; ${outcome.failed} failed or were skipped.`, {
          details: { ...view, ...outcome }, fix: "Fix the cause and run 'atmyapp apply' again: it only does what's still missing.",
        });
      }
      return { ...view, ...outcome };
    }, (result) => {
      if (result.applied) console.log(chalk.green(`\nApplied ${result.applied} change${result.applied === 1 ? "" : "s"}.`));
    }));
}
