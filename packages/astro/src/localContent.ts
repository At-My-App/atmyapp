import { createReadStream, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Dev-server route for files in the local content store (.ama/content).
 * Pages rendered over http(s) can't load file:// URLs, so in local mode the
 * SDK points images and files at this route instead
 * (ATMYAPP_LOCAL_ASSET_BASE). Read-only and confined to the store.
 */
export const LOCAL_CONTENT_ROUTE = "/__atmyapp/content/";

const TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** The file a request names, or null when it is outside the store or not a plain file. */
export function resolveLocalContentFile(root: string, requestPath: string): string | null {
  const segments = requestPath.split("?")[0].split("/").filter((segment) => segment !== "");
  if (!segments.length) return null;
  let decoded: string[];
  try {
    decoded = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (decoded.some((segment) => segment === "." || segment === ".." || /[\\/\0]/.test(segment))) return null;
  const name = decoded[decoded.length - 1];
  if (name === ".lock" || name.endsWith(".tmp")) return null;
  try {
    const realRoot = realpathSync(root);
    const file = realpathSync(join(realRoot, ...decoded));
    const inside = relative(realRoot, file);
    if (!inside || inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) return null;
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function serveLocalContent(root: string) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    const file = resolveLocalContentFile(root, request.url ?? "");
    if (!file) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("Content-Length", String(statSync(file).size));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    // An SVG opened directly must not run script on the dev server's origin.
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).on("error", () => response.destroy()).pipe(response);
  };
}
