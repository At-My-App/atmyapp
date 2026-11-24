import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { Command } from "commander";
import { waitTimeout } from "../../runtime/duration";
import {
  previewBranch,
  previewLogs,
  previewPull,
  previewRestart,
  previewStart,
  previewStatus,
  previewStop,
  previewUrl,
  type InstanceSummary,
} from "../../runtime/previewServers";
import { connect, runAction, table, withCommonOptions, type CommonOptions } from "../output";

type TargetOptions = CommonOptions & { server?: string; instance?: string };
type WaitOptions = TargetOptions & { wait?: boolean; timeout?: string };

const TARGET_HELP =
  "\nWithout --instance, the server's only instance (or its only serve instance) is used; with several, the command lists them (instance_required, exit 2).";

function withTarget(command: Command, options: { instance?: boolean } = {}): Command {
  command.option("--server <name>", "Which preview server (default: the only one)");
  if (options.instance !== false) command.option("--instance <id>", "Which instance of the server");
  return command;
}

function withWait(command: Command): Command {
  return command
    .option("--wait", "Wait until it is running (or stopped)")
    .option("--timeout <duration>", "Longest wait with --wait: 5s to 15m (default 3m)");
}

const STATE_COLOR: Record<string, (text: string) => string> = {
  ready: chalk.green, starting: chalk.cyan, stopping: chalk.cyan, error: chalk.red,
};

function instanceLine(instance: InstanceSummary | null) {
  if (!instance) return "";
  const color = STATE_COLOR[instance.state] ?? chalk.gray;
  return `${instance.id}  ${color(instance.state)}${instance.branch ? `  ${instance.branch}` : ""}${instance.lastError ? chalk.yellow(`  ${instance.lastError}`) : ""}`;
}

function progress(json: boolean) {
  return json ? undefined : (state: string) => console.error(chalk.gray(`… ${state}`));
}

export function previewCommand(): Command {
  const command = new Command("preview").description("Check and control the preview server that shows drafts");

  command.addCommand(withTarget(withCommonOptions(new Command("status")), { instance: false })
    .description("Every preview server and instance: state, branch and last error")
    .addHelpText("after", "\nStates match 'stage preview': ready, starting, stopping, stopped, error.\n\nExample: atmyapp preview status --json")
    .action((opts: TargetOptions) => runAction(opts, () => previewStatus(connect(opts).api, opts), (result) => {
      if (!result.servers.length) console.log(chalk.gray("This project has no preview server."));
      for (const server of result.servers) {
        console.log(`${chalk.bold(server.name)}  ${(STATE_COLOR[server.state] ?? chalk.gray)(server.state)}${server.branch ? chalk.gray(`  ${server.branch}`) : ""}`);
        console.log(table(server.instances.map((instance) => ({
          id: instance.id, role: instance.role, state: instance.state, branch: instance.branch, error: instance.lastError,
        })), ["id", "role", "state", "branch", "error"]));
      }
    })));

  command.addCommand(withTarget(withCommonOptions(new Command("logs"), { ndjson: true }))
    .description("The server's output and start/stop events. With --json, NDJSON.")
    .option("--follow", "Keep printing new output until Ctrl+C")
    .option("--build", "The last build's log instead")
    .addHelpText("after", `${TARGET_HELP}\nNeeds build log access (scope hosting.logs).\n\nExample: atmyapp preview logs --follow --json`)
    .action((opts: TargetOptions & { follow?: boolean; build?: boolean }) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      return runAction(opts, ({ json }) => previewLogs(connect(opts).api, {
        ...opts,
        signal: controller.signal,
        emit: (record) => {
          if (json) process.stdout.write(JSON.stringify(record) + "\n");
          else if (record.type === "log") console.log(stripVTControlCharacters(record.line));
          else if (record.type === "event") console.error(chalk.gray(`${record.at ?? ""} ${record.kind} ${record.message}`.trim()));
          else console.error(chalk.gray("Log restarted."));
        },
      }), () => undefined, { ndjson: true }).finally(() => process.off("SIGINT", stop));
    }));

  for (const [name, description, run] of [
    ["start", "Start an instance", previewStart],
    ["stop", "Stop an instance", previewStop],
  ] as const) {
    command.addCommand(withWait(withTarget(withCommonOptions(new Command(name))))
      .description(description)
      .addHelpText("after", `${TARGET_HELP}\nWith --wait, exits 8 when it's still changing at the timeout.\n\nExample: atmyapp preview ${name} --wait`)
      .action((opts: WaitOptions) => runAction(opts, ({ json }) => run(connect(opts).api, {
        ...opts, timeoutMs: waitTimeout("preview", opts.timeout), onProgress: opts.wait ? progress(json) : undefined,
      }), (result) => console.log(`${result.server.name}: ${result.action} requested.\n${instanceLine(result.instance)}`))));
  }

  command.addCommand(withWait(withTarget(withCommonOptions(new Command("restart"))))
    .description("Restart the preview server, for example after it broke or settings changed")
    .addHelpText("after", "\nRestarts the whole server. --instance only chooses which instance --wait follows.\n\nExample: atmyapp preview restart --wait")
    .action((opts: WaitOptions) => runAction(opts, ({ json }) => previewRestart(connect(opts).api, {
      ...opts, timeoutMs: waitTimeout("preview", opts.timeout), onProgress: opts.wait ? progress(json) : undefined,
    }), (result) => console.log(`${result.server.name}: restarting.${result.instance ? `\n${instanceLine(result.instance)}` : ""}`))));

  command.addCommand(withTarget(withCommonOptions(new Command("url")))
    .description("A link that opens the running preview")
    .addHelpText("after", `${TARGET_HELP}\nFor one draft's link, use 'atmyapp stage preview'.\n\nExample: atmyapp preview url --json`)
    .action((opts: TargetOptions) => runAction(opts, () => previewUrl(connect(opts).api, opts), (result) => console.log(result.url))));

  command.addCommand(withTarget(withCommonOptions(new Command("branch")))
    .description("Switch the instance to another Git branch")
    .argument("<name>", "Branch name")
    .addHelpText("after", `${TARGET_HELP}\n\nExample: atmyapp preview branch feature/menu`)
    .action((branch: string, opts: TargetOptions) => runAction(opts, () => previewBranch(connect(opts).api, branch, opts),
      (result) => console.log(`${result.server.name}: switched to ${result.branch}.`))));

  command.addCommand(withTarget(withCommonOptions(new Command("pull")))
    .description("Pull the latest commits of the instance's branch")
    .addHelpText("after", `${TARGET_HELP}\n\nExample: atmyapp preview pull`)
    .action((opts: TargetOptions) => runAction(opts, () => previewPull(connect(opts).api, opts),
      (result) => console.log(`${result.server.name}: pulled${result.branch ? ` ${result.branch}` : ""}.`))));

  return command;
}
