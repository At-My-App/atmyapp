import { z } from "zod";
import { CliError, stillPending } from "./errors";

/**
 * A hosted draft preview runs on a preview server that may be asleep. Its
 * link answers with a loading page (HTTP 503) until the server is ready, which
 * looks like an outage to a script. The preview host exposes the real state at
 * a fixed path, so the CLI can report it and wait for it.
 */
export const PREVIEW_STATUS_PATH = "/.well-known/atmyapp/preview/status";
export const PREVIEW_RETRY_PATH = "/.well-known/atmyapp/preview/retry";

/**
 * - `ready`: the link shows the draft.
 * - `starting`: the preview server is waking up (usually under a minute).
 * - `error`: the server failed to start; `--wait` asks it to try again once.
 * - `ended`: the draft or its preview no longer exists.
 * - `unknown`: the state could not be read (for example a members-only preview).
 */
export const previewStateSchema = z.enum(["ready", "starting", "error", "ended", "unknown"]);
export type PreviewState = z.infer<typeof previewStateSchema>;

const statusBodySchema = z.object({ status: z.string() });

export interface PreviewProbeOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

function endpoint(previewUrl: string, path: string): URL {
  const url = new URL(previewUrl);
  // Keep the query: it carries the preview key the host checks.
  return new URL(path + url.search, url.origin);
}

/** One look at the preview server's state. Never throws. */
export async function probePreview(previewUrl: string, options: PreviewProbeOptions = {}): Promise<PreviewState> {
  const fetchApi = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchApi(endpoint(previewUrl, PREVIEW_STATUS_PATH), {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 410 || response.status === 404) return "ended";
    if (!response.ok) return "unknown";
    const parsed = statusBodySchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return "unknown";
    const state = parsed.data.status;
    if (state === "starting" || state === "error") return state;
    if (state !== "ready") return "unknown";
    // The host can remember a server as ready after it fell asleep; only a
    // real page request finds out (and starts waking it). Confirm with one.
    return await pageServes(previewUrl, fetchApi) ? "ready" : "starting";
  } catch {
    return "unknown";
  }
}

/** False while the page answers with the host's loading response. */
async function pageServes(previewUrl: string, fetchApi: typeof fetch): Promise<boolean> {
  const response = await fetchApi(previewUrl, {
    headers: { accept: "text/html" },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel().catch(() => undefined);
  const hostState = response.headers.get("x-atmyapp-preview-state");
  if (hostState) return false;
  // Hosts before the state header: a 503 with Retry-After is the loading page.
  return !(response.status === 503 && response.headers.has("retry-after"));
}

async function requestRetry(previewUrl: string, fetchApi: typeof fetch): Promise<void> {
  const target = endpoint(previewUrl, PREVIEW_RETRY_PATH);
  // The host only accepts a retry from its own origin.
  await fetchApi(target, { method: "POST", headers: { origin: target.origin }, signal: AbortSignal.timeout(10_000) })
    .then((response) => response.body?.cancel())
    .catch(() => undefined);
}

/**
 * Polls until the preview is ready. A failed start is retried once; anything
 * else that is not `ready` before the deadline ends in a `CliError` that says
 * what to do next.
 */
export async function waitForPreview(
  previewUrl: string,
  timeoutMs: number,
  options: PreviewProbeOptions & { onWaiting?: (state: PreviewState) => void } = {},
): Promise<PreviewState> {
  const fetchApi = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let retried = false;
  let announced = false;
  let unknownInARow = 0;
  for (;;) {
    const state = await probePreview(previewUrl, { fetch: fetchApi });
    if (state === "ready") return state;
    if (state === "ended") {
      throw new CliError("preview_ended", "This draft's preview has ended.", {
        fix: "Run 'atmyapp stage status' to check the draft, then 'atmyapp stage preview' again.",
      });
    }
    if (state === "error") {
      if (retried) {
        throw new CliError("preview_failed", "The preview server could not start.", {
          details: { url: previewUrl },
          fix: "Try 'atmyapp stage preview --wait' again in a minute. If it keeps failing, check the website's dev server in the dashboard.",
        });
      }
      retried = true;
      await requestRetry(previewUrl, fetchApi);
    }
    // A members-only preview can hide its state from the CLI; don't wait blind.
    if (state === "unknown" && ++unknownInARow >= 3) return state;
    if (state !== "unknown") unknownInARow = 0;
    if (!announced && state === "starting") {
      announced = true;
      options.onWaiting?.(state);
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw stillPending("preview_timeout", "The preview is still starting.", {
        state,
        resume: "atmyapp stage preview --wait",
        details: { url: previewUrl },
        fix: "Run 'atmyapp stage preview --wait' again, or open the link: it shows a loading page and reloads when ready.",
      });
    }
    await sleep(Math.min(2_000, remaining));
  }
}
