import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ApiClient } from "./api";
import { CliError, EXIT } from "./errors";

const statusSchema = z.enum(["pending", "running", "ready", "failed", "archived"]);
const deploymentSchema = z.object({
  id: z.string(), name: z.string(), build_preset_id: z.string(), active_release_id: z.string().nullish(),
  auto_rebuild_on_storage_change: z.boolean().optional(), auto_promote_on_release: z.boolean().optional(),
});
const releaseSchema = z.object({
  id: z.string(), deployment_id: z.string(), status: statusSchema, build_preset_id: z.string().optional(),
  branch: z.string().nullish(), commit_sha: z.string().nullish(), created_at: z.string().optional(),
  ready_at: z.string().nullish(), promoted_at: z.string().nullish(),
});
const presetSchema = z.object({
  id: z.string(), name: z.string(), framework: z.string().nullish(), branch: z.string().optional(),
});
const domainSchema = z.object({ id: z.string(), hostname: z.string(), status: z.string(), deploymentId: z.string().nullish() });
const publicationSchema = z.object({
  contentCommit: z.string().nullable(),
  websites: z.array(z.looseObject({ deploymentId: z.string(), state: z.string(), liveReleaseId: z.string().nullable() })),
});
const logsSchema = z.object({ releaseId: z.string(), status: statusSchema, logs: z.string(), error_detail: z.string().nullish() });
const promoteSchema = z.object({
  deployment: deploymentSchema,
  promotedRelease: z.object({ id: z.string(), status: statusSchema, branch: z.string().nullish(), commitSha: z.string().nullish() }),
  propagation: z.unknown(),
});
export const hostingStatusSchema = z.object({
  deployments: z.array(deploymentSchema.extend({ activeRelease: releaseSchema.nullable(), buildPreset: presetSchema.nullable() })),
  domains: z.array(domainSchema), publication: publicationSchema,
});
export const hostingDeploySchema = z.discriminatedUnion("dryRun", [
  z.object({ dryRun: z.literal(true), deployment: deploymentSchema }),
  z.object({ dryRun: z.literal(false), deployment: deploymentSchema, release: releaseSchema }),
]);
export const hostingReleasesSchema = z.object({ releases: z.array(releaseSchema) });
export const hostingPromoteSchema = z.discriminatedUnion("dryRun", [
  z.object({ dryRun: z.literal(true), release: releaseSchema }),
  promoteSchema.extend({ dryRun: z.literal(false) }),
]);
export const hostingLogRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), releaseId: z.string(), line: z.string() }),
  z.object({ type: z.literal("status"), releaseId: z.string(), status: statusSchema }),
  z.object({ type: z.literal("reset"), releaseId: z.string() }),
]);
export type HostingLogRecord = z.infer<typeof hostingLogRecordSchema>;
type Release = z.infer<typeof releaseSchema>;
type Deployment = z.infer<typeof deploymentSchema>;

function read<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", "The server returned an unexpected hosting response.");
  return parsed.data;
}

function segment(id: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new CliError("invalid_hosting_id", "Invalid deployment or release ID.", { exitCode: EXIT.usage });
  return id;
}

function deploymentRoute(id: string) { return "deployments/" + segment(id); }
function releaseRoute(deploymentId: string, releaseId: string) { return deploymentRoute(deploymentId) + "/releases/" + segment(releaseId); }
const isFinished = (status: Release["status"]) => status === "ready" || status === "failed" || status === "archived";
const POLL_MS = 3000;
const apiTimeout = () => AbortSignal.timeout(30_000);

async function deployments(api: ApiClient, id?: string): Promise<Deployment[]> {
  if (id) return [read(z.object({ deployment: deploymentSchema }),
    await api.json("GET", deploymentRoute(id), { signal: apiTimeout() })).deployment];
  return read(z.object({ deployments: z.array(deploymentSchema) }),
    await api.json("GET", "deployments", { signal: apiTimeout() })).deployments;
}

async function getRelease(api: ApiClient, deploymentId: string, releaseId: string, options: { allowMissing?: boolean; signal?: AbortSignal } = {}) {
  const raw = await api.json("GET", releaseRoute(deploymentId, releaseId), {
    allow: options.allowMissing ? [400, 404] : [], signal: options.signal ?? apiTimeout(),
  });
  if (raw === null && options.allowMissing) return null;
  const release = read(z.object({ release: releaseSchema }), raw).release;
  if (release.deployment_id !== deploymentId || release.id !== releaseId)
    throw new CliError("invalid_response", "The server returned a different release.");
  return release;
}

export async function hostingStatus(api: ApiClient, contentCommit?: string): Promise<z.infer<typeof hostingStatusSchema>> {
  if (contentCommit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(contentCommit)) {
    throw new CliError("invalid_commit", "Pass a full content commit SHA.", { exitCode: EXIT.usage });
  }
  const [rows, domains, publication] = await Promise.all([
    deployments(api),
    api.json("GET", "domains", { signal: apiTimeout() }),
    api.json("GET", "deployments/publication-status", { query: { contentCommit }, signal: apiTimeout() }),
  ]);
  const details = await Promise.all(rows.map(async (deployment) => {
    const [activeRelease, preset] = await Promise.all([
      deployment.active_release_id ? getRelease(api, deployment.id, deployment.active_release_id, { allowMissing: true }) : null,
      api.json("GET", "build-presets/" + segment(deployment.build_preset_id), { allow: [404], signal: apiTimeout() }),
    ]);
    return {
      ...deployment,
      activeRelease,
      buildPreset: preset === null ? null : read(z.object({ build_preset: presetSchema }), preset).build_preset,
    };
  }));
  return { deployments: details, domains: read(z.array(domainSchema), domains), publication: read(publicationSchema, publication) };
}

export async function hostingReleases(api: ApiClient, deploymentId?: string): Promise<z.infer<typeof hostingReleasesSchema>> {
  const rows = await deployments(api, deploymentId);
  const releases = await Promise.all(rows.map(async (row) =>
    read(hostingReleasesSchema, await api.json("GET", deploymentRoute(row.id) + "/releases", { signal: apiTimeout() })).releases,
  ));
  return { releases: releases.flat().sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.id.localeCompare(b.id)) };
}

async function findRelease(api: ApiClient, releaseId: string, deploymentId?: string) {
  segment(releaseId);
  const rows = await deployments(api, deploymentId);
  // Each release has one deployment. Check current deployments without depending on release list pagination.
  for (const row of rows) {
    const release = await getRelease(api, row.id, releaseId, { allowMissing: true });
    if (release) return release;
  }
  throw new CliError("release_not_found", "No release with that ID was found in this project.", { status: 404 });
}

async function releaseLogs(api: ApiClient, release: Release, signal = apiTimeout()) {
  const result = read(logsSchema, await api.json("GET", releaseRoute(release.deployment_id, release.id) + "/logs", { signal }));
  if (result.releaseId !== release.id) throw new CliError("invalid_response", "The server returned logs for a different release.");
  return result;
}

async function buildFailure(api: ApiClient, release: Release, timeout = 5000): Promise<never> {
  const snapshot = await releaseLogs(api, release, AbortSignal.timeout(Math.max(1, timeout))).catch(() => null);
  throw new CliError("build_failed", "Website build " + release.id + " failed.", {
    details: {
      releaseId: release.id, status: release.status, deploymentId: release.deployment_id,
      logs: snapshot?.logs.trimEnd().split(/\r?\n/).filter(Boolean).slice(-20) ?? [],
      ...(snapshot?.error_detail ? { buildError: snapshot.error_detail } : {}),
    },
    fix: "Check 'atmyapp hosting logs " + release.id + "'.",
  });
}

export function parseDeployTimeout(value: string): number {
  const match = /^(\d+)(s|m|h)?$/i.exec(value.trim());
  const factor = { s: 1000, m: 60_000, h: 3_600_000 };
  const ms = match ? Number(match[1]) * factor[(match[2]?.toLowerCase() ?? "s") as keyof typeof factor] : 0;
  if (ms < 1000 || ms > 3_600_000)
    throw new CliError("invalid_timeout", "Use a timeout between 1s and 1h, such as 15m.", { exitCode: EXIT.usage });
  return ms;
}

export async function hostingDeploy(api: ApiClient, options: {
  deploymentId?: string; wait?: boolean; timeoutMs?: number; dryRun?: boolean;
  pause?: (ms: number) => Promise<unknown>;
  onRelease?: (id: string) => void;
} = {}): Promise<z.infer<typeof hostingDeploySchema>> {
  const rows = await deployments(api, options.deploymentId);
  if (!rows.length) throw new CliError("deployment_required", "This project has no website deployment.");
  if (rows.length > 1) throw new CliError("deployment_required", "Choose a website deployment with --deployment.", {
    exitCode: EXIT.usage, details: { deployments: rows.map(({ id, name }) => ({ id, name })) },
  });
  const deployment = rows[0];
  if (options.dryRun) return { dryRun: true, deployment };
  let release: Release;
  try {
    release = read(z.object({ release: releaseSchema }), await api.json("POST", deploymentRoute(deployment.id) + "/releases", {
      body: {}, signal: apiTimeout(),
    })).release;
  } catch (error) {
    if (error instanceof CliError && error.code === "build_failed") {
      const failed = releaseSchema.safeParse(error.details?.release);
      if (failed.success && failed.data.deployment_id === deployment.id) return buildFailure(api, failed.data);
    }
    throw error;
  }
  if (release.deployment_id !== deployment.id) throw new CliError("invalid_response", "The server created a release for a different deployment.");
  options.onRelease?.(release.id);
  const timeoutMs = options.timeoutMs ?? 16 * 60_000;
  const deadline = Date.now() + timeoutMs;
  const timedOut = () => new CliError("deploy_timeout", "Timed out waiting for release " + release.id + ".", {
    details: { releaseId: release.id, deploymentId: deployment.id, status: release.status, timeoutMs },
    fix: "Check 'atmyapp hosting releases ls' or 'atmyapp hosting logs " + release.id + " --follow'.",
  });
  while (options.wait && !isFinished(release.status)) {
    let remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    await (options.pause ?? delay)(Math.min(POLL_MS, remaining));
    remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    try {
      release = (await getRelease(api, deployment.id, release.id, { signal: AbortSignal.timeout(Math.min(remaining, 30_000)) }))!;
    } catch (error) {
      if (deadline <= Date.now()) throw timedOut();
      if (!(error instanceof CliError) || !["network", "server_error"].includes(error.code)) throw error;
    }
  }
  if (release.status === "failed" || (options.wait && release.status === "archived"))
    return buildFailure(api, release, options.wait ? Math.min(5000, deadline - Date.now()) : undefined);
  return { dryRun: false, deployment, release };
}

export async function hostingPromote(api: ApiClient, releaseId: string, options: { deploymentId?: string; dryRun?: boolean } = {}): Promise<z.infer<typeof hostingPromoteSchema>> {
  const release = await findRelease(api, releaseId, options.deploymentId);
  if (release.status !== "ready") throw new CliError("release_not_ready", "Only a ready release can be promoted.");
  if (options.dryRun) return { dryRun: true, release };
  const result = read(promoteSchema, await api.json("POST", releaseRoute(release.deployment_id, release.id) + "/promote", {
    body: {}, signal: apiTimeout(),
  }));
  return { dryRun: false, ...result };
}

export async function hostingLogs(api: ApiClient, releaseId: string, options: {
  deploymentId?: string; follow?: boolean; emit: (record: HostingLogRecord) => void; pause?: (ms: number) => Promise<unknown>;
}) {
  const release = await findRelease(api, releaseId, options.deploymentId);
  let previous = "", pending = "";
  let status: Release["status"] | undefined;
  for (;;) {
    const snapshot = await releaseLogs(api, release);
    if (!snapshot.logs.startsWith(previous)) {
      pending = "";
      previous = "";
      options.emit({ type: "reset", releaseId });
    }
    const lines = (pending + snapshot.logs.slice(previous.length)).split(/\r?\n/);
    pending = lines.pop()!;
    const done = !options.follow || isFinished(snapshot.status);
    if (done && pending) lines.push(pending);
    for (const line of lines) options.emit({ type: "log", releaseId, line });
    if (status !== snapshot.status) options.emit({ type: "status", releaseId, status: snapshot.status });
    if (done) return;
    previous = snapshot.logs;
    status = snapshot.status;
    await (options.pause ?? delay)(POLL_MS);
  }
}
