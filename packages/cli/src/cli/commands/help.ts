import { Command } from "commander";
import { EXIT } from "../../runtime/errors";
import { printJson } from "../output";

export interface CommandDescription {
  name: string;
  path: string;
  description: string;
  arguments: Array<{ name: string; required: boolean; variadic: boolean; description: string }>;
  options: Array<{ flags: string; description: string; default?: unknown; choices?: string[]; required: boolean }>;
  commands: CommandDescription[];
}

export function describeCommand(command: Command, parents: string[] = []): CommandDescription {
  const path = [...parents, command.name()];
  return {
    name: command.name(),
    path: path.join(" "),
    description: command.description(),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required,
      variadic: argument.variadic,
      description: argument.description,
    })),
    options: command.options
      .filter((option) => !option.hidden)
      .map((option) => ({
        flags: option.flags,
        description: option.description,
        required: Boolean(option.mandatory),
        ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
        ...(option.argChoices ? { choices: option.argChoices } : {}),
      })),
    commands: command.commands.filter((child) => child.name() !== "help").map((child) => describeCommand(child, path)),
  };
}

/** `atmyapp help [command…] [--json]`: the command tree, for people or agents. */
export function helpCommand(program: Command): Command {
  return new Command("help")
    .description("Show help for a command; --json describes every command, argument and option")
    .argument("[command...]", "Command path, e.g. content get")
    .option("--json", "Print the command tree as JSON", false)
    .action((names: string[], options: { json?: boolean }) => {
      let target: Command = program;
      for (const name of names) {
        const next = target.commands.find((child) => child.name() === name || child.aliases().includes(name));
        if (!next) {
          console.error(`Unknown command: ${names.join(" ")}`);
          process.exitCode = EXIT.usage;
          return;
        }
        target = next;
      }
      if (options.json) {
        printJson({
          ok: true,
          data: {
            ...describeCommand(target, names.length ? [program.name(), ...names.slice(0, -1)] : []),
            exitCodes: EXIT,
            output: "With --json, commands print { ok: true, data } or { ok: false, error: { code, message, fix? } } on stdout.",
          },
        });
      } else target.outputHelp();
    });
}
