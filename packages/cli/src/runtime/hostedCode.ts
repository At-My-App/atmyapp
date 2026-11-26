import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApiClient } from "./api";
import { credentialsPath, writePrivateFile } from "./credentials";
import { CliError, EXIT } from "./errors";

/**
 * Code stored in AtMyApp (HostedCodeSources.md §8): create a repository,
 * clone it with Git signed in by the CLI, push and see the build start.
 * Git talks to Cloudflare Artifacts directly; `atmyapp git credential`
 * hands git a 24-hour token after the server checks the person's access.
 */

const timeout = () => AbortSignal.timeout(30_000);
const ARTIFACTS_HOST = /\.artifacts\.cloudflare\.net$/i;

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

export const hostedCodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  remote: z.string(),
  branch: z.string(),
  lastPushAt: z.string().nullable(),
});
export type HostedCode = z.infer<typeof hostedCodeSchema>;

export async function listHostedCode(api: ApiClient): Promise<HostedCode[]> {
  const raw = await api.json("GET", "code-sources/hosted", { signal: timeout() });
  return read(z.object({ repositories: z.array(hostedCodeSchema) }), raw, "hosted repositories").repositories;
}

/** By name or ID; with one hosted repository the name is optional. */
export async function findHostedCode(api: ApiClient, ref?: string): Promise<HostedCode> {
  const all = await listHostedCode(api);
  const wanted = ref?.trim().toLowerCase();
  const found = wanted ? all.find((source) => source.id === ref!.trim() || source.name.toLowerCase() === wanted) : all.length === 1 ? all[0] : undefined;
  if (found) return found;
  throw new CliError(wanted ? "code_source_not_found" : "code_source_required", wanted
    ? `This project has no code called '${ref}' stored in AtMyApp.`
    : all.length ? "This project has several code repositories. Name one." : "This project has no code stored in AtMyApp yet.", {
    exitCode: wanted ? EXIT.error : EXIT.usage,
    details: { code: all.map(({ id, name }) => ({ id, name })) },
    fix: all.length ? "Run 'atmyapp code ls'." : "Create it with 'atmyapp code create'.",
  });
}

export const createdSchema = z.object({ code: hostedCodeSchema, cloneCommand: z.string() });

export async function createHostedCode(api: ApiClient, options: { name?: string; starter?: string; operationId?: string }): Promise<z.infer<typeof createdSchema>> {
  const raw = await api.json("POST", "code-sources", {
    body: { provider: "atmyapp", display_name: options.name, starter_id: options.starter ?? null, operation_id: options.operationId ?? randomUUID() },
    signal: AbortSignal.timeout(90_000),
  });
  const parsed = read(z.object({
    codeSource: z.looseObject({ id: z.string(), display_name: z.string().nullish(), repo: z.string(), hosted_remote: z.string(), default_branch: z.string().nullish(), last_push_at: z.string().nullish() }),
  }), raw, "code repository");
  const source = parsed.codeSource;
  const code = { id: source.id, name: source.display_name || source.repo, remote: source.hosted_remote, branch: source.default_branch || "main", lastPushAt: source.last_push_at ?? null };
  return { code, cloneCommand: `atmyapp code clone ${code.name}` };
}

// --- Git ------------------------------------------------------------------------

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitInteractive(args: string[], cwd?: string): number {
  return spawnSync("git", args, { cwd, stdio: "inherit" }).status ?? 1;
}

function requireGit() {
  try {
    git(["--version"]);
  } catch {
    throw new CliError("git_missing", "Git isn't installed or isn't on PATH.", { fix: "Install Git from https://git-scm.com and run the command again." });
  }
}

/** Git asks this CLI for credentials for our Artifacts host only. */
function helperConfig(remote: string, project: string, codeId: string): Array<[string, string]> {
  const host = new URL(remote).host;
  return [
    [`credential.https://${host}.helper`, "!atmyapp git credential"],
    [`credential.https://${host}.useHttpPath`, "true"],
    ["atmyapp.project", project],
    ["atmyapp.codeSource", codeId],
  ];
}

export async function cloneHostedCode(api: ApiClient, project: string, options: { ref?: string; directory?: string }) {
  requireGit();
  const code = await findHostedCode(api, options.ref);
  const directory = path.resolve(options.directory || code.name);
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) {
    throw new CliError("directory_not_empty", `${directory} already exists and isn't empty.`, { exitCode: EXIT.usage, fix: "Choose another folder, or use 'atmyapp code setup-git' inside an existing checkout." });
  }
  const config = helperConfig(code.remote, project, code.id);
  const status = gitInteractive(["clone", ...config.flatMap(([key, value]) => ["-c", `${key}=${value}`]), code.remote, directory]);
  if (status !== 0) throw new CliError("git_clone_failed", "git clone failed.", { fix: "Check the message above. 'atmyapp whoami' shows which project you're signed in to." });
  for (const [key, value] of config) git(["config", key, value], directory);
  return { code, directory, empty: !code.lastPushAt };
}

export async function setupGit(api: ApiClient, project: string, options: { ref?: string; remote?: string; cwd?: string }) {
  requireGit();
  const cwd = options.cwd ?? process.cwd();
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    throw new CliError("not_a_git_repository", "This folder isn't a Git repository.", { exitCode: EXIT.usage, fix: "Run 'git init' first, or use 'atmyapp code clone'." });
  }
  const code = await findHostedCode(api, options.ref);
  const remoteName = options.remote || "atmyapp";
  const existing = (() => {
    try { return git(["remote", "get-url", remoteName], cwd); } catch { return null; }
  })();
  if (existing === null) git(["remote", "add", remoteName, code.remote], cwd);
  else if (existing !== code.remote) git(["remote", "set-url", remoteName, code.remote], cwd);
  for (const [key, value] of helperConfig(code.remote, project, code.id)) git(["config", key, value], cwd);
  return { code, remote: remoteName, pushCommand: `git push ${remoteName} ${code.branch}` };
}

const releaseSchema = z.object({ id: z.string(), status: z.string().nullable() });
const statusSchema = z.object({ complete: z.boolean(), releases: z.array(releaseSchema) });

/** Machine-readable Git output names the updated destination even for explicit refspecs. */
export function pushedBranches(output: string, resolve: (source: string) => string) {
  const branches: Array<{ branch: string; sha: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const [flag, refspec, summary] = line.split("\t");
    if (![" ", "*", "+"].includes(flag) || !refspec) continue;
    const [source, target] = refspec.split(":");
    if (!target?.startsWith("refs/heads/")) continue;
    const sha = summary?.match(/\.{2,3}([a-f0-9]{40})\b/)?.[1] ?? resolve(source);
    branches.push({ branch: target.slice("refs/heads/".length), sha });
  }
  return branches;
}

export async function pushHostedCode(api: ApiClient, options: { ref?: string; remote?: string; gitArgs: string[]; waitMs?: number }) {
  requireGit();
  const code = await findHostedCode(api, options.ref);
  const remote = options.remote || remoteFor(code.remote) || "atmyapp";
  if (git(["remote", "get-url", "--push", "--all", remote]) !== code.remote)
    throw new CliError("remote_mismatch", "The selected Git remote must push to this hosted repository.");
  const statusPath = `code-sources/${encodeURIComponent(code.id)}/push-status`;
  const watermark = read(z.object({ observed_at: z.string() }), await api.json("GET", statusPath, { signal: timeout() }), "push status");
  const args = options.gitArgs.length ? options.gitArgs : [git(["symbolic-ref", "--short", "HEAD"])];
  const result = spawnSync("git", ["-c", "core.abbrev=40", "push", "--porcelain", remote, ...args], {
    encoding: "utf8", stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    throw new CliError("git_push_failed", "git push failed.");
  }
  const updates = pushedBranches(result.stdout, (source) => git(["rev-parse", "--verify", `${source}^{commit}`]));
  const releases = new Map<string, z.infer<typeof releaseSchema>>();
  if (updates.length) {
    await api.json("POST", `code-sources/${encodeURIComponent(code.id)}/check-pushes`, { body: {}, signal: timeout() }).catch(() => null);
    const deadline = Date.now() + (options.waitMs ?? 30_000);
    const pending = new Set(updates);
    do {
      await Promise.all([...pending].map(async (update) => {
        const response = await api.json("GET", statusPath, { query: { ...update, since: watermark.observed_at }, signal: timeout() });
        const status = read(statusSchema, response, "push status");
        for (const release of status.releases) releases.set(release.id, release);
        if (status.complete) pending.delete(update);
      }));
      if (!pending.size || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(3000, deadline - Date.now())));
    } while (pending.size);
  }
  const all = [...releases.values()];
  return { code, branch: updates.map((update) => update.branch).join(", "), updates, releases: all, release: all[0] ?? null };
}

function remoteFor(url: string): string | null {
  try {
    const lines = git(["remote", "-v"]).split("\n");
    const match = lines.find((line) => line.includes(url) && line.endsWith("(push)"));
    return match ? match.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
}

// --- `atmyapp git credential` (git's credential helper protocol) ---------------

type CredentialRequest = { protocol?: string; host?: string; path?: string };

export function parseCredentialInput(input: string): CredentialRequest {
  const request: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) request[line.slice(0, index)] = line.slice(index + 1);
  }
  return request;
}

type CacheEntry = { password: string; expiresAt: string; username: string };

function cachePath() {
  return path.join(path.dirname(credentialsPath()), "git-credentials.json");
}

function readCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CacheEntry>) {
  fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
  writePrivateFile(cachePath(), JSON.stringify(cache));
}

/** The project and code source this checkout belongs to (set by clone/setup-git). */
export function checkoutTarget(cwd = process.cwd()): { project: string | null; codeSource: string | null } {
  const value = (key: string) => {
    try { return git(["config", "--get", key], cwd) || null; } catch { return null; }
  };
  // `git clone -c …` passes these to the helper too (GIT_CONFIG_PARAMETERS);
  // the variables cover tools that call git without the repository config.
  return {
    project: value("atmyapp.project") ?? process.env.ATMYAPP_GIT_PROJECT ?? null,
    codeSource: value("atmyapp.codeSource") ?? process.env.ATMYAPP_GIT_CODE_SOURCE ?? null,
  };
}

/**
 * Answers git: prints `username`, `password`, `password_expiry_utc`, or
 * nothing for hosts that aren't ours (git then asks its other helpers).
 */
export async function gitCredential(
  action: string,
  input: string,
  connectFor: (project: string) => ApiClient,
  options: { now?: number; cwd?: string } = {}
): Promise<string> {
  const request = parseCredentialInput(input);
  if (request.protocol !== "https" || !request.host || !ARTIFACTS_HOST.test(request.host)) return "";
  const key = `${request.host}/${request.path ?? ""}`;
  const cache = readCache();
  if (action === "erase") {
    delete cache[key];
    writeCache(cache);
    return "";
  }
  if (action !== "get") return "";
  const now = options.now ?? Date.now();
  const cached = cache[key];
  if (cached && Date.parse(cached.expiresAt) - now > 10 * 60_000) return answer(cached);
  const target = checkoutTarget(options.cwd);
  if (!target.project || !target.codeSource) {
    process.stderr.write("atmyapp: this checkout isn't linked to a project. Run 'atmyapp code setup-git' in it.\n");
    return "";
  }
  const api = connectFor(target.project);
  const raw = await api.json("POST", `code-sources/${encodeURIComponent(target.codeSource)}/git-credential`, {
    body: { host: request.host, path: request.path ?? null },
    signal: timeout(),
  });
  const credential = read(z.object({
    username: z.string(), password: z.string(), expires_at: z.string(), scope: z.enum(["read", "write"]), warning: z.string().nullish(),
  }), raw, "Git credential");
  if (credential.warning) process.stderr.write(`atmyapp: ${credential.warning}\n`);
  const entry = { username: credential.username, password: credential.password, expiresAt: credential.expires_at };
  cache[key] = entry;
  // Forget tokens that have expired.
  for (const [cachedKey, value] of Object.entries(cache)) if (Date.parse(value.expiresAt) <= now) delete cache[cachedKey];
  writeCache(cache);
  return answer(entry);
}

function answer(entry: CacheEntry): string {
  return `username=${entry.username}\npassword=${entry.password}\npassword_expiry_utc=${Math.floor(Date.parse(entry.expiresAt) / 1000)}\n`;
}
