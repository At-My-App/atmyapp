import { readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { CliError, EXIT } from "./errors";
import { sha256Hex } from "./fingerprint";

export const maxStagedAssetBytes = 50 * 1024 * 1024;
const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".csv": "text/csv",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
};

export function fileMime(file: string) {
  return mimeTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function readAssetFile(filename: string) {
  try {
    const stat = statSync(filename);
    if (!stat.isFile()) throw new Error("Expected a regular file");
    if (stat.size > maxStagedAssetBytes)
      throw new CliError("value_too_large", "A staged file can be at most 50 MiB.", { exitCode: EXIT.validation });
    const bytes = readFileSync(filename);
    if (bytes.length !== stat.size)
      throw new CliError("asset_changed", "The file changed while it was being read.", { exitCode: EXIT.conflict });
    return bytes;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("asset_unavailable", `Could not read ${filename}.`, { exitCode: EXIT.validation });
  }
}

export const isLocalAsset = (value: unknown): value is { $file: string; alt?: string } =>
  !!value &&
  typeof value === "object" &&
  Object.prototype.hasOwnProperty.call(value, "$file") &&
  typeof (value as { $file: unknown }).$file === "string";

export function localAssetPath(root: string, document: string, filename: string): string {
  let absolute: string;
  try {
    if (!filename || path.isAbsolute(filename) || path.win32.isAbsolute(filename)) throw new Error();
    absolute = realpathSync(path.resolve(path.dirname(document), filename));
    const relative = path.relative(realpathSync(root), absolute);
    if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative))
      throw new Error();
  } catch {
    throw new CliError("asset_unavailable", `Asset '${filename}' must be a readable file inside this space.`, {
      exitCode: EXIT.validation,
    });
  }
  return absolute;
}

export function linkedAssetHashes(root: string, file: string, bytes: Buffer) {
  if (!bytes.includes('"$file"')) return [];
  let source: unknown;
  try {
    source = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [];
  }
  const hashes: string[] = [];
  function visit(value: unknown) {
    if (isLocalAsset(value)) {
      try {
        hashes.push(sha256Hex(readAssetFile(localAssetPath(root, file, value.$file))));
      } catch {
        hashes.push("missing");
      }
    } else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(source);
  return hashes;
}
