import type { CliErrorDetails } from "./schemas/commands";

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
  /**
   * Needs a person: to confirm (no terminal, no --yes), approve, finish a
   * browser step, change DNS or review. `details.reason` says which; see
   * `needsPerson`.
   */
  confirmation: 6,
  /** A session is expired, in review, or otherwise not writable. */
  session: 7,
  /**
   * Still in progress: the command waited until --timeout and the work is
   * still running. Safe to run again or keep waiting (`details.resume`).
   */
  pending: 8,
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
    // Every exit-6 error says why a person is needed (CliEverywherePlan §4.3.2).
    this.details = this.exitCode === EXIT.confirmation && !options.details?.reason
      ? { ...options.details, reason: "confirmation" }
      : options.details;
  }

  toJSON(): CliErrorDetails {
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

/** Why a command stopped for a person (`needs_person`, exit 6). */
export type PersonReason = "approval" | "confirmation" | "browser" | "dns" | "review" | "dashboard";

export interface NeedsPersonOptions {
  fix?: string;
  /** Where the person acts: an approval page, a browser step or a dashboard page. */
  url?: string;
  /** The command that continues after the person acted. */
  resume?: string;
  expiresAt?: string;
  details?: Record<string, unknown>;
}

/**
 * The command can't finish until a person acts. Exit 6 with
 * `{ code: "needs_person", details: { reason, url?, resume?, … } }`.
 */
export function needsPerson(reason: PersonReason, message: string, options: NeedsPersonOptions = {}): CliError {
  return new CliError("needs_person", message, {
    exitCode: EXIT.confirmation,
    fix: options.fix ?? (options.resume ? `Run '${options.resume}' again once that's done.` : undefined),
    details: {
      reason,
      ...(options.url ? { url: options.url } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      ...options.details,
    },
  });
}

/**
 * The work is still running after the wait (exit 8). `state` is where it
 * stands; `resume` is the command that keeps waiting.
 */
export function stillPending(code: string, message: string, options: {
  state: string; resume: string; fix?: string; details?: Record<string, unknown>;
}): CliError {
  return new CliError(code, message, {
    exitCode: EXIT.pending,
    fix: options.fix ?? `Run '${options.resume}' to keep waiting.`,
    details: { ...options.details, state: options.state, resume: options.resume },
  });
}
