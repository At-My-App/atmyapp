import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CliError, EXIT } from "./errors";
import { nativeCredential, windowsPrivateFile } from "./nativeCredentials";
import { lockFile } from "./fileLock";
import type { CliSession } from "./session";

const tokenSchema = z.string().regex(/^ama_cs_[a-f0-9]{64}$/);
const common = z.object({ url: z.string().url(), projectId: z.string().min(1), expiresAt: z.iso.datetime({ offset: true }) });
const credentialSchema = z.discriminatedUnion("backend", [
  common.extend({ backend: z.literal("keychain"), account: z.uuid() }),
  common.extend({ backend: z.literal("file"), token: tokenSchema }),
]);
type StoredCredential = z.infer<typeof credentialSchema>;

export interface BrowserLogin extends CliSession { expiresAt: string }

export function credentialsPath() {
  const config = process.env.XDG_CONFIG_HOME;
  return path.join(config && path.isAbsolute(config) ? config : path.join(os.homedir(), ".config"), "atmyapp", "credentials.json");
}

/** Publish an owner-only file atomically, with a private temporary sibling. */
export function writePrivateFile(file: string, contents: string) {
  const temp = path.join(path.dirname(file), "." + randomUUID() + ".atmyapp-tmp");
  try {
    if (process.platform === "win32") {
      fs.writeFileSync(temp, "", { mode: 0o600, flag: "wx" });
      if (!windowsPrivateFile(temp, true)) throw new Error("Could not restrict access to the destination file");
      fs.writeFileSync(temp, contents, { flag: "r+" });
    } else {
      fs.writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
    }
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function readFile(file: string): StoredCredential | null {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Credential file cannot be a symbolic link");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 16_384 ||
          (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) ||
          (process.platform === "win32" && !windowsPrivateFile(file, false))) {
        throw new Error("Credential file permissions are not private");
      }
      return credentialSchema.parse(JSON.parse(fs.readFileSync(fd, "utf8")));
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError("credentials_unavailable", "Could not read the saved CLI login.", {
      exitCode: EXIT.auth, fix: "Check the ownership and permissions of " + file + " or sign in again.",
    });
  }
}

function toBrowserLogin(row: StoredCredential | null, options: { includeExpired?: boolean; requireAvailable?: boolean }): BrowserLogin | null {
  if (!row || (!options.includeExpired && Date.parse(row.expiresAt) <= Date.now())) return null;
  const token = tokenSchema.safeParse(row.backend === "file" ? row.token : nativeCredential("read", row.account));
  if (!token.success && options.requireAvailable)
    throw new CliError("credentials_unavailable", "Unlock the OS keychain to retrieve your saved CLI login.", { exitCode: EXIT.auth });
  if (!token.success) return null;
  return { token: token.data, url: row.url, projectId: row.projectId, expiresAt: row.expiresAt };
}

export function readBrowserLogin(options: { includeExpired?: boolean; requireAvailable?: boolean; file?: string } = {}): BrowserLogin | null {
  return toBrowserLogin(readFile(options.file ?? credentialsPath()), options);
}

export function saveBrowserLogin(login: BrowserLogin, file = credentialsPath()): { backend: StoredCredential["backend"]; replaced: BrowserLogin | null } {
  fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  const unlock = lockFile(file + ".lock", "Another command is updating the saved CLI login.");
  try {
    let previous: StoredCredential | null;
    try { previous = readFile(file); }
    catch { previous = null; } // A new sign-in can repair malformed local metadata.
    const replaced = toBrowserLogin(previous, {});
    const account = randomUUID();
    const backend = nativeCredential("write", account, login.token) === null ? "file" : "keychain";
    const { token, ...metadata } = login;
    const contents = backend === "keychain" ? { ...metadata, backend, account } : { ...metadata, backend, token };
    try {
      writePrivateFile(file, JSON.stringify(credentialSchema.parse(contents)) + "\n");
    } catch {
      if (backend === "keychain") nativeCredential("delete", account);
      throw new CliError("credentials_unavailable", "Could not save the CLI login on this computer.", { exitCode: EXIT.auth });
    }
    if (previous?.backend === "keychain") nativeCredential("delete", previous.account);
    return { backend, replaced };
  } finally {
    unlock();
  }
}

/** Avoid clearing a newer login written while a logout was in flight. */
export function removeBrowserLogin(login: BrowserLogin, file = credentialsPath()): boolean {
  if (!fs.existsSync(file)) return false;
  const unlock = lockFile(file + ".lock", "Another command is updating the saved CLI login.");
  try {
    const row = readFile(file);
    if (!row || toBrowserLogin(row, { includeExpired: true })?.token !== login.token) return false;
    fs.rmSync(file);
    if (row.backend === "keychain") nativeCredential("delete", row.account);
    return true;
  } finally {
    unlock();
  }
}
