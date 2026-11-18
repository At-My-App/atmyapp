import chalk from "chalk";
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { ApiClient } from "../runtime/api";
import { CliError, EXIT, toCliError } from "../runtime/errors";
import { resolveCredentials, type ResolvedSession } from "../runtime/session";
import { Logger } from "./logger";

// Resolves from both src/cli and dist/cli to the package root.
export const CLI_VERSION: string = (require("../../package.json") as { version: string }).version;

export interface ConnectionOptions {
  token?: string;
  url?: string;
  projectId?: string;
}

export interface CommonOptions extends ConnectionOptions {
  json?: boolean;
  verbose?: boolean;
}

/** Adds --json, --verbose and the connection overrides every remote command takes. */
export function withCommonOptions(command: Command): Command {
  return command
    .option("--json", "Print one JSON document on stdout (logs go to stderr)", false)
    .option("--verbose", "Show more detail", false)
    .option("--url <url>", "Project CLI URL (overrides ATMYAPP_CLI_URL and .ama/session.json)")
    .option("--token <key>", "CLI key (overrides ATMYAPP_CLI_KEY and .ama/session.json)")
    .option("--project-id <id>", "Project ID, when the URL does not contain it");
}

export function readSessionFile(cwd: string = process.cwd()): ConnectionOptions | null {
  const file = path.join(cwd, ".ama", "session.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new CliError("session_corrupt", `${file} is not valid JSON.`, {
      exitCode: EXIT.auth,
      fix: "Run 'atmyapp use' again to rewrite it.",
    });
  }
}

export function resolveCliSession(options: ConnectionOptions): ResolvedSession {
  return resolveCredentials({
    flags: { token: options.token, url: options.url, projectId: options.projectId },
    env: process.env,
    sessionFile: readSessionFile(),
  });
}

export function connect(options: ConnectionOptions): { session: ResolvedSession; api: ApiClient } {
  const session = resolveCliSession(options);
  return { session, api: new ApiClient(session, { cliVersion: CLI_VERSION }) };
}

/** The only stdout output in --json mode. */
export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Refuses to prompt without a terminal, naming the flag that answers instead. */
export function requireTerminal(question: string, flag: string) {
  if (!process.stdin.isTTY) {
    throw new CliError("needs_confirmation", `${question} No terminal is attached to ask.`, {
      exitCode: EXIT.confirmation,
      fix: `Pass ${flag}.`,
    });
  }
}

export interface ActionContext {
  logger: Logger;
  json: boolean;
}

/**
 * Runs a command: `{ ok: true, data }` on stdout with --json, or `render`
 * for people. Errors print `{ ok: false, error }` (or a message and the fix)
 * and exit with the error's code.
 */
export async function runAction<T>(
  options: CommonOptions,
  action: (context: ActionContext) => Promise<T>,
  render: (result: T, context: ActionContext) => void,
): Promise<void> {
  const json = Boolean(options.json);
  const logger = new Logger(Boolean(options.verbose), { stderr: json });
  const context = { logger, json };
  try {
    const result = await action(context);
    if (json) printJson({ ok: true, data: result });
    else render(result, context);
  } catch (raw) {
    const error = toCliError(raw);
    if (json) printJson({ ok: false, error: error.toJSON() });
    else {
      logger.error(error.message, options.verbose && error.code === "unexpected" ? raw : undefined);
      if (error.fix) console.error(chalk.gray(`  ${error.fix}`));
    }
    process.exitCode = error.exitCode;
  }
}

// --- Small human-readable helpers ---------------------------------------------

export function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (!rows.length) return chalk.gray("(none)");
  const text = (value: unknown) => (value === undefined || value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value));
  const widths = columns.map((column) => Math.min(48, Math.max(column.length, ...rows.map((row) => text(row[column]).length))));
  const line = (values: string[]) => values.map((value, index) => value.slice(0, widths[index]).padEnd(widths[index])).join("  ").trimEnd();
  return [chalk.bold(line(columns)), ...rows.map((row) => line(columns.map((column) => text(row[column]))))].join("\n");
}

export function printValue(value: unknown) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
