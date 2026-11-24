import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ApiClient } from "./api";
import { isPersonalCredential } from "./auth";
import { writePrivateFile } from "./credentials";
import { CliError, EXIT } from "./errors";
import { lockFile } from "./fileLock";
import { PROJECT_KEY_SCOPES } from "./login";

const keyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const keySchema = z.object({
  id: keyIdSchema, name: z.string(), key_hint: z.string(), scopes: z.array(z.string()),
  status: z.string().optional(), last_used: z.string().nullish(),
});
const createdSchema = keySchema.extend({ secret: z.string().regex(/^ama_pk_[A-Za-z0-9]{32}$/) });
const apiKeySchema = z.looseObject({ id: z.string(), name: z.string() });
export const keysListSchema = z.object({ projectKeys: z.array(keySchema), contentApiKeys: z.array(apiKeySchema) });
export const keyCreateSchema = z.discriminatedUnion("dryRun", [
  z.object({ dryRun: z.literal(true), name: z.string(), scopes: z.array(z.string()), envFile: z.string() }),
  z.object({ dryRun: z.literal(false), hint: z.string(), envFile: z.string() }),
]);
export const keyRevokeSchema = z.object({ dryRun: z.boolean(), id: keyIdSchema, revoked: z.boolean() });

const requestTimeout = () => AbortSignal.timeout(30_000);

function requireLogin(api: ApiClient) {
  if (!isPersonalCredential(api.session.token)) {
    throw new CliError("login_required", "Project keys are managed from a browser login.", {
      exitCode: EXIT.auth, fix: "Run 'atmyapp login --scopes keys.manage,...' and use that session for this project.",
    });
  }
}

export async function listKeys(api: ApiClient): Promise<z.infer<typeof keysListSchema>> {
  requireLogin(api);
  const [projectKeys, contentApiKeys] = await Promise.all([
    api.json("GET", "project-keys", { signal: requestTimeout() }),
    api.json("GET", "api-keys", { signal: requestTimeout() }),
  ]);
  const result = keysListSchema.safeParse({ projectKeys, contentApiKeys });
  if (!result.success) throw new CliError("invalid_response", "The server returned an unexpected key list.");
  return result.data;
}

function envContents(file: string): string {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Not a regular env file of supported size");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { return fs.readFileSync(fd, "utf8"); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new CliError("env_file_unavailable", "Could not read the target env file.", { details: { envFile: file } });
  }
}

function withKey(contents: string, token: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const assignment = "ATMYAPP_CLI_KEY=" + token;
  const pattern = /^[\t ]*(?:export[\t ]+)?ATMYAPP_CLI_KEY[\t ]*=/;
  let replaced = false;
  const lines: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!pattern.test(line)) lines.push(line);
    else if (!replaced) {
      lines.push(assignment);
      replaced = true;
    }
  }
  const output = lines.join(newline);
  if (replaced) return output.endsWith(newline) ? output : output + newline;
  return output + (output && !output.endsWith(newline) ? newline : "") + assignment + newline;
}

export async function createKey(api: ApiClient, options: { name: string; scopes: string[]; envFile?: string; dryRun?: boolean; replace?: boolean }): Promise<z.infer<typeof keyCreateSchema>> {
  requireLogin(api);
  const name = options.name.trim();
  const scopeSchema = z.array(z.enum(PROJECT_KEY_SCOPES)).min(1);
  const validated = scopeSchema.safeParse(options.scopes);
  if (!name || name.length > 100 || !validated.success)
    throw new CliError("invalid_key", "Enter a key name and one or more project key scopes.", { exitCode: EXIT.usage });
  const scopes = [...new Set(validated.data)];
  const requested = path.resolve(options.envFile ?? ".env.local");
  let envFile: string;
  try {
    const parent = fs.realpathSync(path.dirname(requested));
    fs.accessSync(parent, fs.constants.W_OK);
    envFile = path.join(parent, path.basename(requested));
  } catch {
    throw new CliError("env_file_unavailable", "The target directory must exist and be writable.", { details: { envFile: requested } });
  }
  envContents(envFile);
  // `--replace`: the active key with this name is revoked and replaced in one
  // approved request (CliEverywherePlan §4.4.6), for example after its secret was lost.
  let replaceKeyId: string | undefined;
  if (options.replace) {
    const { projectKeys } = await listKeys(api);
    const existing = projectKeys.find((key) => key.name.toLowerCase() === name.toLowerCase() && key.status !== "revoked");
    if (!existing) {
      throw new CliError("key_not_found", `No active key called '${name}' to replace.`, {
        details: { keys: projectKeys.map(({ id, name: keyName, key_hint }) => ({ id, name: keyName, hint: key_hint })) },
        fix: "Drop --replace to create a new key.",
      });
    }
    replaceKeyId = existing.id;
  }
  if (options.dryRun) return { dryRun: true, name, scopes, envFile };
  const unlock = lockFile(envFile + ".atmyapp-lock", "Another command is updating this env file.");
  try {
    const raw = await api.json("POST", "project-keys", { body: { name, scopes, ...(replaceKeyId ? { replaceKeyId } : {}) }, signal: requestTimeout() });
    const created = createdSchema.safeParse(raw);
    if (!created.success) throw new CliError("invalid_response", "The server returned an invalid key creation response.");
    const { id, secret } = created.data;
    // Derive the hint locally so a malformed response cannot print the entire key.
    const hint = "ama_pk_…" + secret.slice(-4);
    try {
      writePrivateFile(envFile, withKey(envContents(envFile), secret));
    } catch {
      const revoked = await revokeKey(api, id).then(() => true, () => false);
      throw new CliError("env_file_write_failed", revoked
        ? "Could not write the env file. The new key was revoked."
        : "Could not write the env file or revoke the new key.", {
        details: { envFile, id, hint, revoked },
        ...(revoked ? {} : { fix: "Revoke key " + id + " before trying again." }),
      });
    }
    return { dryRun: false, hint, envFile };
  } finally {
    unlock();
  }
}

export async function revokeKey(api: ApiClient, id: string, dryRun = false): Promise<z.infer<typeof keyRevokeSchema>> {
  requireLogin(api);
  if (!keyIdSchema.safeParse(id).success) throw new CliError("invalid_key_id", "Invalid project key ID.", { exitCode: EXIT.usage });
  if (dryRun) return { dryRun, id, revoked: false };
  const result = await api.json<{ deleted?: boolean }>("DELETE", "project-keys/" + id, { signal: requestTimeout() });
  if (!result?.deleted) throw new CliError("invalid_response", "The server did not confirm that the key was revoked.");
  return { dryRun, id, revoked: true };
}
