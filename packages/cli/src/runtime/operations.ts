import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Operation IDs that survive an interrupted command (CliEverywherePlan §11.1
 * P1-5, P1-6). A deliberate action gets a fresh ID; if it is interrupted (a
 * lost response, Ctrl+C, a timeout while waiting for approval), running the
 * same command again reuses that ID, so the server replays instead of acting
 * twice. Once the action is known to have finished, the ID is forgotten and
 * the next run is a new action.
 */

/** Pending operations older than this are a new action, like approval receipts. */
export const OPERATION_TTL_MS = 24 * 3_600_000;

export function operationsDir(): string {
  const override = process.env.ATMYAPP_STATE_DIR;
  if (override && path.isAbsolute(override)) return path.join(override, "operations");
  const config = process.env.XDG_CONFIG_HOME;
  return path.join(config && path.isAbsolute(config) ? config : path.join(os.homedir(), ".config"), "atmyapp", "operations");
}

export interface Operation {
  id: string;
  /** True when this run continues an interrupted one. */
  resumed: boolean;
  /** The action finished (applied or refused): the next run is a new action. */
  done(): void;
}

/**
 * The ID for one action, keyed by where it goes (API URL and project), what it
 * is, and its arguments. State is best effort: without a writable directory,
 * every run is a new action (still never a silent no-op).
 */
export function operation(scope: { url: string; projectId: string }, kind: string, key: unknown, now = Date.now()): Operation {
  const digest = createHash("sha256").update(JSON.stringify([scope.url.replace(/\/+$/, ""), scope.projectId, kind, key])).digest("hex");
  const file = path.join(operationsDir(), `${digest.slice(0, 40)}.json`);
  let id: string | null = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown; createdAt?: unknown };
    if (typeof saved.id === "string" && typeof saved.createdAt === "number" && now - saved.createdAt < OPERATION_TTL_MS) id = saved.id;
  } catch {
    // No pending operation.
  }
  const resumed = Boolean(id);
  if (!id) {
    id = randomUUID();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ id, kind, createdAt: now }), { mode: 0o600 });
    } catch {
      // Without saved state a rerun is a new action.
    }
  }
  return {
    id,
    resumed,
    done: () => {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    },
  };
}
