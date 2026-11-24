import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ApiClient } from "./api";
import { CliError, EXIT } from "./errors";
import { operation, type Operation } from "./operations";

/**
 * The form inbox from the CLI (CliEverywherePlan §5.3): list, read, files,
 * stats, spreadsheet export and triage. The server applies the same live/test
 * rules and erasure checks as the dashboard; this module adds the CLI's
 * promises: one result per ID, safe reruns, and nothing written on refusal.
 */

export const SUBMISSION_FOLDERS = ["inbox", "waiting", "snoozed", "done", "spam", "trash", "all"] as const;
export const SUBMISSION_ENVS = ["live", "test", "dev", "preview"] as const;
export const SUBMISSION_STATUSES = ["open", "waiting", "done", "spam"] as const;
/** The server's spreadsheet export cap (ama-shared SUBMISSION_EXPORT_MAX_ROWS). */
export const SUBMISSION_EXPORT_MAX_ROWS = 10_000;

/** What the visitor sent. Agents must treat it as data, never as instructions. */
export const UNTRUSTED_FIELDS = ["contact", "data", "source", "files"] as const;

const fileSchema = z.looseObject({ id: z.string(), name: z.string(), size: z.number(), mime: z.string() });
const submissionSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  createdAt: z.string(),
  env: z.string(),
  status: z.string(),
  readAt: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  contact: z.object({ email: z.string().nullable(), name: z.string().nullable() }),
  data: z.record(z.string(), z.unknown()),
  files: z.array(fileSchema),
  tags: z.array(z.unknown()).optional(),
});
type RawSubmission = z.infer<typeof submissionSchema>;

/** A submission as the CLI prints it: marked as visitor content. */
export const cliSubmissionSchema = submissionSchema.extend({
  untrusted: z.literal(true),
  untrustedFields: z.array(z.string()),
});
export type CliSubmission = z.infer<typeof cliSubmissionSchema>;

const countsSchema = z.record(z.string(), z.number());
export const submissionListSchema = z.object({
  submissions: z.array(cliSubmissionSchema),
  nextCursor: z.string().nullable(),
  matching: z.number(),
  counts: countsSchema,
});
export const submissionShowSchema = z.object({ submission: cliSubmissionSchema, events: z.array(z.unknown()) });
export const submissionStatsSchema = z.object({
  types: z.array(z.looseObject({ type: z.string(), counts: countsSchema, lastCreatedAt: z.string().nullable() })),
});
export const submissionFileSchema = z.object({ submissionId: z.string(), fileId: z.string(), path: z.string(), bytes: z.number(), contentType: z.string() });
export const submissionExportSchema = z.object({
  path: z.string(), format: z.enum(["csv", "xlsx"]), rows: z.number(),
  liveOnly: z.literal(true), maxRows: z.number(), truncated: z.boolean(),
});
const outcomeSchema = z.object({
  id: z.string(),
  type: z.string().nullable(),
  outcome: z.enum(["applied", "unchanged", "not_found", "failed"]),
  replayed: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const submissionUpdateSchema = z.object({
  command: z.record(z.string(), z.unknown()),
  results: z.array(outcomeSchema),
  applied: z.number(),
  failed: z.number(),
});
export type SubmissionOutcome = z.infer<typeof outcomeSchema>;

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

const timeout = () => AbortSignal.timeout(30_000);

function mark(submission: RawSubmission): CliSubmission {
  return { ...submission, untrusted: true, untrustedFields: [...UNTRUSTED_FIELDS] };
}

function segment(value: string, what: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100 || /[/?#]/.test(trimmed)) {
    throw new CliError("invalid_argument", `Invalid ${what}: '${value}'.`, { exitCode: EXIT.usage });
  }
  return encodeURIComponent(trimmed);
}

function oneOf<T extends string>(value: string | undefined, options: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(options as readonly string[]).includes(value)) {
    throw new CliError("invalid_option", `${flag} takes ${options.join(", ")}.`, { exitCode: EXIT.usage });
  }
  return value as T;
}

function isoDate(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim()) || Number.isNaN(Date.parse(value))) {
    throw new CliError("invalid_option", `${flag} takes a date such as 2026-11-01 or 2026-11-01T09:00:00Z.`, { exitCode: EXIT.usage });
  }
  return value.trim();
}

export interface SubmissionFilters {
  form?: string;
  folder?: string;
  env?: string;
  unread?: boolean;
  hasFiles?: boolean;
  tag?: string;
  /** `me`, `none` or a member ID. */
  assignee?: string;
  email?: string;
  from?: string;
  to?: string;
  search?: string;
}

/** The person a personal credential acts for; project keys have none. */
async function currentUserId(api: ApiClient): Promise<string> {
  const session = await api.verifyKey<{ userId?: string }>().catch(() => null);
  if (!session?.userId) {
    throw new CliError("no_person", "A project key isn't a person, so it can't be 'me'.", {
      exitCode: EXIT.usage,
      fix: "Pass a member ID, or sign in with 'atmyapp login'.",
    });
  }
  return session.userId;
}

async function assigneeId(api: ApiClient, value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  return value === "me" ? currentUserId(api) : value.trim();
}

/** The list filters `listQuerySchema` in the inbox handlers accepts. */
async function filterQuery(api: ApiClient, filters: SubmissionFilters, options: { withEnv: boolean }) {
  return {
    folder: oneOf(filters.folder, SUBMISSION_FOLDERS, "--folder"),
    ...(options.withEnv ? { env: oneOf(filters.env, SUBMISSION_ENVS, "--env") } : {}),
    tag: filters.tag?.trim() || undefined,
    assigneeId: await assigneeId(api, filters.assignee),
    contactEmail: filters.email?.trim() || undefined,
    unread: filters.unread ? "1" : undefined,
    hasFiles: filters.hasFiles ? "1" : undefined,
    from: isoDate(filters.from, "--from"),
    to: isoDate(filters.to, "--to"),
    q: filters.search?.trim() || undefined,
  };
}

export async function listSubmissions(
  api: ApiClient,
  filters: SubmissionFilters & { limit?: number; cursor?: string },
): Promise<z.infer<typeof submissionListSchema>> {
  const limit = filters.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CliError("invalid_option", "--limit takes 1 to 100.", { exitCode: EXIT.usage });
  }
  const route = filters.form ? `submissions/${segment(filters.form, "form")}` : "submissions/all";
  const raw = await api.json("GET", route, {
    query: { ...(await filterQuery(api, filters, { withEnv: true })), limit, cursor: filters.cursor },
    signal: timeout(),
  });
  const page = read(z.object({
    submissions: z.array(submissionSchema), nextCursor: z.string().nullable(), matching: z.number(), counts: countsSchema,
  }), raw, "submission list");
  return { ...page, submissions: page.submissions.map(mark) };
}

export async function submissionTypes(api: ApiClient): Promise<string[]> {
  const raw = await api.json("GET", "submissions/types", { signal: timeout() });
  return read(z.array(z.looseObject({ type: z.string() })), raw, "form list").map((entry) => entry.type);
}

type Details = { submission: RawSubmission; events: unknown[] };

async function details(api: ApiClient, type: string, id: string): Promise<Details | null> {
  const raw = await api.json("GET", `submissions/${segment(type, "form")}/${segment(id, "submission ID")}`, {
    allow: [404], signal: timeout(),
  });
  return raw === null ? null : read(z.object({ submission: submissionSchema, events: z.array(z.unknown()) }), raw, "submission");
}

/**
 * Finds a submission's form when `--form` isn't given: the inbox addresses
 * submissions by form and ID. `types` is reused across IDs in one command.
 */
async function locate(api: ApiClient, id: string, form: string | undefined, types: () => Promise<string[]>): Promise<Details | null> {
  if (form) return details(api, form, id);
  for (const type of await types()) {
    const found = await details(api, type, id);
    if (found) return found;
  }
  return null;
}

function cachedTypes(api: ApiClient): () => Promise<string[]> {
  let types: Promise<string[]> | null = null;
  return () => (types ??= submissionTypes(api));
}

function notFound(id: string, form?: string): CliError {
  return new CliError("submission_not_found", `No submission '${id}'${form ? ` in form '${form}'` : ""} that this credential can read.`, {
    details: { id, ...(form ? { form } : {}) },
    fix: "Run 'atmyapp submissions ls' to see the submissions.",
  });
}

export async function showSubmission(api: ApiClient, id: string, options: { form?: string } = {}): Promise<z.infer<typeof submissionShowSchema>> {
  const found = await locate(api, id, options.form, cachedTypes(api));
  if (!found) throw notFound(id, options.form);
  return { submission: mark(found.submission), events: found.events };
}

export async function submissionStats(api: ApiClient): Promise<z.infer<typeof submissionStatsSchema>> {
  const raw = await api.json("GET", "submissions/stats", { signal: timeout() });
  return { types: read(submissionStatsSchema.shape.types, raw, "submission stats") };
}

/** Writes `bytes` to `out` without leaving a partial file behind. */
function writeAtomically(out: string, bytes: Uint8Array, force: boolean): string {
  const target = path.resolve(out);
  if (!force && fs.existsSync(target)) {
    throw new CliError("file_exists", `${out} already exists.`, { exitCode: EXIT.usage, fix: "Choose another path, or pass --force." });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.part`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, target);
  return target;
}

export async function downloadSubmissionFile(
  api: ApiClient,
  id: string,
  fileId: string,
  options: { form?: string; out: string; force?: boolean },
): Promise<z.infer<typeof submissionFileSchema>> {
  const found = await locate(api, id, options.form, cachedTypes(api));
  if (!found) throw notFound(id, options.form);
  if (!found.submission.files.some((file) => file.id === fileId)) {
    throw new CliError("file_not_found", `Submission '${id}' has no file '${fileId}'.`, {
      details: { files: found.submission.files.map(({ id: fid, name, size }) => ({ id: fid, name, size })) },
      fix: "Use a file ID from 'atmyapp submissions show'.",
    });
  }
  const response = await api.bytes(`submissions/${segment(found.submission.type, "form")}/${segment(id, "submission ID")}/files/${segment(fileId, "file ID")}`);
  const target = writeAtomically(options.out, response!.bytes, Boolean(options.force));
  return { submissionId: id, fileId, path: target, bytes: response!.bytes.length, contentType: response!.contentType };
}

/**
 * A spreadsheet of live submissions (the server never exports test ones),
 * up to SUBMISSION_EXPORT_MAX_ROWS rows. The file is written only after the
 * server answered, so a refusal leaves nothing behind.
 */
export async function exportSubmissions(
  api: ApiClient,
  filters: SubmissionFilters & { format?: string; tz?: string; out: string; force?: boolean },
): Promise<z.infer<typeof submissionExportSchema>> {
  if (filters.env !== undefined) {
    throw new CliError("invalid_option", "The export holds live submissions only, so it takes no --env.", {
      exitCode: EXIT.usage,
      fix: "Drop --env. Use 'atmyapp submissions ls --env test --json' for test submissions.",
    });
  }
  const format = oneOf(filters.format ?? "csv", ["csv", "xlsx"] as const, "--format")!;
  const target = path.resolve(filters.out);
  if (!filters.force && fs.existsSync(target)) {
    throw new CliError("file_exists", `${filters.out} already exists.`, { exitCode: EXIT.usage, fix: "Choose another path, or pass --force." });
  }
  const query = {
    ...(await filterQuery(api, filters, { withEnv: false })),
    format,
    type: filters.form?.trim() || undefined,
    tz: filters.tz?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const url = api.url("submissions/export", query);
  const response = await api.send("GET", url, undefined, false, AbortSignal.timeout(120_000));
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    if (body?.code === "live_messages_refused") {
      throw new CliError("live_messages_refused", body.error ?? "Real form messages aren't available to this credential.", {
        exitCode: EXIT.auth, status: response.status,
        fix: "The export holds live submissions only. Ask a project admin, or list test submissions with 'submissions ls --env test'.",
      });
    }
    if (body?.code === "export_too_large" || response.status === 413) {
      throw new CliError("export_too_large", body?.error ?? "Too many submissions for one spreadsheet.", {
        exitCode: EXIT.usage, status: response.status, details: { maxRows: SUBMISSION_EXPORT_MAX_ROWS },
        fix: "Narrow the filters (--form, --from, --to, --folder) and export again.",
      });
    }
    const error = new CliError(body?.code || (response.status === 403 ? "forbidden" : "request_failed"), body?.error || `Export failed with status ${response.status}.`, {
      exitCode: response.status === 401 || response.status === 403 ? EXIT.auth : EXIT.error, status: response.status,
    });
    throw error;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const rows = Number(response.headers.get("X-Export-Rows") ?? NaN);
  writeAtomically(filters.out, bytes, Boolean(filters.force));
  return {
    path: target, format, rows: Number.isFinite(rows) ? rows : 0, liveOnly: true,
    maxRows: SUBMISSION_EXPORT_MAX_ROWS, truncated: Number.isFinite(rows) && rows >= SUBMISSION_EXPORT_MAX_ROWS,
  };
}

// --- Triage --------------------------------------------------------------------

export type SubmissionCommand =
  | { kind: "markRead" } | { kind: "markUnread" }
  | { kind: "setStatus"; status: string }
  | { kind: "addTags"; tags: string[] } | { kind: "removeTags"; tags: string[] }
  | { kind: "snooze"; until: string } | { kind: "unsnooze" }
  | { kind: "assign"; assigneeId: string | null }
  | { kind: "addNote"; text: string }
  | { kind: "trash" } | { kind: "restore" } | { kind: "erase" };

export interface UpdateFlags {
  read?: boolean;
  unread?: boolean;
  status?: string;
  tag?: string;
  untag?: string;
  assign?: string;
  note?: string;
  snooze?: string;
  unsnooze?: boolean;
  trash?: boolean;
  restore?: boolean;
  erase?: boolean;
}

function tags(value: string): string[] {
  const list = value.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (!list.length || list.length > 20 || list.some((tag) => tag.length > 40)) {
    throw new CliError("invalid_option", "Give 1 to 20 tags, each up to 40 characters, separated by commas.", { exitCode: EXIT.usage });
  }
  return list;
}

/** `30m`, `2h`, `3d`, `1w`, or an ISO time in the future. */
export function snoozeUntil(value: string, now = Date.now()): string {
  const relative = /^(\d+)(m|h|d|w)$/i.exec(value.trim());
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2].toLowerCase() as "m"];
    return new Date(now + Number(relative[1]) * unit).toISOString();
  }
  const at = Date.parse(value);
  if (Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    throw new CliError("invalid_option", "--snooze takes 2h, 3d, 1w or a time such as 2026-12-01T09:00:00Z.", { exitCode: EXIT.usage });
  }
  if (at <= now) throw new CliError("invalid_option", "Snooze until a time in the future.", { exitCode: EXIT.usage });
  return new Date(at).toISOString();
}

/** Exactly one change per call, so each ID gets one clear result. */
export async function commandFromFlags(api: ApiClient, flags: UpdateFlags): Promise<SubmissionCommand> {
  const chosen: SubmissionCommand[] = [];
  if (flags.read) chosen.push({ kind: "markRead" });
  if (flags.unread) chosen.push({ kind: "markUnread" });
  if (flags.status !== undefined) chosen.push({ kind: "setStatus", status: oneOf(flags.status, SUBMISSION_STATUSES, "--status")! });
  if (flags.tag !== undefined) chosen.push({ kind: "addTags", tags: tags(flags.tag) });
  if (flags.untag !== undefined) chosen.push({ kind: "removeTags", tags: tags(flags.untag) });
  if (flags.assign !== undefined) {
    chosen.push({ kind: "assign", assigneeId: flags.assign === "none" ? null : (await assigneeId(api, flags.assign))! });
  }
  if (flags.note !== undefined) {
    const text = flags.note.trim();
    if (!text || text.length > 5000) throw new CliError("invalid_option", "A note takes 1 to 5000 characters.", { exitCode: EXIT.usage });
    chosen.push({ kind: "addNote", text });
  }
  if (flags.snooze !== undefined) chosen.push({ kind: "snooze", until: snoozeUntil(flags.snooze) });
  if (flags.unsnooze) chosen.push({ kind: "unsnooze" });
  if (flags.trash) chosen.push({ kind: "trash" });
  if (flags.restore) chosen.push({ kind: "restore" });
  if (flags.erase) chosen.push({ kind: "erase" });
  if (chosen.length !== 1) {
    throw new CliError("invalid_options", chosen.length ? "Choose one change per command." : "Say what to change, such as --read, --status done or --trash.", {
      exitCode: EXIT.usage,
    });
  }
  return chosen[0];
}

/**
 * A script's own command ID (`--command-id`): the same value always maps to
 * the same inbox command, so the script decides what counts as a repeat.
 */
export function submissionCommandId(type: string, id: string, command: SubmissionCommand, scriptId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([type, id, command, scriptId])).digest("hex");
  return `cli-${digest.slice(0, 40)}`;
}

/**
 * Without `--command-id`, each deliberate action gets a fresh ID that a rerun
 * after an interruption reuses (runtime/operations.ts). So read → unread →
 * read applies three times, and an interrupted read retried applies once
 * (§11.1 P1-6). The snooze target is left out of the key: "2h" means a new
 * time on each run, but a retry is still the same action.
 */
function commandOperation(api: ApiClient, type: string, ids: readonly string[], command: SubmissionCommand): Operation {
  const key = command.kind === "snooze" ? { kind: "snooze" } : command;
  return operation(api.session, "submissions.command", [type, [...ids].sort(), key]);
}

/** Finished: applied, or refused for a reason a rerun won't change. Keep the ID otherwise. */
function finished(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  if (error.code === "approval_denied") return true;
  return Boolean(error.status && error.status >= 400 && error.status < 500 && error.exitCode !== EXIT.confirmation);
}

/** Stops the whole command: the person must act (exit 6/8) or nothing will work (exit 2/3). */
function stopsCommand(error: unknown): error is CliError {
  return error instanceof CliError &&
    ([EXIT.auth, EXIT.usage, EXIT.confirmation, EXIT.pending] as number[]).includes(error.exitCode);
}

/**
 * Runs `work` over `items` with at most `limit` running at once, keeping
 * order. A stopping error lets the running items finish, starts no new ones,
 * and is rethrown with what completed (`details.completed`).
 */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  let stop: CliError | null = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!stop && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index]);
      } catch (error) {
        if (!stopsCommand(error)) throw error;
        stop ??= error;
      }
    }
  }));
  if (stop) {
    const error: CliError = stop;
    throw new CliError(error.code, error.message, {
      exitCode: error.exitCode, fix: error.fix, status: error.status,
      details: { ...error.details, completed: results.filter((result) => result !== undefined) },
    });
  }
  return results as R[];
}

async function send(api: ApiClient, type: string, ids: string[], command: SubmissionCommand, commandId: string) {
  return read(z.object({ applied: z.number(), skipped: z.number(), duplicate: z.boolean().optional() }), await api.json(
    "POST", `submissions/${segment(type, "form")}/commands`,
    { body: { commandId, ids, command }, signal: timeout() },
  ), "command");
}

/**
 * One command per ID, up to four at a time (§5.3): the inbox's bulk reply
 * only counts, and the CLI promises a result per ID. Erasing is the
 * exception: one command (one approval) per form, then each ID is checked.
 * A refusal that applies to every ID, or an approval to wait for, stops the
 * command with exit 2, 3, 6 or 8 and keeps what completed.
 */
export async function updateSubmissions(
  api: ApiClient,
  ids: readonly string[],
  command: SubmissionCommand,
  options: { form?: string; commandId?: string } = {},
): Promise<z.infer<typeof submissionUpdateSchema>> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!unique.length) throw new CliError("invalid_argument", "Give at least one submission ID.", { exitCode: EXIT.usage });
  if (unique.length > 500) throw new CliError("invalid_argument", "Update at most 500 submissions per command.", { exitCode: EXIT.usage });
  const types = cachedTypes(api);
  const located = await pool(unique, 4, async (id) => ({ id, found: await locate(api, id, options.form, types) }));
  const missing: SubmissionOutcome[] = located.filter((entry) => !entry.found).map(({ id }) => ({ id, type: null, outcome: "not_found" }));
  const byType = new Map<string, string[]>();
  for (const { id, found } of located) {
    if (found) byType.set(found.submission.type, [...(byType.get(found.submission.type) ?? []), id]);
  }

  const run = async <R>(type: string, batch: string[], work: (commandId: string) => Promise<R>): Promise<R> => {
    const op = options.commandId ? null : commandOperation(api, type, batch, command);
    const commandId = options.commandId ? submissionCommandId(type, batch.join(","), command, options.commandId) : `cli-${op!.id}`;
    try {
      const result = await work(commandId);
      op?.done();
      return result;
    } catch (error) {
      if (finished(error)) op?.done();
      throw error;
    }
  };

  let results: SubmissionOutcome[];
  if (command.kind === "erase") {
    const groups = [...byType.entries()];
    const erased = await pool(groups, 1, async ([type, batch]) => {
      try {
        await run(type, batch, (commandId) => send(api, type, batch, command, commandId));
      } catch (error) {
        if (stopsCommand(error)) throw error;
        const failure = error instanceof CliError ? error : new CliError("unexpected", String(error));
        return batch.map((id): SubmissionOutcome => ({ id, type, outcome: "failed", error: { code: failure.code, message: failure.message } }));
      }
      // The bulk reply only counts: check each one is gone.
      return pool(batch, 4, async (id): Promise<SubmissionOutcome> => ({
        id, type, outcome: (await details(api, type, id)) ? "unchanged" : "applied",
      }));
    });
    results = erased.flat();
  } else {
    const items = [...byType.entries()].flatMap(([type, batch]) => batch.map((id) => ({ type, id })));
    results = await pool(items, 4, async ({ type, id }): Promise<SubmissionOutcome> => {
      try {
        const result = await run(type, [id], (commandId) => send(api, type, [id], command, commandId));
        return {
          id, type,
          outcome: result.applied > 0 ? "applied" : "unchanged",
          ...(result.duplicate ? { replayed: true } : {}),
        };
      } catch (error) {
        if (stopsCommand(error)) throw error;
        const failure = error instanceof CliError ? error : new CliError("unexpected", String(error));
        return { id, type, outcome: "failed", error: { code: failure.code, message: failure.message } };
      }
    });
  }
  const order = new Map(unique.map((id, index) => [id, index]));
  const all = [...results, ...missing].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    command,
    results: all,
    applied: all.filter((result) => result.outcome === "applied").length,
    failed: all.filter((result) => result.outcome === "failed" || result.outcome === "not_found").length,
  };
}
