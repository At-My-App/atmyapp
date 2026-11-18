import { Command } from "commander";
import { z } from "zod";
import { CliError, EXIT } from "../../runtime/errors";
import { outputSchemaFor, type CommandDescription, type HelpResult } from "../../runtime/schemas/help";
import { printJson } from "../output";

export type { CommandDescription } from "../../runtime/schemas/help";

export function describeCommand(command: Command): CommandDescription {
  const path = [command.name()];
  for (let parent = command.parent; parent; parent = parent.parent) path.unshift(parent.name());
  const schema = outputSchemaFor(path.slice(1).join(" "));
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
    ...(schema ? { outputSchema: z.toJSONSchema(schema) } : {}),
    commands: command.commands.map(describeCommand),
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
          const error = new CliError("unknown_command", `Unknown command: ${names.join(" ")}`, { exitCode: EXIT.usage });
          if (options.json) printJson({ ok: false, error: error.toJSON() });
          else console.error(error.message);
          process.exitCode = error.exitCode;
          return;
        }
        target = next;
      }
      if (options.json) {
        const data: HelpResult = {
          ...describeCommand(target),
          exitCodes: EXIT,
          output: "Each outputSchema describes the JSON that command writes, including errors or one record per line for submissions tail.",
        };
        printJson({ ok: true, data });
      } else target.outputHelp();
    });
}
