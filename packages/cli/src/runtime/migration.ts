import type { MigrationOperation } from "@atmyapp/structure";
import type { OutputDefinition } from "../cli/types/migrate";
import type { UploadStructureClearRequest } from "./types";

/** The server's reviewable plan (see AMA `StructureMigrationPlan`). */
export interface RemoteMigrationPlan {
  formatVersion: 1;
  projectId: string;
  branch: string;
  baseHeadSha: string | null;
  unchanged: boolean;
  operations: MigrationOperation[];
  changes: Array<{ kind: string; definitionName: string; fieldPath?: string }>;
  actions: Array<{ type: string; message: string }>;
  destructive: {
    issues: Array<{
      kind: string;
      message: string;
      collectionName?: string;
      definitionName?: string;
      columnName?: string;
    }>;
    removedCollections: string[];
    removedContentFiles: string[];
    retainedColumns: Array<{ collection: string; columns: string[] }>;
  };
  effects: {
    changedResources: string[];
    samples: Array<{ resource: string; before: unknown; after: unknown }>;
  };
  content: {
    introduced: MigrationContentIssue[];
    preexisting: MigrationContentIssue[];
  };
  blocks: Array<{ code: string; message: string; resource?: string }>;
  digest: string;
}

export interface MigrationContentIssue {
  resource: string;
  path: string;
  code: string;
  severity: "hard" | "overridable";
  message: string;
}

export interface MigrationTarget {
  url: string;
  token?: string;
  branch?: string;
  fetchImplementation?: typeof fetch;
}

export interface MigrationRequest {
  output: OutputDefinition;
  operations?: MigrationOperation[];
  clear?: UploadStructureClearRequest;
}

export type MigrationCallResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status?: number;
      code?: string;
      error: string;
      data?: Record<string, unknown>;
      /** The request may or may not have reached the server. */
      uncertain?: boolean;
    };

function endpoint(target: MigrationTarget, path: string) {
  const query = target.branch
    ? `?branch=${encodeURIComponent(target.branch)}`
    : "";
  return `${target.url}/storage/structure${path}${query}`;
}

async function call<T>(
  target: MigrationTarget,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<MigrationCallResult<T>> {
  const fetchApi = target.fetchImplementation ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchApi(endpoint(target, path), {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      uncertain: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const text = await response.text();
  let parsed: { success?: boolean; data?: any; error?: string } | undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (response.ok && parsed?.success !== false)
    return { ok: true, status: response.status, data: parsed?.data as T };
  return {
    ok: false,
    status: response.status,
    code: parsed?.data?.code,
    data: parsed?.data,
    error: parsed?.error || text || `HTTP ${response.status}`,
    // A gateway timeout or server error after dispatch does not prove nothing was written.
    uncertain: response.status >= 500,
  };
}

const requestBody = (request: MigrationRequest) => ({
  content: JSON.stringify(request.output),
  ...(request.operations?.length ? { operations: request.operations } : {}),
  ...(request.clear ? { clear: request.clear } : {}),
});

/** Data-aware preflight against the target environment. Never writes. */
export function planRemoteMigration(
  target: MigrationTarget,
  request: MigrationRequest,
) {
  return call<{ plan: RemoteMigrationPlan }>(target, "/plan", {
    method: "POST",
    body: requestBody(request),
  });
}

export interface AppliedMigration {
  updated: boolean;
  unchanged?: boolean;
  replayed?: boolean;
  commitSha?: string;
  operationId?: string;
  reconcileNeeded?: boolean;
  steps?: Record<string, { ok: boolean; error?: string }>;
}

/** Applies exactly the reviewed plan. Retrying with the same operation ID is safe. */
export function applyRemoteMigration(
  target: MigrationTarget,
  request: MigrationRequest & {
    planDigest: string;
    operationId: string;
    /** The owner reviewed and approved the plan's content warnings. */
    acceptWarnings?: boolean;
  },
) {
  return call<AppliedMigration>(target, "/apply", {
    method: "POST",
    body: {
      ...requestBody(request),
      planDigest: request.planDigest,
      operationId: request.operationId,
      ...(request.acceptWarnings ? { acceptWarnings: true } : {}),
    },
  });
}

export interface MigrationStatus {
  status: "committed" | "not-found";
  operationId: string;
  commitSha?: string;
  planDigest?: string;
  committedAt?: string;
}

export function getRemoteMigrationStatus(
  target: MigrationTarget,
  operationId: string,
) {
  return call<MigrationStatus>(
    target,
    `/operations/${encodeURIComponent(operationId)}`,
    { method: "GET" },
  );
}

/** Re-runs post-commit work (projection, form layouts) for a committed migration. */
export function reconcileRemoteMigration(
  target: MigrationTarget,
  operationId: string,
  request: MigrationRequest,
) {
  return call<AppliedMigration & { status: string }>(
    target,
    `/operations/${encodeURIComponent(operationId)}/reconcile`,
    { method: "POST", body: requestBody(request) },
  );
}
