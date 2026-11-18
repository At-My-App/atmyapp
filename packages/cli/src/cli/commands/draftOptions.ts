import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { CliError, EXIT } from "../../runtime/errors";
import { currentSpace } from "../../runtime/spaces";
import { ContentStore } from "../../runtime/store";
import { WorkingCopy } from "../../runtime/workingCopy";
import { connect, requireTerminal, withCommonOptions, type CommonOptions } from "../output";

export interface DraftOptions extends CommonOptions {
  space?: string;
  dryRun?: boolean;
  yes?: boolean;
}

export function draftOptions(command: Command, options: { write?: boolean; space?: boolean; confirm?: boolean } = {}) {
  withCommonOptions(command);
  if (options.space !== false)
    command.option("--space <name>", "Use a space (overrides ATMYAPP_SPACE and .ama/content/.current)");
  if (options.write) command.option("--dry-run", "Show the planned change without making it", false);
  if (options.confirm) command.option("--yes", "Confirm without prompting", false);
  return command;
}

export function workFor(options: DraftOptions, store = new ContentStore()) {
  return new WorkingCopy(store, currentSpace(store, options.space ?? process.env.ATMYAPP_SPACE));
}

export function maybeConnect(options: CommonOptions) {
  try {
    return connect(options).api;
  } catch (error) {
    if (
      error instanceof CliError &&
      ["not_connected", "missing_token", "missing_url", "missing_project_id"].includes(error.code) &&
      !options.url &&
      !options.token &&
      !options.projectId
    )
      return undefined;
    throw error;
  }
}

export async function confirm(options: DraftOptions, question: string) {
  if (options.dryRun || options.yes) return;
  requireTerminal(question, "--yes");
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(question + " [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim()))
      throw new CliError("needs_confirmation", "No changes were made.", { exitCode: EXIT.confirmation });
  } finally {
    terminal.close();
  }
}
