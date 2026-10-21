import { Command } from "commander";
import chalk from "chalk";
import { Logger } from "../logger";
import { buildProjectApiUrl, resolveSession, type AmaSession } from "../utils/http";

/** One entry of the submissions changes feed (see the submissions API). */
export interface SubmissionChange {
  type: string;
  event: {
    seq: number;
    at: string;
    actor: string;
    kind: string;
    submissionId: string | null;
    payload: Record<string, unknown> | null;
  };
  submission?: {
    id: string;
    env: "live" | "test" | "dev" | "preview";
    status: string;
    contact: { email: string | null; name: string | null };
    data: Record<string, unknown>;
    files: Array<{ name: string }>;
    signals?: { strippedFields?: string[]; duplicateOf?: string | null } | null;
  };
}

interface ChangesPage {
  changes: SubmissionChange[];
  cursor: string;
}

/** Read receipts would drown out everything else. */
const QUIET_KINDS = new Set(["read", "unread"]);
const MESSAGE_KEYS = ["message", "comment", "comments", "body", "question", "details", "subject", "note"];

const time = (iso: string) => {
  const date = new Date(iso);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
};

const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "");

function preview(data: Record<string, unknown>): string {
  const strings = Object.entries(data).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""
  );
  const message = strings.find(([key]) => MESSAGE_KEYS.some((candidate) => key.toLowerCase().includes(candidate)));
  const text = (message ?? strings[0])?.[1].replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `"${text.length > 48 ? `${text.slice(0, 47)}…` : text}"`;
}

function describe(change: SubmissionChange): { mark: string; summary: string; tone: "ok" | "bad" | "info" } | null {
  const { event } = change;
  const payload = event.payload ?? {};
  switch (event.kind) {
    case "created": {
      const submission = change.submission;
      if (!submission) return { mark: "✔", summary: `received ${shortId(event.submissionId)}`, tone: "ok" };
      const redacted = submission.env === "live" && !submission.contact.email && !Object.keys(submission.data).length;
      const parts = [
        `received ${shortId(submission.id)}`,
        submission.env,
        ...(redacted
          ? []
          : [submission.contact.email ?? submission.contact.name ?? "", preview(submission.data)]),
        submission.files.length ? `${submission.files.length} ${submission.files.length === 1 ? "file" : "files"}` : "",
        submission.signals?.strippedFields?.length ? `dropped: ${submission.signals.strippedFields.join(", ")}` : "",
        submission.signals?.duplicateOf ? `repeat of ${shortId(submission.signals.duplicateOf)}` : "",
      ];
      return { mark: "✔", summary: parts.filter(Boolean).join("  "), tone: "ok" };
    }
    case "rejected":
      return {
        mark: "✖",
        summary: ["rejected", String(payload.reason ?? "unknown"), payload.env && payload.env !== "live" ? String(payload.env) : "", payload.origin ? `origin=${payload.origin}` : ""]
          .filter(Boolean)
          .join("  "),
        tone: "bad",
      };
    case "status":
      return { mark: "•", summary: `${shortId(event.submissionId)} marked ${payload.to ?? "changed"}`, tone: "info" };
    case "tags_added":
    case "tags_removed":
      return {
        mark: "•",
        summary: `${shortId(event.submissionId)} ${event.kind === "tags_added" ? "tagged" : "untagged"} ${(payload.tags as string[] | undefined)?.join(", ") ?? ""}`,
        tone: "info",
      };
    case "snoozed":
      return { mark: "•", summary: `${shortId(event.submissionId)} snoozed until ${payload.until ?? "later"}`, tone: "info" };
    case "snooze_wake":
      return { mark: "•", summary: `${shortId(event.submissionId)} back from snooze`, tone: "info" };
    case "assigned":
      return { mark: "•", summary: `${shortId(event.submissionId)} ${payload.assigneeId ? "assigned" : "unassigned"}`, tone: "info" };
    case "note":
      return { mark: "•", summary: `${shortId(event.submissionId)} note added`, tone: "info" };
    case "trashed":
    case "restored":
    case "erased":
      return { mark: "•", summary: `${shortId(event.submissionId)} ${event.kind}`, tone: "info" };
    default:
      return QUIET_KINDS.has(event.kind) ? null : { mark: "•", summary: `${shortId(event.submissionId)} ${event.kind}`, tone: "info" };
  }
}

/** One human line per change, or null for changes not worth a line. */
export function formatSubmissionChange(change: SubmissionChange, options: { color?: boolean } = {}): string | null {
  const described = describe(change);
  if (!described) return null;
  const color = options.color ?? false;
  const paint = (text: string, style: (value: string) => string) => (color ? style(text) : text);
  const mark =
    described.tone === "ok"
      ? paint(described.mark, chalk.green)
      : described.tone === "bad"
        ? paint(described.mark, chalk.red)
        : paint(described.mark, chalk.gray);
  return `${paint(time(change.event.at), chalk.gray)}  ${paint(change.type, chalk.cyan)}  ${mark} ${described.summary}`;
}

export interface TailOptions {
  session: AmaSession;
  type?: string;
  includeLiveData?: boolean;
  /** Events shown before following (most recent first page). */
  backlog: number;
  intervalMs: number;
  /** Print the backlog and stop. */
  once?: boolean;
  fetchImpl?: typeof fetch;
  onChange: (change: SubmissionChange) => void;
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export class TailAccessError extends Error {}

/**
 * Follows the submissions changes feed: the latest `backlog` events, then
 * every new one, polling with the feed's cursor. Network trouble backs off
 * and retries; a refused key stops with a clear error.
 */
export async function tailSubmissions(options: TailOptions): Promise<void> {
  const fetchApi = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  let cursor: string | null = null;
  let failures = 0;

  const request = async (limit: number): Promise<ChangesPage> => {
    const url = new URL(buildProjectApiUrl(options.session.url, options.session.projectId, "submissions/changes"));
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    if (options.type) url.searchParams.set("types", options.type);
    if (options.includeLiveData) url.searchParams.set("includeLiveData", "1");
    const response = await fetchApi(url.toString(), {
      headers: { Authorization: `Bearer ${options.session.token}`, Accept: "application/json" },
      signal: options.signal,
    });
    const body = (await response.json().catch(() => null)) as
      | { success?: boolean; data?: ChangesPage; error?: string }
      | null;
    if (response.status === 401 || response.status === 403)
      throw new TailAccessError(
        body?.error || "This CLI key can't read submissions for the project. Run 'atmyapp use' with a current key."
      );
    if (!response.ok || !body?.success || !body.data)
      throw new Error(body?.error || `The submissions feed answered with status ${response.status}.`);
    return body.data;
  };

  const first = await request(Math.max(1, options.backlog));
  cursor = first.cursor;
  const backlog = options.backlog > 0 ? first.changes.slice(-options.backlog) : [];
  backlog.forEach(options.onChange);
  if (options.once) return;

  while (!options.signal?.aborted) {
    await sleep(failures ? Math.min(30_000, options.intervalMs * 2 ** failures) : options.intervalMs, options.signal);
    if (options.signal?.aborted) break;
    try {
      const page = await request(200);
      cursor = page.cursor;
      page.changes.forEach(options.onChange);
      failures = 0;
    } catch (error) {
      if (error instanceof TailAccessError) throw error;
      if (options.signal?.aborted) break;
      failures += 1;
      if (failures === 1)
        options.onWarning?.(
          `${error instanceof Error ? error.message : "The submissions feed is unreachable"} Retrying…`
        );
    }
  }
}

interface TailCommandOptions {
  token?: string;
  url?: string;
  projectId?: string;
  json?: boolean;
  includeLiveData?: boolean;
  interval?: string;
  backlog?: string;
  once?: boolean;
  verbose?: boolean;
}

function tailCommand(): Command {
  return new Command("tail")
    .description("Follow form submissions as they arrive, including rejected ones")
    .argument("[type]", "Only this submission type (default: all types)")
    .option("--json", "Print one JSON object per line (NDJSON) for scripts")
    .option(
      "--include-live-data",
      "Show what visitors sent on the live website (hidden by default; test and local submissions always show)"
    )
    .option("--interval <seconds>", "How often to check for new submissions", "2")
    .option("--backlog <count>", "Recent events to show before following", "10")
    .option("--once", "Show recent events and exit")
    .option("-t, --token <token>", "Authentication token override")
    .option("-u, --url <url>", "Project base URL override")
    .option("-p, --project-id <id>", "Project identifier override")
    .option("--verbose", "Enable verbose logging")
    .action(async (type: string | undefined, options: TailCommandOptions) => {
      // Status messages go to stderr so stdout stays clean for --json.
      const logger = new Logger(Boolean(options.verbose), { stderr: true });
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const session = resolveSession({ token: options.token, url: options.url, projectId: options.projectId });
        const intervalMs = Math.max(1, Number(options.interval) || 2) * 1000;
        const backlog = Math.max(0, Math.floor(Number(options.backlog ?? 10)));
        const color = !options.json && Boolean(process.stdout.isTTY);
        if (!options.json && !options.once)
          logger.info(
            `Following ${type ? `"${type}"` : "all"} submissions. Press Ctrl+C to stop.${
              options.includeLiveData ? "" : " Live visitor data is hidden; add --include-live-data to show it."
            }`
          );
        await tailSubmissions({
          session,
          type,
          includeLiveData: options.includeLiveData,
          backlog,
          intervalMs,
          once: options.once,
          signal: controller.signal,
          onWarning: (message) => logger.warn(message),
          onChange: (change) => {
            if (options.json) {
              process.stdout.write(`${JSON.stringify(change)}\n`);
              return;
            }
            const line = formatSubmissionChange(change, { color });
            if (line) process.stdout.write(`${line}\n`);
          },
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });
}

export function submissionsCommand(): Command {
  return new Command("submissions").description("Work with form submissions").addCommand(tailCommand());
}
