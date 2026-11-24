import chalk from "chalk";
import { Command, Option } from "commander";
import * as fs from "fs";
import * as path from "path";
import { ApiClient, replayState, type PendingApproval } from "../runtime/api";
import { waitTimeout } from "../runtime/duration";
import { CliError, EXIT, toCliError } from "../runtime/errors";
import { resolveCredentials, type ResolvedSession } from "../runtime/session";
import { browserLoginAccount, browserLoginSession, updateBrowserLoginExpiry } from "../runtime/credentials";
import { isPersonalCredential } from "../runtime/auth";
import { CLI_ENV, detectProjectIdFromUrl } from "../runtime/session";
import { DEFAULT_LOGIN_URL } from "../runtime/login";
import { detectAgent } from "../runtime/agent";
import { Logger } from "./logger";

// Resolves from both src/cli and dist/cli to the package root.
export const CLI_VERSION: string = (require("../../package.json") as { version: string }).version;

export interface ConnectionOptions {
  token?: string;
  url?: string;
  /** `--project`. */
  project?: string;
  /** `--project-id`, the older spelling (hidden). */
  projectId?: string;
}

export interface CommonOptions extends ConnectionOptions {
  json?: boolean;
  verbose?: boolean;
  /** `--no-wait` sets false: don't wait for an approval (or a build). */
  wait?: boolean;
  /** `--approval-timeout <duration>`. */
  approvalTimeout?: string;
}

/**
 * The connection overrides: `--project`, `--url`, `--token` (and the hidden
 * older `--project-id`). Precedence is flags, then ATMYAPP_CLI_* variables,
 * then a matching browser login, then .ama/session.json
 * (CliEverywherePlan §4.3.5; the login's last used project joins in Phase 1).
 */
export function withConnectionOptions(command: Command): Command {
  return command
    .option("--project <id>", "Project to work on (default: the connected project)")
    .option("--url <url>", "Override the project API URL")
    .option("--token <key>", "Override the CLI credential")
    .addOption(new Option("--project-id <id>", "Same as --project").hideHelp());
}

/** Adds --json, --verbose and the connection overrides every remote command takes. */
export function withCommonOptions(command: Command, output: { ndjson?: boolean } = {}): Command {
  return withConnectionOptions(command
    .option("--json", output.ndjson ? "Print one JSON record per line on stdout" : "Print one JSON document on stdout (logs go to stderr)", false)
    .option("--verbose", "Show more detail", false));
}

/** The project the flags ask for: `--project`, else the older `--project-id`. */
export function requestedProject(options: ConnectionOptions): string | undefined {
  return options.project?.trim() || options.projectId?.trim() || undefined;
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

/**
 * The project a command works on, before credentials are chosen: --project,
 * ATMYAPP_PROJECT_ID, a project in --url, then .ama/session.json
 * (CliEverywherePlan §4.3.5). A wider login falls back to its last
 * `projects use` choice.
 */
function targetProject(options: ConnectionOptions, file: ConnectionOptions | null): string | undefined {
  return requestedProject(options) || process.env[CLI_ENV.projectId]?.trim() ||
    (options.url ? detectProjectIdFromUrl(options.url) : undefined) || file?.projectId || undefined;
}

export function resolveCliSession(options: ConnectionOptions): ResolvedSession {
  const file = readSessionFile();
  return resolveCredentials({
    flags: { token: options.token, url: options.url, projectId: requestedProject(options) },
    env: process.env,
    loginSession: () => browserLoginSession(targetProject(options, file)),
    sessionFile: file,
  });
}

/** Options whose values are secrets: never repeated in output (§11.1 P1-3). */
const SECRET_OPTIONS = new Set(["--token", "-t"]);
const CREDENTIAL = /ama_(pk|cs|pt)_[A-Za-z0-9]+|cli_[A-Za-z0-9]{16,}/;

/**
 * The command as typed, to run again after approving (`details.resume`),
 * without its credential: `--token <value>`, `--token=<value>` and anything
 * that looks like a key are left out. The rerun finds the credential the way
 * this run did (flag aside: environment, login or session file).
 */
export function resumeCommand(argv: readonly string[] = process.argv.slice(2)): string {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--no-wait") continue;
    if (SECRET_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if ([...SECRET_OPTIONS].some((option) => arg.startsWith(`${option}=`))) continue;
    if (CREDENTIAL.test(arg)) continue;
    kept.push(arg);
  }
  const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
  return ["atmyapp", ...kept.map(quote)].join(" ");
}

function approvalOptions(options: CommonOptions) {
  return {
    wait: options.wait !== false,
    timeoutMs: waitTimeout("approval", options.approvalTimeout),
    resume: resumeCommand(),
    // Progress goes to stderr, so --json keeps stdout to the final document.
    onWaiting: (approval: PendingApproval) => {
      console.error(chalk.yellow("Approval needed: ") + approval.summary);
      console.error(approval.url);
      console.error(chalk.gray("Waiting for your approval (phone, dashboard or the link above) — Ctrl+C to stop; run the command again to continue."));
    },
    onStale: (message: string) => console.error(chalk.yellow(message)),
  };
}

function apiOptions(session: { token: string }, source: string | undefined, options: CommonOptions = {}) {
  return {
    cliVersion: CLI_VERSION,
    agent: detectAgent(process.env),
    approval: approvalOptions(options),
    // Keep the saved login's expiry in step with the server's renewals (E34).
    onCredentialRenewed: source === "login" ? (expiresAt: string) => { updateBrowserLoginExpiry(session.token, expiresAt); } : undefined,
  };
}

export function connect(options: CommonOptions): { session: ResolvedSession; api: ApiClient } {
  const session = resolveCliSession(options);
  return { session, api: new ApiClient(session, apiOptions(session, session.sources.token, options)) };
}

/**
 * A connection for account commands (`projects`, `orgs`): a personal
 * credential from --token, ATMYAPP_CLI_KEY or the saved login, and the API
 * URL; no project needed.
 */
export function connectAccount(options: CommonOptions): { api: ApiClient; source: "flag" | "env" | "login"; projectLimit: unknown } {
  const flag = options.token?.trim();
  const env = process.env[CLI_ENV.token]?.trim();
  const login = flag || env ? null : browserLoginAccount();
  const token = flag || env || login?.token;
  if (!token && (() => { try { return readSessionFile()?.token; } catch { return undefined; } })()) {
    throw new CliError("personal_login_required", "This folder is connected with a project key, which can't list or create projects.", {
      exitCode: EXIT.auth,
      fix: "Run 'atmyapp login --preset everything', or set ATMYAPP_CLI_KEY to a personal token.",
    });
  }
  if (!token) {
    throw new CliError("login_required", "Sign in first.", {
      exitCode: EXIT.auth,
      fix: "Run 'atmyapp login --preset everything' (or set ATMYAPP_CLI_KEY to a personal token).",
    });
  }
  if (!isPersonalCredential(token)) {
    throw new CliError("personal_login_required", "Project keys can't list or create projects.", {
      exitCode: EXIT.auth,
      fix: "Run 'atmyapp login', or use a personal token from Account → Personal tokens.",
    });
  }
  const url = options.url?.trim() || process.env[CLI_ENV.url]?.trim() || login?.url || DEFAULT_LOGIN_URL;
  const source = flag ? "flag" : env ? "env" : "login";
  const session = { token, url, projectId: "" };
  return { api: new ApiClient(session, apiOptions(session, source, options)), source, projectLimit: login?.projectLimit ?? null };
}

/**
 * `--no-wait` and `--approval-timeout` on every remote command
 * (CliEverywherePlan §5.4 CLI 4). Added last, after each command's own
 * options, so a command's `--wait` keeps its default.
 */
export function withApprovalOptions(root: Command): Command {
  const visit = (command: Command) => {
    const flags = new Set(command.options.map((option) => option.long));
    if (flags.has("--json") && flags.has("--token")) {
      if (!flags.has("--no-wait")) command.option("--no-wait", "Don't wait when an action needs your approval (or a --wait)");
      if (!flags.has("--approval-timeout")) command.option("--approval-timeout <duration>", "Longest wait for your approval: 5s to 15m (default 3m)");
    }
    command.commands.forEach(visit);
  };
  visit(root);
  return root;
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
  output: { ndjson?: boolean } = {},
): Promise<void> {
  const json = Boolean(options.json);
  const logger = new Logger(Boolean(options.verbose), { stderr: json });
  const context = { logger, json };
  try {
    const result = await action(context);
    if (json) {
      // A rerun of an approved request answered from its receipt (§4.4.6).
      if (!output.ndjson) printJson({ ok: true, data: result, ...(replayState.replayed ? { replayed: true } : {}) });
    }
    else render(result, context);
  } catch (raw) {
    const error = toCliError(raw);
    if (json) {
      const result = { ok: false, error: error.toJSON() };
      if (output.ndjson) process.stdout.write(JSON.stringify(result) + "\n");
      else printJson(result);
    }
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
