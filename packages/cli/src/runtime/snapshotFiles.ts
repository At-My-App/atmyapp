import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliError, EXIT } from "./errors";

/**
 * Where `snapshot download` may write, and how it replaces the previous copy
 * (CliEverywherePlan §11.1 P1-7): never a directory holding other files, and
 * never removing the old snapshot before the new one is fully extracted.
 */

export const SNAPSHOT_MARKER = ".atmyapp-snapshot";
export const DEFAULT_SNAPSHOT_DIR = ".ama/local";

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The resolved destination, or a refusal for one that could hold unrelated files. */
export function snapshotDestination(output: string | undefined, options: { cwd?: string; force?: boolean } = {}): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = path.resolve(cwd, output ?? DEFAULT_SNAPSHOT_DIR);
  const refuse = (why: string) => new CliError("unsafe_snapshot_destination", `Won't extract the snapshot into ${target}: ${why}`, {
    exitCode: EXIT.usage,
    fix: `Choose an empty folder or one an earlier snapshot created, such as ${DEFAULT_SNAPSHOT_DIR}.`,
  });
  // The project, the home folder or anything above them is never replaced, even with --force.
  if (contains(target, cwd)) throw refuse("it contains the current folder.");
  if (contains(target, os.homedir())) throw refuse("it contains your home folder.");
  if (path.parse(target).root === target) throw refuse("it is the root of the disk.");
  if (!fs.existsSync(target)) return target;
  if (!fs.statSync(target).isDirectory()) throw refuse("it is a file.");
  const managed = fs.existsSync(path.join(target, SNAPSHOT_MARKER)) || target === path.resolve(cwd, DEFAULT_SNAPSHOT_DIR);
  if (!managed && fs.readdirSync(target).length && !options.force) {
    throw refuse("it already holds files that no snapshot created. Pass --force to replace them.");
  }
  return target;
}

export type Extractor = (zipPath: string, intoDir: string) => void;

export const defaultExtractor: Extractor = (zipPath, intoDir) => {
  // No shell: paths are passed as arguments, never interpreted.
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", zipPath, "-DestinationPath", intoDir, "-Force"], { stdio: "pipe" });
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", intoDir], { stdio: "pipe" });
  }
};

/**
 * Extracts next to the destination, then swaps it in. A corrupt archive or a
 * missing extractor leaves the previous snapshot exactly as it was.
 */
export function replaceWithArchive(zipPath: string, target: string, extract: Extractor = defaultExtractor): void {
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const incoming = `${target}.atmyapp-new-${suffix}`;
  const previous = `${target}.atmyapp-old-${suffix}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(incoming, { recursive: true });
  try {
    extract(zipPath, incoming);
    fs.writeFileSync(path.join(incoming, SNAPSHOT_MARKER), "Created by 'atmyapp snapshot download'. This folder is replaced on the next download.\n");
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true });
    throw new CliError("snapshot_extract_failed", `Failed to extract the snapshot: ${error instanceof Error ? error.message : String(error)}`, {
      fix: process.platform === "win32" ? "The previous snapshot was kept." : "Install unzip and try again. The previous snapshot was kept.",
    });
  }
  const hadPrevious = fs.existsSync(target);
  if (hadPrevious) fs.renameSync(target, previous);
  try {
    fs.renameSync(incoming, target);
  } catch (error) {
    if (hadPrevious) fs.renameSync(previous, target);
    fs.rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
  if (hadPrevious) fs.rmSync(previous, { recursive: true, force: true });
}
