import { listHostedCode } from "./hostedCode";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ApiClient } from "./api";
import { ensure } from "./ensure";
import { CliError, EXIT, needsPerson, stillPending } from "./errors";

/**
 * Code sources (`atmyapp code`, CliEverywherePlan §5.5 4a). GitHub access is
 * the person's own: the server lists the repositories GitHub shows them
 * through the AtMyApp app, and a browser page connects the account. The
 * provider is a field, so another provider needs no new commands (E15).
 */

const timeout = () => AbortSignal.timeout(30_000);

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

const repositorySchema = z.object({
  fullName: z.string(), owner: z.string(), name: z.string(), installationId: z.number(),
  defaultBranch: z.string().nullable(), private: z.boolean(),
});
export type Repository = z.infer<typeof repositorySchema>;

const accessSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_authorized"), repositories: z.array(repositorySchema), connectUrl: z.string() }),
  z.object({ status: z.literal("ok"), installations: z.number(), repositories: z.array(repositorySchema), connectUrl: z.string() }),
]);
export type GithubAccess = z.infer<typeof accessSchema>;

export async function githubAccess(api: ApiClient, repo?: string): Promise<GithubAccess> {
  const raw = await api.cliAuth("GET", "github" + (repo ? `?repo=${encodeURIComponent(repo)}` : ""), { signal: timeout() });
  return read(accessSchema, raw, "GitHub access");
}

/** `owner/repo`, as GitHub names it. */
export function parseRepository(value: string): { owner: string; repo: string; fullName: string } {
  const match = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(value.trim().replace(/^https:\/\/github\.com\//, ""));
  if (!match) throw new CliError("invalid_repository", `Name the repository as owner/repo, not '${value}'.`, { exitCode: EXIT.usage });
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

function listed(access: GithubAccess, fullName: string) {
  return access.repositories.find((repository) => repository.fullName.toLowerCase() === fullName.toLowerCase()) ?? null;
}

/** Which of the three things stands between the person and the repository. */
function blocker(access: GithubAccess, fullName: string | null): CliError | null {
  if (access.status === "not_authorized") {
    return needsPerson("browser", "Connect your GitHub account to AtMyApp.", {
      url: access.connectUrl,
      details: { code: "github_authorization_expired" },
      fix: "Open the link, sign in to GitHub and authorize AtMyApp.",
    });
  }
  if (!access.installations) {
    return needsPerson("browser", "Install the AtMyApp app on your GitHub account or organisation.", {
      url: access.connectUrl,
      details: { code: "github_not_installed" },
      fix: "Open the link and install the app where the repository lives.",
    });
  }
  if (fullName && !listed(access, fullName)) {
    return needsPerson("browser", `The AtMyApp app can't reach ${fullName} yet.`, {
      url: access.connectUrl,
      details: { code: "github_repo_not_granted", repository: fullName, installations: access.installations },
      fix: `Open the link and add ${fullName} to the app's repository access.`,
    });
  }
  return null;
}

export const githubConnectSchema = z.object({
  connected: z.literal(true), repository: repositorySchema.nullable(), repositories: z.number(),
});

/**
 * Finishes when GitHub lists the repository for the person (not when a
 * provider record appears: an account can be connected before a new
 * repository is granted). Without `--repo`, when the listing changes or any
 * repository is reachable.
 */
export async function connectGithub(
  api: ApiClient,
  options: { repo?: string; wait?: boolean; timeoutMs?: number; resume?: string; onWaiting?: (error: CliError) => void; pause?: (ms: number) => Promise<unknown> },
): Promise<z.infer<typeof githubConnectSchema>> {
  const target = options.repo ? parseRepository(options.repo).fullName : null;
  let access = await githubAccess(api, target ?? undefined);
  const initial = access.repositories.map((repository) => repository.fullName).sort().join(",");
  const done = () => {
    if (blocker(access, target)) return false;
    if (target) return true;
    return access.repositories.length > 0;
  };
  if (!done()) {
    const first = blocker(access, target) ?? needsPerson("browser", "Give the AtMyApp app access to a repository.", { url: access.connectUrl });
    if (options.wait === false) throw withResume(first, options.resume);
    options.onWaiting?.(first);
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    for (;;) {
      if (Date.now() >= deadline) throw withResume(blocker(access, target) ?? first, options.resume);
      await (options.pause ?? delay)(3000);
      access = await githubAccess(api, target ?? undefined).catch(() => access);
      const now = access.repositories.map((repository) => repository.fullName).sort().join(",");
      if (done() || (!target && now !== initial && now)) break;
    }
  }
  return { connected: true, repository: target ? listed(access, target) : null, repositories: access.repositories.length };
}

function withResume(error: CliError, resume?: string): CliError {
  return needsPerson("browser", error.message, {
    url: error.details?.url as string | undefined,
    resume,
    fix: error.fix,
    details: { ...error.details },
  });
}

export async function listRepositories(api: ApiClient): Promise<{ repositories: Repository[]; connectUrl: string }> {
  const access = await githubAccess(api);
  const problem = blocker(access, null);
  if (problem) throw problem;
  return { repositories: access.repositories, connectUrl: access.connectUrl };
}

// --- Code sources ----------------------------------------------------------------

type Row = Record<string, unknown>;
const pick = (row: Row, ...names: string[]) => names.map((name) => row[name]).find((value) => value !== undefined && value !== null);

export const codeSourceSchema = z.object({
  id: z.string(), provider: z.string(), owner: z.string(), repo: z.string(), branch: z.string().nullable(),
  status: z.string().nullable(), lastSyncedAt: z.string().nullable(), lastSyncError: z.string().nullable(),
  /** Code stored in AtMyApp (provider `atmyapp`). */
  displayName: z.string().nullable().optional(),
  remote: z.string().nullable().optional(),
  lastPushAt: z.string().nullable().optional(),
});

/** `owner/repo` for GitHub, the name for code stored in AtMyApp. */
export function codeSourceName(source: Pick<CodeSource, "provider" | "owner" | "repo" | "displayName">): string {
  return source.provider === "atmyapp" ? source.displayName || source.repo : source.owner ? `${source.owner}/${source.repo}` : source.repo;
}
export type CodeSource = z.infer<typeof codeSourceSchema>;

function toSource(row: Row): CodeSource {
  return {
    id: String(row.id),
    provider: String(pick(row, "provider") ?? "github"),
    owner: String(pick(row, "owner") ?? ""),
    repo: String(pick(row, "repo") ?? ""),
    branch: (pick(row, "default_branch", "defaultBranch") as string | undefined) ?? null,
    status: (pick(row, "status") as string | undefined) ?? null,
    lastSyncedAt: (pick(row, "last_synced_at", "lastSyncedAt") as string | undefined) ?? null,
    lastSyncError: (pick(row, "last_sync_error", "lastSyncError") as string | undefined) ?? null,
    displayName: (pick(row, "display_name", "displayName") as string | undefined) ?? null,
    remote: (pick(row, "hosted_remote", "remote") as string | undefined) ?? null,
    lastPushAt: (pick(row, "last_push_at", "lastPushAt") as string | undefined) ?? null,
  };
}

/** A Git-only credential can discover the hosted repositories it may clone. */
export async function listVisibleCodeSources(api: ApiClient): Promise<{ codeSources: CodeSource[] }> {
  try {
    return await listCodeSources(api);
  } catch (error) {
    if (!(error instanceof CliError) || !["keys_not_accepted", "missing_scope"].includes(error.code)) throw error;
    const hosted = await listHostedCode(api);
    return { codeSources: hosted.map((source) => ({
      id: source.id, provider: "atmyapp", owner: "", repo: source.name, displayName: source.name,
      branch: source.branch, remote: source.remote, lastPushAt: source.lastPushAt,
      status: null, lastSyncedAt: null, lastSyncError: null,
    })) };
  }
}

export async function listCodeSources(api: ApiClient): Promise<{ codeSources: CodeSource[] }> {
  const raw = await api.json("GET", "code-sources", { signal: timeout() });
  const rows = read(z.object({ codeSources: z.array(z.looseObject({ id: z.string() })) }), raw, "code source list").codeSources;
  return { codeSources: rows.map((row) => toSource(row)) };
}

/**
 * A `--repo` value: `owner/repo` for GitHub, or the name of code stored in
 * AtMyApp (also `atmyapp:<name>`). Returns the lookup key `findCodeSource` takes.
 */
export function sourceRef(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("atmyapp:")) return trimmed.slice("atmyapp:".length);
  if (!trimmed.includes("/")) return trimmed;
  return parseRepository(trimmed).fullName;
}

/** By ID or `owner/repo`. */
export async function findCodeSource(api: ApiClient, ref: string): Promise<CodeSource | null> {
  const { codeSources } = await listCodeSources(api);
  const wanted = ref.trim().toLowerCase();
  return codeSources.find((source) => source.id === ref.trim() || codeSourceName(source).toLowerCase() === wanted) ?? null;
}

async function requireCodeSource(api: ApiClient, ref: string): Promise<CodeSource> {
  const found = await findCodeSource(api, ref);
  if (found) return found;
  const { codeSources } = await listCodeSources(api);
  throw new CliError("code_source_not_found", `No code source '${ref}' in this project.`, {
    details: { codeSources: codeSources.map(({ id, owner, repo }) => ({ id, repository: `${owner}/${repo}` })) },
    fix: "Run 'atmyapp code ls', or add it with 'atmyapp code add <owner/repo>'.",
  });
}

async function waitForSync(api: ApiClient, source: CodeSource, options: { timeoutMs?: number; resume: string; pause?: (ms: number) => Promise<unknown>; onProgress?: (status: string) => void }) {
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  let current = source;
  let last = "";
  for (;;) {
    const raw = await api.json("GET", `code-sources/${encodeURIComponent(source.id)}`, { signal: timeout() });
    const row = (raw as { codeSource?: Row } | null)?.codeSource ?? (raw as Row | null);
    if (row && typeof row === "object" && "id" in row) current = toSource(row as Row);
    if (current.status !== last) {
      last = current.status ?? "";
      options.onProgress?.(last);
    }
    if (current.status === "synced") return current;
    if (current.status === "error") {
      throw new CliError("code_sync_failed", `Copying ${current.owner}/${current.repo} failed${current.lastSyncError ? `: ${current.lastSyncError}` : "."}`, {
        details: { codeSource: current }, fix: `Fix the cause, then run 'atmyapp code sync ${current.owner}/${current.repo} --wait'.`,
      });
    }
    if (Date.now() >= deadline) {
      throw stillPending("code_sync_timeout", `${current.owner}/${current.repo} is still copying.`, { state: current.status ?? "syncing", resume: options.resume });
    }
    await (options.pause ?? delay)(3000);
  }
}

export const codeAddSchema = z.object({ codeSource: codeSourceSchema, unchanged: z.boolean() });

/** Adds a repository; safe to run twice (natural key: provider + owner/repo). */
export async function addCodeSource(
  api: ApiClient,
  ref: string,
  options: { branch?: string; wait?: boolean; timeoutMs?: number; pause?: (ms: number) => Promise<unknown>; onProgress?: (status: string) => void },
): Promise<z.infer<typeof codeAddSchema>> {
  const target = parseRepository(ref);
  const outcome = await ensure({
    kind: "code source",
    key: target.fullName,
    find: () => findCodeSource(api, target.fullName),
    differences: (existing): Record<string, { current: unknown; wanted: unknown }> => (options.branch && existing.branch && existing.branch !== options.branch
      ? { branch: { current: existing.branch, wanted: options.branch } } : {}),
    create: async () => {
      const access = await githubAccess(api, target.fullName);
      const problem = blocker(access, target.fullName);
      if (problem) throw withResume(problem, `atmyapp code connect github --repo ${target.fullName}`);
      const repository = listed(access, target.fullName)!;
      const raw = await api.json("POST", "code-sources", {
        body: {
          provider: "github", owner: repository.owner, repo: repository.name,
          default_branch: options.branch ?? repository.defaultBranch ?? "main", installation_id: repository.installationId,
        },
        signal: AbortSignal.timeout(60_000),
      });
      return toSource(read(z.object({ codeSource: z.looseObject({ id: z.string() }) }), raw, "code source").codeSource);
    },
    editCommand: `atmyapp code rm ${target.fullName} && atmyapp code add ${target.fullName} --branch <branch>`,
  });
  let source = outcome.unchanged ? outcome.existing : outcome.created;
  if (options.wait) source = await waitForSync(api, source, { ...options, resume: `atmyapp code sync ${target.fullName} --wait` });
  return { codeSource: source, unchanged: outcome.unchanged };
}

export async function syncCodeSource(
  api: ApiClient,
  ref: string | undefined,
  options: { wait?: boolean; timeoutMs?: number; pause?: (ms: number) => Promise<unknown>; onProgress?: (status: string) => void },
) {
  const source = ref ? await requireCodeSource(api, ref) : await onlyCodeSource(api);
  await api.json("POST", `code-sources/${encodeURIComponent(source.id)}/sync`, { body: {}, signal: AbortSignal.timeout(60_000) });
  const result = options.wait
    ? await waitForSync(api, { ...source, status: "syncing" }, { ...options, resume: `atmyapp code sync ${source.owner}/${source.repo} --wait` })
    : source;
  return { codeSource: result };
}

async function onlyCodeSource(api: ApiClient): Promise<CodeSource> {
  const { codeSources } = await listCodeSources(api);
  if (codeSources.length === 1) return codeSources[0];
  throw new CliError("code_source_required", codeSources.length ? "This project has several code sources. Name one." : "This project has no code source yet.", {
    exitCode: EXIT.usage,
    details: { codeSources: codeSources.map(({ id, owner, repo }) => ({ id, repository: `${owner}/${repo}` })) },
    fix: codeSources.length ? "Pass owner/repo." : "Add one with 'atmyapp code add <owner/repo>'.",
  });
}

export const codeRemoveSchema = z.object({ repository: z.string(), removed: z.boolean(), dryRun: z.boolean() });

export async function removeCodeSource(api: ApiClient, ref: string, options: { ifExists?: boolean; dryRun?: boolean }) {
  const source = await findCodeSource(api, ref);
  if (!source) {
    if (options.ifExists) return { repository: ref, removed: false, dryRun: Boolean(options.dryRun) };
    await requireCodeSource(api, ref);
  }
  const repository = codeSourceName(source!);
  if (options.dryRun) return { repository, removed: false, dryRun: true };
  await api.json("DELETE", `code-sources/${encodeURIComponent(source!.id)}`, { signal: timeout() });
  return { repository, removed: true, dryRun: false };
}
