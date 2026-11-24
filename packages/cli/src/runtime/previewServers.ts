import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ApiClient } from "./api";
import { resolveWebsite } from "./analytics";
import { WAITS } from "./duration";
import { CliError, EXIT, stillPending } from "./errors";

/**
 * Preview servers (`atmyapp preview`, CliEverywherePlan §5.3) and preview
 * builds of a website (`atmyapp hosting previews`). Start, stop, logs and Git
 * work on one instance of a server; restart works on the server.
 */

const timeout = () => AbortSignal.timeout(30_000);
const POLL_MS = 3000;

type Row = Record<string, unknown>;

/** API rows come in camelCase or snake_case depending on the route. */
function field<T = unknown>(row: Row, ...names: string[]): T | undefined {
  for (const name of names) if (row[name] !== undefined && row[name] !== null) return row[name] as T;
  return undefined;
}

function text(row: Row, ...names: string[]): string | null {
  const value = field(row, ...names);
  return typeof value === "string" ? value : null;
}

/**
 * The server's state in the words `stage preview` uses: ready, starting,
 * stopping, stopped or error.
 */
export function previewState(status: string | null | undefined): "ready" | "starting" | "stopping" | "stopped" | "error" | "unknown" {
  switch (status) {
    case "running": return "ready";
    case "starting": return "starting";
    case "stopping": return "stopping";
    case "stopped":
    case "archived": return "stopped";
    case "error": return "error";
    default: return "unknown";
  }
}

const serverSchema = z.object({ id: z.string(), name: z.string() }).loose();
export const instanceSummarySchema = z.object({
  id: z.string(),
  role: z.string().nullable(),
  state: z.string(),
  status: z.string().nullable(),
  branch: z.string().nullable(),
  lastError: z.string().nullable(),
  lastStartedAt: z.string().nullable(),
});
export type InstanceSummary = z.infer<typeof instanceSummarySchema>;

export const previewStatusSchema = z.object({
  servers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    branch: z.string().nullable(),
    state: z.string(),
    instances: z.array(instanceSummarySchema),
  })),
});

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

function summarize(row: Row, serverBranch: string | null): InstanceSummary {
  const status = text(row, "status");
  return {
    id: String(row.id),
    role: text(row, "instanceRole", "instance_role"),
    state: previewState(status),
    status,
    branch: text(row, "branch", "currentBranch", "current_branch") ?? serverBranch,
    lastError: text(row, "lastError", "last_error", "statusDetail", "status_detail"),
    lastStartedAt: text(row, "lastStartedAt", "last_started_at"),
  };
}

function serverRoute(id: string, rest = "") {
  return `dev-servers/${encodeURIComponent(id)}${rest ? `/${rest}` : ""}`;
}

async function servers(api: ApiClient): Promise<Row[]> {
  const raw = await api.json("GET", "dev-servers", { signal: timeout() });
  return read(z.object({ devServers: z.array(serverSchema) }), raw, "preview server list").devServers;
}

/** `--server <name|id>`; the only server when omitted. */
export async function resolveServer(api: ApiClient, ref: string | undefined): Promise<Row & { id: string; name: string }> {
  const all = (await servers(api)) as Array<Row & { id: string; name: string }>;
  const choices = all.map(({ id, name }) => ({ id, name }));
  if (ref) {
    const wanted = ref.trim().toLowerCase();
    const matches = all.filter((server) => server.id === ref.trim() || server.name.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    throw new CliError(matches.length ? "server_ambiguous" : "server_not_found",
      matches.length ? `Several preview servers are called '${ref}'.` : `No preview server '${ref}' in this project.`, {
        exitCode: EXIT.usage, details: { servers: choices }, fix: "Pass --server with an ID from details.",
      });
  }
  if (all.length === 1) return all[0];
  if (!all.length) throw new CliError("server_required", "This project has no preview server.", { fix: "Set one up in the dashboard: Settings → Preview server." });
  throw new CliError("server_required", "This project has several preview servers. Choose one with --server.", {
    exitCode: EXIT.usage, details: { servers: choices },
  });
}

async function instances(api: ApiClient, server: Row & { id: string }): Promise<InstanceSummary[]> {
  const raw = await api.json("GET", serverRoute(server.id, "instances"), { signal: timeout() });
  const rows = read(z.object({ instances: z.array(z.looseObject({ id: z.string() })) }), raw, "instance list").instances;
  const branch = text(server, "branch");
  return rows.map((row) => summarize(row, branch));
}

/**
 * `--instance <id>`; otherwise the server's only instance, or its only
 * `serve` instance (assistant conversations add their own). Several without
 * a clear choice: `instance_required` (exit 2) listing them.
 */
export async function resolveInstance(api: ApiClient, server: Row & { id: string; name: string }, ref: string | undefined): Promise<InstanceSummary> {
  const all = await instances(api, server);
  if (ref) {
    const found = all.find((instance) => instance.id === ref.trim());
    if (found) return found;
    throw new CliError("instance_not_found", `No instance '${ref}' on ${server.name}.`, { exitCode: EXIT.usage, details: { instances: all } });
  }
  if (all.length === 1) return all[0];
  const serve = all.filter((instance) => instance.role === "serve");
  if (serve.length === 1) return serve[0];
  if (!all.length) {
    throw new CliError("instance_required", `${server.name} has no running instance yet.`, {
      fix: "Open the draft preview once ('atmyapp stage preview') or start it from the dashboard.",
    });
  }
  throw new CliError("instance_required", `${server.name} has several instances. Choose one with --instance.`, {
    exitCode: EXIT.usage, details: { instances: all },
  });
}

export async function previewStatus(api: ApiClient, options: { server?: string } = {}): Promise<z.infer<typeof previewStatusSchema>> {
  const chosen = options.server ? [await resolveServer(api, options.server)] : (await servers(api)) as Array<Row & { id: string; name: string }>;
  return {
    servers: await Promise.all(chosen.map(async (server) => {
      const list = await instances(api, server);
      const aggregate = text(server, "aggregateStatus", "aggregate_status");
      return {
        id: server.id,
        name: server.name,
        branch: text(server, "branch"),
        state: aggregate ? previewState(aggregate) : list.some((instance) => instance.state === "ready") ? "ready" : list[0]?.state ?? "stopped",
        instances: list,
      };
    })),
  };
}

export interface Target { server?: string; instance?: string }

async function target(api: ApiClient, options: Target) {
  const server = await resolveServer(api, options.server);
  return { server, instance: await resolveInstance(api, server, options.instance) };
}

export const previewActionSchema = z.object({
  server: z.object({ id: z.string(), name: z.string() }),
  instance: instanceSummarySchema.nullable(),
  action: z.string(),
});

async function waitForState(
  api: ApiClient,
  server: Row & { id: string; name: string },
  instanceId: string | null,
  wanted: "ready" | "stopped",
  options: { timeoutMs: number; resume: string; onProgress?: (state: string) => void; pause?: (ms: number) => Promise<unknown> },
): Promise<InstanceSummary | null> {
  const deadline = Date.now() + options.timeoutMs;
  let last = "";
  for (;;) {
    const list = await instances(api, server);
    const current = instanceId ? list.find((instance) => instance.id === instanceId) ?? null
      : list.find((instance) => instance.role === "serve") ?? list[0] ?? null;
    const state = current?.state ?? "stopped";
    if (state !== last) {
      last = state;
      options.onProgress?.(state);
    }
    if (state === wanted) return current;
    if (state === "error" && wanted === "ready") {
      throw new CliError("preview_failed", `${server.name} could not start${current?.lastError ? `: ${current.lastError}` : "."}`, {
        details: { instance: current },
        fix: "Read 'atmyapp preview logs' for the cause, then 'atmyapp preview restart --wait'.",
      });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw stillPending("preview_timeout", `${server.name} is still ${state}.`, { state, resume: options.resume, details: { instance: current } });
    }
    await (options.pause ?? delay)(Math.min(POLL_MS, remaining));
  }
}

export interface ControlOptions extends Target {
  wait?: boolean;
  timeoutMs?: number;
  onProgress?: (state: string) => void;
  pause?: (ms: number) => Promise<unknown>;
}

function resumeCommand(action: string, options: Target) {
  return ["atmyapp preview", action, options.server ? `--server ${options.server}` : "", options.instance ? `--instance ${options.instance}` : "", "--wait"]
    .filter(Boolean).join(" ");
}

export async function previewStart(api: ApiClient, options: ControlOptions) {
  const { server, instance } = await target(api, options);
  await api.json("POST", serverRoute(server.id, `instances/${encodeURIComponent(instance.id)}/start`), { body: {}, signal: AbortSignal.timeout(120_000) });
  const final = options.wait
    ? await waitForState(api, server, instance.id, "ready", { timeoutMs: options.timeoutMs ?? WAITS.preview.default, resume: resumeCommand("start", options), onProgress: options.onProgress, pause: options.pause })
    : (await instances(api, server)).find((entry) => entry.id === instance.id) ?? instance;
  return { server: { id: server.id, name: server.name }, instance: final, action: "start" };
}

export async function previewStop(api: ApiClient, options: ControlOptions) {
  const { server, instance } = await target(api, options);
  await api.json("POST", serverRoute(server.id, `instances/${encodeURIComponent(instance.id)}/stop`), { body: {}, signal: AbortSignal.timeout(120_000) });
  const final = options.wait
    ? await waitForState(api, server, instance.id, "stopped", { timeoutMs: options.timeoutMs ?? WAITS.preview.default, resume: resumeCommand("stop", options), onProgress: options.onProgress, pause: options.pause })
    : (await instances(api, server)).find((entry) => entry.id === instance.id) ?? instance;
  return { server: { id: server.id, name: server.name }, instance: final, action: "stop" };
}

/** Restarts the server (all its instances pick up the new runtime). */
export async function previewRestart(api: ApiClient, options: ControlOptions) {
  const server = await resolveServer(api, options.server);
  await api.json("POST", serverRoute(server.id, "restart"), { body: {}, signal: AbortSignal.timeout(120_000) });
  const instance = options.wait
    ? await waitForState(api, server, options.instance ?? null, "ready", { timeoutMs: options.timeoutMs ?? WAITS.preview.default, resume: "atmyapp preview status", onProgress: options.onProgress, pause: options.pause })
    : null;
  return { server: { id: server.id, name: server.name }, instance, action: "restart" };
}

export const previewUrlSchema = z.object({ server: z.object({ id: z.string(), name: z.string() }), instance: z.string(), url: z.string() });

/** A signed link to the running preview (it opens the draft site). */
export async function previewUrl(api: ApiClient, options: Target) {
  const { server, instance } = await target(api, options);
  const raw = await api.json<Row>("GET", serverRoute(server.id, `instances/${encodeURIComponent(instance.id)}/preview`), { signal: timeout() });
  const url = raw ? text(raw, "url", "preview_url", "previewUrl") : null;
  if (!url) throw new CliError("preview_unavailable", `${server.name} has no preview link right now.`, { fix: "Start it with 'atmyapp preview start --wait'." });
  return { server: { id: server.id, name: server.name }, instance: instance.id, url };
}

export const previewGitSchema = z.object({
  server: z.object({ id: z.string(), name: z.string() }), instance: z.string(), action: z.string(), branch: z.string().nullable(), result: z.unknown(),
});

export async function previewBranch(api: ApiClient, branch: string, options: Target) {
  const name = branch.trim();
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.startsWith("-") || name.includes("..")) {
    throw new CliError("invalid_branch", `Invalid branch name: '${branch}'.`, { exitCode: EXIT.usage });
  }
  const { server, instance } = await target(api, options);
  const result = await api.json("POST", serverRoute(server.id, `instances/${encodeURIComponent(instance.id)}/git/checkout`), {
    body: { branch: name }, signal: AbortSignal.timeout(120_000),
  });
  return { server: { id: server.id, name: server.name }, instance: instance.id, action: "checkout", branch: name, result };
}

export async function previewPull(api: ApiClient, options: Target) {
  const { server, instance } = await target(api, options);
  const result = await api.json("POST", serverRoute(server.id, `instances/${encodeURIComponent(instance.id)}/git/pull`), {
    body: {}, signal: AbortSignal.timeout(120_000),
  });
  return { server: { id: server.id, name: server.name }, instance: instance.id, action: "pull", branch: instance.branch, result };
}

export const previewLogRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), instance: z.string(), line: z.string() }),
  z.object({ type: z.literal("event"), instance: z.string(), at: z.string().nullable(), kind: z.string(), message: z.string() }),
  z.object({ type: z.literal("reset"), instance: z.string() }),
]);
export type PreviewLogRecord = z.infer<typeof previewLogRecordSchema>;

/**
 * The server's output and lifecycle events (start, crash, stop). With
 * `build`, the last build's log instead. `--follow` polls until interrupted.
 */
export async function previewLogs(api: ApiClient, options: Target & {
  follow?: boolean; build?: boolean; emit: (record: PreviewLogRecord) => void; signal?: AbortSignal; pause?: (ms: number) => Promise<unknown>;
}) {
  const server = await resolveServer(api, options.server);
  if (options.build) {
    const buildId = text(server, "activeBuildId", "active_build_id");
    if (!buildId) throw new CliError("build_not_found", `${server.name} has no build yet.`);
    const raw = await api.json<Row>("GET", serverRoute(server.id, `builds/${encodeURIComponent(buildId)}/logs`), { signal: timeout() });
    for (const line of String(raw?.logs ?? "").split(/\r?\n/)) if (line) options.emit({ type: "log", instance: buildId, line });
    return;
  }
  const instance = await resolveInstance(api, server, options.instance);
  let printed = "";
  let events = 0;
  for (;;) {
    const raw = (await api.json<Row>("GET", serverRoute(server.id, `instances/${encodeURIComponent(instance.id)}/logs`), { signal: timeout() })) ?? {};
    const lifecycle = Array.isArray(raw.lifecycle_events) ? raw.lifecycle_events as Row[] : [];
    for (const event of lifecycle.slice(events)) {
      options.emit({
        type: "event", instance: instance.id, at: text(event, "created_at", "createdAt", "at"),
        kind: text(event, "event_type", "eventType", "kind") ?? "event", message: text(event, "message", "detail") ?? "",
      });
    }
    events = lifecycle.length;
    const output = typeof raw.output === "string" ? raw.output : "";
    if (!output.startsWith(printed)) {
      printed = "";
      options.emit({ type: "reset", instance: instance.id });
    }
    for (const line of output.slice(printed.length).split(/\r?\n/)) if (line) options.emit({ type: "log", instance: instance.id, line });
    printed = output;
    if (!options.follow || options.signal?.aborted) return;
    await (options.pause ?? delay)(2000);
    if (options.signal?.aborted) return;
  }
}

// --- Preview builds of a website (hosting previews) -----------------------------

export async function listPreviewBuilds(api: ApiClient, options: { website?: string }) {
  const website = await resolveWebsite(api, options.website);
  const data = await api.json("GET", `deployments/${encodeURIComponent(website.id)}/previews`, { signal: timeout() });
  return { website: { id: website.id, name: website.name }, previews: data };
}

export const shareLinkSchema = z.object({
  website: z.object({ id: z.string(), name: z.string() }),
  link: z.object({ id: z.string(), url: z.string() }).loose(),
  expiresInDays: z.number(),
});

const SHARE_DAYS = { "1d": 1, "7d": 7, "30d": 30 } as const;

/**
 * A link anyone can open to a frozen release: the live one, or `--release`
 * (a ready build, including preview builds). Needs a person behind the
 * credential, so project keys can't.
 */
export async function sharePreview(api: ApiClient, options: { website?: string; label: string; expires?: string; release?: string }) {
  const label = options.label.trim();
  if (!label || label.length > 80) throw new CliError("invalid_option", "--label takes 1 to 80 characters.", { exitCode: EXIT.usage });
  const expires = (options.expires ?? "7d") as keyof typeof SHARE_DAYS;
  if (!(expires in SHARE_DAYS)) throw new CliError("invalid_option", "--expires takes 1d, 7d or 30d.", { exitCode: EXIT.usage });
  const website = await resolveWebsite(api, options.website);
  const link = await api.json("POST", "preview-links", {
    body: { deploymentId: website.id, releaseId: options.release ?? null, label, expiresInDays: SHARE_DAYS[expires] },
    signal: timeout(),
  });
  return { website: { id: website.id, name: website.name }, link: read(shareLinkSchema.shape.link, link, "share link"), expiresInDays: SHARE_DAYS[expires] };
}

export async function listShareLinks(api: ApiClient, options: { website?: string }) {
  const website = await resolveWebsite(api, options.website);
  const data = read(z.object({ canShare: z.boolean(), links: z.array(z.looseObject({ id: z.string() })) }),
    await api.json("GET", "preview-links", { query: { deploymentId: website.id }, signal: timeout() }), "share links");
  return { website: { id: website.id, name: website.name }, ...data };
}

export async function revokeShareLink(api: ApiClient, linkId: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(linkId)) throw new CliError("invalid_argument", "Invalid link ID.", { exitCode: EXIT.usage });
  await api.json("DELETE", `preview-links/${encodeURIComponent(linkId)}`, { signal: timeout() });
  return { id: linkId, revoked: true };
}

/** The member-only link to a preview build, for the person behind the login. */
export async function openPreviewBuild(api: ApiClient, options: { website?: string; build?: string }) {
  const website = await resolveWebsite(api, options.website);
  const body = options.build ? { kind: "build", releaseId: options.build } : { kind: "branch" };
  const raw = await api.json("POST", `deployments/${encodeURIComponent(website.id)}/previews/open`, { body, signal: timeout() });
  return { website: { id: website.id, name: website.name }, ...read(z.object({ url: z.string() }), raw, "preview link") };
}
