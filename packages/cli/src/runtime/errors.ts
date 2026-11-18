/**
 * Exit codes every command uses (AgenticCliPlan.md §3). Agents branch on
 * these, so they never change meaning.
 */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** Missing, invalid or revoked credentials, or a key without the scope. */
  auth: 3,
  /** Content or schema failed validation. */
  validation: 4,
  /** Someone else changed the content first. */
  conflict: 5,
  /** The command needs a person to confirm (no terminal, no --yes). */
  confirmation: 6,
  /** A session is expired, in review, or otherwise not writable. */
  session: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliErrorOptions {
  exitCode?: ExitCode;
  /** A command or step that fixes the problem. */
  fix?: string;
  /** JSON pointer of the value the error is about. */
  pointer?: string;
  /** HTTP status, when the error came from the server. */
  status?: number;
  details?: Record<string, unknown>;
}

/**
 * An error with a stable machine `code`. `--json` output prints it as
 * `{ ok: false, error: { code, message, fix?, pointer?, … } }`.
 */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly fix?: string;
  readonly pointer?: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT.error;
    this.fix = options.fix;
    this.pointer = options.pointer;
    this.status = options.status;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.fix ? { fix: this.fix } : {}),
      ...(this.pointer !== undefined ? { pointer: this.pointer } : {}),
      ...(this.status ? { status: this.status } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("unexpected", message);
}
