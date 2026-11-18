import { isTextual } from "./content";
import { saveUpload, type UploadProgress } from "./uploads";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApiClient } from "./api";
import {
  assertDraftValid,
  compileDraft,
  serverItemKey,
  stageBatches,
  type CompiledItem,
  type DraftIssue,
  type StagedOperation,
} from "./compile";
import { CliError, EXIT } from "./errors";
import { formatRef } from "./refs";
import { contentFingerprint, sha256Hex } from "./fingerprint";
import { readSpace, spaceNames, withSpace, writeSpace, type SpaceFile, type SpaceRef } from "./spaces";
import {
  itemKey,
  recordWorkItem,
  reserveNewEntryId,
  selectWorkItems,
  WorkingCopy,
  workSummary,
} from "./workingCopy";
import type { ContentStore } from "./store";

export const sessionIdSchema = z.string().regex(/^ns_[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
export const reviewStateSchema = z.enum(["open", "in_review", "sent_back"]);
const stageItemSchema = z.object({
  itemKey: z.string(),
  itemRevision: z.int().nonnegative(),
  identity: z.object({
    kind: z.string(),
    path: z.string().optional(),
    collectionName: z.string().optional(),
    entryId: z.string().optional(),
    locale: z.string().optional(),
  }),
  operation: z.object({ translationSources: z.record(z.string(), z.string()).optional() }).optional(),
  desired: z.object({
    type: z.enum(["upsert", "delete"]),
    data: z.unknown().optional(),
    value: z.object({ mimeType: z.string().optional(), encoding: z.string().optional() }).optional(),
  }),
});
export const namedSessionSchema = z.object({
  sessionId: sessionIdSchema,
  name: z.string(),
  status: z.enum(["active", "committed", "discarded", "expired", "cleaning"]),
  owner: z.object({
    kind: z.enum(["key", "user"]),
    userId: z.string(),
    displayName: z.string(),
    keyId: z.string().optional(),
  }),
  reviewState: reviewStateSchema,
  itemCount: z.int().nonnegative(),
  reviewer: z.object({ userId: z.string(), name: z.string() }).optional(),
  reviewMessage: z.string().optional(),
  reviewRequestedAt: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  sessionRevision: z.int().nonnegative(),
  items: z.array(stageItemSchema).optional(),
});
export type NamedSession = z.infer<typeof namedSessionSchema>;
type DraftItem = z.infer<typeof stageItemSchema>;
export const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  roles: z.array(z.string()),
  via: z.enum(["member", "partner"]),
});
export const draftDiffSchema = z.object({
  items: z.array(
    z.object({
      itemKey: z.string(),
      change: z.enum(["added", "modified", "deleted"]),
      fields: z.array(z.looseObject({ key: z.string(), label: z.string(), change: z.string() })),
    }),
  ),
});
export const previewSchema = z.object({ url: z.string().url(), mode: z.string() });
const receiptSchema = z.object({
  sessionRevision: z.int(),
  items: z.array(
    z.object({
      itemKey: z.string(),
      itemRevision: z.int().nonnegative(),
    }),
  ),
});
const operationStatusSchema = z.object({
  state: z.enum(["queued", "preparing", "storing", "retry_wait", "paused", "blocked", "saved", "cancelled"]),
  receipt: receiptSchema.optional(),
  pollAfterMs: z.number(),
  lastFailure: z.object({ code: z.string(), message: z.string() }).optional(),
});
type OperationStatus = z.infer<typeof operationStatusSchema>;

export function response<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new CliError("invalid_response", "The server returned an unexpected draft response.");
  return result.data;
}

const route = (id?: string) => "staging/named" + (id ? "/" + encodeURIComponent(id) : "");
const scope = (id: string) => ({ kind: "named" as const, branch: "main" as const, sessionId: id });

export function assertProject(api: ApiClient, work: WorkingCopy) {
  if (api.session.projectId !== work.manifest.projectId ||
      (work.manifest.projectBase && work.manifest.projectBase !== api.projectBase))
    throw new CliError("project_mismatch", "This working copy belongs to another project.", { exitCode: EXIT.auth });
}

export function parseTtl(value: string) {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(value.trim());
  const factors = { s: 1, m: 60, h: 3600, d: 86400 } as const;
  const seconds = match ? Number(match[1]) * factors[(match[2]?.toLowerCase() ?? "s") as keyof typeof factors] : 0;
  if (!Number.isSafeInteger(seconds) || seconds < 3600 || seconds > 7 * 86400)
    throw new CliError("invalid_ttl", "TTL must be between 1h and 7d, such as 24h or 3d.", { exitCode: EXIT.usage });
  return seconds;
}

export async function getNamedSession(api: ApiClient, id: string): Promise<NamedSession> {
  return response(namedSessionSchema, await api.json("GET", route(id)));
}

export async function listNamedSessions(
  api: ApiClient,
  options: { state?: z.infer<typeof reviewStateSchema>; mine?: boolean } = {},
) {
  return response(
    z.array(namedSessionSchema),
    await api.json("GET", route(), {
      query: { state: options.state, mine: options.mine ? "1" : undefined },
    }),
  );
}

export async function listMembers(api: ApiClient, capability?: string) {
  return response(z.array(memberSchema), await api.json("GET", "members", { query: { capability } }));
}

function requireLink(space: SpaceFile): string {
  if (!space.session)
    throw new CliError("session_required", "This space has no named draft yet.", {
      exitCode: EXIT.session,
      fix: "Run 'atmyapp stage push'.",
    });
  return space.session.sessionId;
}

const sessionError = (code: string, message: string) =>
  new CliError(code, message, {
    exitCode: EXIT.session,
    fix: "Check 'atmyapp stage status'.",
  });

function checkWritable(session: NamedSession) {
  if (session.status !== "active") throw sessionError("session_expired", "The named draft has ended.");
  if (session.reviewState === "in_review")
    throw sessionError("session_in_review", "This draft is in review. Ask the reviewer to send it back.");
}

interface PushJournal {
  operationId: string;
  stepId: string;
  sessionId: string;
  nextBatch: number;
  batches: CompiledItem[][];
  issues: DraftIssue[];
  uploads?: Record<string, UploadProgress>;
}

function journalFile(work: WorkingCopy) {
  return path.join(work.store.spaceDir(work.name), ".push.json");
}

function readJournal(work: WorkingCopy): PushJournal | undefined {
  const file = journalFile(work);
  if (!fs.existsSync(file)) return;
  try {
    const result = JSON.parse(fs.readFileSync(file, "utf8")) as PushJournal;
    if (
      !sessionIdSchema.safeParse(result.sessionId).success ||
      !result.operationId ||
      !Array.isArray(result.batches) ||
      !Number.isInteger(result.nextBatch) ||
      result.nextBatch < 0 ||
      result.nextBatch > result.batches.length
    )
      throw new Error("Invalid journal");
    return result;
  } catch {
    throw new CliError(
      "push_corrupt",
      "The pending push file could not be read. Your space files are still available.",
    );
  }
}

function writeJournal(work: WorkingCopy, journal: PushJournal) {
  work.store.writeJson(journalFile(work), journal, false);
}

function resetLink(work: WorkingCopy, space: SpaceFile) {
  space.session = null;
  for (const item of Object.values(space.items)) {
    delete item.staged;
    delete item.attachments;
    delete item.rebase;
  }
  delete space.lastPushOperationId;
  writeSpace(work.store, space);
  work.store.remove(journalFile(work));
}

const stagePath = (verb: string) => "staging/v2/" + verb;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function statusFailure(status: OperationStatus, operationId: string): CliError {
  const code = status.lastFailure?.code;
  const message = status.lastFailure?.message ?? "The draft save did not finish.";
  const details = { operationId, state: status.state, failure: status.lastFailure };
  if (code === "staged-version-conflict" || code === "staged_version_conflict" || code === "content-changed")
    return new CliError("staged_version_conflict", message, { exitCode: EXIT.conflict, details });
  if (code === "named_session_gone" || code === "named_session_not_found")
    return sessionError("session_expired", message);
  if (code === "session_in_review" || code === "session_review_changed") return sessionError(code, message);
  if (status.state === "cancelled") return sessionError("stage_cancelled", message);
  return new CliError(status.state === "paused" ? "stage_pending" : code || "stage_blocked", message, {
    exitCode: status.state === "blocked" ? EXIT.validation : EXIT.error,
    details,
    fix: `Resume with 'atmyapp stage push --operation-id ${operationId}'.`,
  });
}

async function submitBatch(
  work: WorkingCopy,
  api: ApiClient,
  journal: PushJournal,
  batch: CompiledItem[],
  index: number,
  resumed: boolean,
  waitMs = 45_000,
) {
  const draftScope = scope(journal.sessionId);
  const operationId = journal.operationId + ":" + (index + 1);
  const body = { scope: draftScope, operationId };
  let status: OperationStatus | null = null;
  if (resumed) {
    const existing = await api.json("POST", stagePath("operation-status"), { body });
    status = existing ? response(operationStatusSchema, existing) : null;
    if (status?.state === "paused") {
      status = response(operationStatusSchema, await api.json("POST", stagePath("resume-operation"), { body }));
    }
  }
  if (!status) {
    const operations = [];
    const grouped = batch.flatMap((item) => [...item.attachments ?? [], item]);
    for (const [position, item] of grouped.entries()) {
      const operation = item.operation.operation;
      if (item.upload && "value" in operation) {
        const id = `${operationId}:value:${position + 1}`;
        const upload = { ...operation.value, ...item.upload };
        const value = await saveUpload({
          api, store: work.store, scope: draftScope, operationId: id, source: upload,
          progress: journal.uploads?.[id],
          checkpoint: (progress) => {
            (journal.uploads ??= {})[id] = progress;
            writeJournal(work, journal);
          },
        });
        operations.push({ ...item.operation, operation: { ...operation, value } });
      } else operations.push(item.operation);
    }
    status = response(
      operationStatusSchema,
      await api.json("POST", stagePath("submit"), {
        body: { ...body, stepId: journal.stepId, operations },
      }),
    );
  }
  const deadline = Date.now() + waitMs;
  while (["queued", "preparing", "storing", "retry_wait"].includes(status.state) && Date.now() < deadline) {
    await delay(Math.min(5_000, Math.max(100, status.pollAfterMs)));
    status = response(operationStatusSchema, await api.json("POST", stagePath("operation-status"), { body }));
  }
  if (status.state === "saved" && status.receipt) return status.receipt;
  if (["queued", "preparing", "storing", "retry_wait"].includes(status.state))
    throw new CliError("stage_pending", "The draft save is still processing.", {
      details: { operationId: journal.operationId },
      fix: `Run 'atmyapp stage push --operation-id ${journal.operationId}'.`,
    });
  throw statusFailure(status, journal.operationId);
}

function applyReceipt(
  work: WorkingCopy,
  space: SpaceFile,
  batch: CompiledItem[],
  receipt: z.infer<typeof receiptSchema>,
) {
  const revisions = new Map(receipt.items.map((item) => [item.itemKey, item.itemRevision]));
  for (const item of batch) {
    const revision = revisions.get(item.itemKey);
    if (revision === undefined)
      throw new CliError("invalid_response", `The server did not return a revision for ${formatRef(item.ref)}.`);
    let sha256 = item.localSha;
    if (item.newFile) {
      const source = work.newEntryFilename(item.ref.name, item.newFile);
      const destination = work.filename(item.ref);
      // Preserve a change made on disk while this push was in flight.
      const current = fs.existsSync(source)
        ? work.value({ ref: item.ref, file: source, newFile: item.newFile })
        : undefined;
      if (current !== undefined) {
        const sent = (item.operation.operation as Extract<StagedOperation, { type: "upsertEntry" }>).data;
        sha256 = sha256Hex(JSON.stringify({ id: item.ref.entryId, data: sent }, null, 2) + "\n");
        work.writeValue(item.ref, current, destination);
        work.store.remove(source);
      } else if (fs.existsSync(destination)) {
        const sent = (item.operation.operation as Extract<StagedOperation, { type: "upsertEntry" }>).data;
        sha256 = sha256Hex(JSON.stringify({ id: item.ref.entryId, data: sent }, null, 2) + "\n");
      }
      delete space.items[item.key].newFile;
    }
    const saved = space.items[item.key];
    if (item.attachments?.length) {
      for (const attachment of item.attachments) {
        const revision = revisions.get(attachment.itemKey);
        if (revision === undefined) throw new CliError("invalid_response", "An attachment revision is missing.");
        (saved.attachments ??= {})[attachment.itemKey] = revision;
      }
    }
    delete saved.rebase;
    saved.staged = { itemRevision: revision, sha256, at: new Date().toISOString() };
  }
}

export interface PushOptions {
  refs?: string[];
  dryRun?: boolean;
  operationId?: string;
  ttlSeconds?: number;
  onOperation?: (operationId: string) => void;
  waitMs?: number;
}

export async function push(work: WorkingCopy, api: ApiClient | undefined, options: PushOptions = {}) {
  if (api) assertProject(api, work);
  const refs = options.refs ?? [];
  const plan = (space: SpaceFile) => {
    const changed = selectWorkItems(work, work.itemStates(space), refs).filter(
      (item) => !["published", "remote-changed", "staged"].includes(item.state),
    );
    if (changed.some((item) => item.state === "conflict"))
      throw new CliError("conflict", "Published content changed in this space.", {
        exitCode: EXIT.conflict,
        details: { items: changed.filter((item) => item.state === "conflict").map(workSummary) },
      });
    return changed;
  };
  if (options.dryRun) {
    const space = readSpace(work.store, work.name);
    const compiled = compileDraft(work, plan(space));
    assertDraftValid(compiled.issues);
    const batches = stageBatches(compiled.items);
    return {
      dryRun: true,
      items: compiled.items.map((item) => ({ ref: formatRef(item.ref), type: item.operation.operation.type })),
      staged: 0,
      batches: batches.length,
      issues: compiled.issues,
    };
  }
  if (!api) throw new CliError("not_connected", "Connect to a project to push a draft.", { exitCode: EXIT.auth });
  return withSpace(work.store, work.name, async (space) => {
    let session: NamedSession | undefined;
    let journal = readJournal(work);
    if (space.session) {
      try {
        session = await getNamedSession(api, space.session.sessionId);
        if (session.status === "committed") {
          throw sessionError(
            "session_published",
            "This draft was published. Pull the published content before pushing again.",
          );
        }
        checkWritable(session);
      } catch (error) {
        if (!(error instanceof CliError && error.code === "session_expired")) throw error;
        resetLink(work, space);
        journal = undefined;
      }
    }
    const existingJournal = !!journal;
    if (journal && options.operationId && options.operationId !== journal.operationId)
      throw new CliError("pending_push", "Another push is waiting in this space.", {
        exitCode: EXIT.conflict,
        fix: `Run 'atmyapp stage push --operation-id ${journal.operationId}'.`,
      });
    if (journal && refs.length)
      throw new CliError("pending_push", "Resume the existing push without passing new references.", {
        exitCode: EXIT.conflict,
        details: { operationId: journal.operationId },
      });
    if (!journal) {
      if (options.operationId && options.operationId === space.lastPushOperationId)
        return {
          dryRun: false,
          operationId: options.operationId,
          session,
          items: [],
          staged: 0,
          batches: 0,
          issues: [],
        };
      const changed = plan(space).map((item) => reserveNewEntryId(work, space, item));
      for (const item of changed) recordWorkItem(space, work, item.ref);
      const compiled = compileDraft(work, changed, true);
      assertDraftValid(compiled.issues);
      const batches = stageBatches(compiled.items);
      if (!batches.length) return { dryRun: false, session, items: [], staged: 0, batches: 0, issues: compiled.issues };
      const operationId = options.operationId ?? "cli-" + randomUUID();
      if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/.test(operationId))
        throw new CliError(
          "invalid_operation_id",
          "Use an operation ID of up to 120 letters, digits, dots, underscores or hyphens.",
          { exitCode: EXIT.usage },
        );
      // Establish immutable local IDs and make normalized identities visible to the website.
      for (const [index, item] of compiled.items.entries()) {
        if (!item.normalized) continue;
        const source = changed[index];
        work.writeValue(item.ref, item.normalized.value, source.file, !!item.newFile);
        item.localSha = work.localDigest(source.file, fs.readFileSync(source.file), source.placement);
        delete item.normalized;
      }
      writeSpace(work.store, space);
      session ??= response(
        namedSessionSchema,
        await api.json("POST", route(), {
          body: {
            name: work.name,
            ...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}),
          },
        }),
      );
      space.session = { sessionId: session.sessionId, createdAt: session.createdAt };
      journal = {
        sessionId: session.sessionId,
        operationId,
        stepId: "cli-" + randomUUID(),
        batches,
        nextBatch: 0,
        issues: compiled.issues,
      };
      writeSpace(work.store, space);
      writeJournal(work, journal);
    }
    options.onOperation?.(journal.operationId);
    try {
      for (let index = journal.nextBatch; index < journal.batches.length; index++) {
        const batch = journal.batches[index];
        const receipt = await submitBatch(work, api, journal, batch, index, existingJournal, options.waitMs);
        applyReceipt(work, space, batch, receipt);
        writeSpace(work.store, space);
        journal.nextBatch = index + 1;
        writeJournal(work, journal);
      }
    } catch (error) {
      if (error instanceof CliError) {
        let clear = ["stage_cancelled", "session_review_changed"].includes(error.code);
        if (error.details?.state === "blocked") {
          const cancelled = await api
            .json("POST", stagePath("cancel-operation"), {
              body: {
                scope: scope(journal.sessionId),
                operationId: journal.operationId + ":" + (journal.nextBatch + 1),
              },
            })
            .catch(() => undefined);
          clear = cancelled === null || operationStatusSchema.safeParse(cancelled).data?.state === "cancelled";
        }
        if (clear) {
          work.store.remove(journalFile(work));
          delete space.lastPushOperationId;
          writeSpace(work.store, space);
        }
        if (error.code === "staged_version_conflict") {
          const draft = await getNamedSession(api, journal.sessionId).catch(() => undefined);
          const keys = new Set(journal.batches[journal.nextBatch]?.map((item) => item.itemKey));
          throw new CliError(error.code, error.message, {
            exitCode: EXIT.conflict,
            details: {
              ...error.details,
              current: draft?.items?.filter((item) => keys.has(item.itemKey)) ?? [],
            },
            fix: "Review 'atmyapp stage diff' and reconcile the local edits before retrying.",
          });
        }
      }
      throw error;
    }
    space.lastPushOperationId = journal.operationId;
    writeSpace(work.store, space);
    work.store.remove(journalFile(work));
    const items = journal.batches
      .flat()
      .map((item) => ({ ref: formatRef(item.ref), type: item.operation.operation.type }));
    return {
      dryRun: false,
      operationId: journal.operationId,
      stepId: journal.stepId,
      session,
      items,
      staged: items.length,
      batches: journal.batches.length,
      issues: journal.issues,
    };
  });
}

export async function stageStatus(work: WorkingCopy, api?: ApiClient) {
  const space = readSpace(work.store, work.name);
  if (api) assertProject(api, work);
  const session = api && space.session ? await getNamedSession(api, space.session.sessionId) : undefined;
  return {
    space: work.name,
    session,
    link: space.session,
    operationId: readJournal(work)?.operationId ?? space.lastPushOperationId,
    items: work.itemStates(space).map(workSummary),
  };
}

export async function stageDiff(api: ApiClient, work: WorkingCopy, ref?: string) {
  assertProject(api, work);
  const id = requireLink(readSpace(work.store, work.name));
  const coordinate = ref ? work.describe(ref) : undefined;
  return response(
    draftDiffSchema,
    await api.json("POST", route(id) + "/diff", {
      body: coordinate ? { keys: [serverItemKey(coordinate)] } : {},
    }),
  );
}

export async function stagePreview(api: ApiClient, work: WorkingCopy, wait = false) {
  assertProject(api, work);
  const id = requireLink(readSpace(work.store, work.name));
  for (let attempt = 0; ; attempt++) {
    try {
      return response(previewSchema, await api.json("POST", route(id) + "/preview", { body: {} }));
    } catch (error) {
      if (!wait || attempt >= 10 || !(error instanceof CliError) || ![409, 503].includes(error.status ?? 0))
        throw error;
      await delay(1_500);
    }
  }
}

export async function extendSession(api: ApiClient, work: WorkingCopy, ttlSeconds: number, dryRun = false) {
  assertProject(api, work);
  const id = requireLink(readSpace(work.store, work.name));
  return {
    sessionId: id,
    ttlSeconds,
    dryRun,
    session: dryRun
      ? undefined
      : response(namedSessionSchema, await api.json("POST", route(id) + "/extend", { body: { ttlSeconds } })),
  };
}

export async function requestReview(api: ApiClient, work: WorkingCopy, to: string, message?: string, dryRun = false) {
  assertProject(api, work);
  const id = requireLink(readSpace(work.store, work.name));
  if (message && message.length > 2000)
    throw new CliError("invalid_message", "Keep the review message to 2,000 characters.", { exitCode: EXIT.usage });
  const [members, current] = await Promise.all([listMembers(api, "content.edit"), getNamedSession(api, id)]);
  checkWritable(current);
  const reviewers = members.filter(
    (member) => member.userId === to || member.email?.toLowerCase() === to.toLowerCase(),
  );
  if (reviewers.length !== 1)
    throw new CliError("invalid_reviewer", "Choose one project member who can edit content.", {
      exitCode: EXIT.usage,
      fix: "Run 'atmyapp members ls --can content.edit' and use their user ID.",
    });
  const reviewer = reviewers[0];
  return {
    sessionId: id,
    reviewer,
    dryRun,
    session: dryRun
      ? undefined
      : response(
          namedSessionSchema,
          await api.json("POST", route(id) + "/review", { body: { reviewerUserId: reviewer.userId, message } }),
        ),
  };
}

export async function undoStage(api: ApiClient, work: WorkingCopy, stepId?: string, dryRun = false) {
  assertProject(api, work);
  const id = requireLink(readSpace(work.store, work.name));
  if (dryRun) return { sessionId: id, stepId, dryRun };
  return withSpace(work.store, work.name, async (space) => {
    const result = response(
      z.object({ stepId: z.string(), restoredItemKeys: z.array(z.string()) }),
      await api.json("POST", "staging/undo", {
        body: { scope: scope(requireLink(space)), operationId: "undo-" + randomUUID(), stepId },
      }),
    );
    const current = await getNamedSession(api, id);
    const affected = new Set(result.restoredItemKeys);
    for (const item of Object.values(space.items)) {
      if (!item.ref) continue;
      const key = serverItemKey(item.ref);
      if (!affected.has(key)) continue;
      const remote = current.items?.find((entry) => entry.itemKey === key);
      if (!remote) delete item.staged;
      else
        item.staged = {
          itemRevision: remote.itemRevision,
          sha256: sha256Hex("undo:" + remote.itemKey + ":" + remote.itemRevision),
          at: new Date().toISOString(),
        };
    }
    writeSpace(work.store, space);
    return { sessionId: id, ...result, dryRun };
  });
}

export async function discardStage(api: ApiClient, work: WorkingCopy, dryRun = false) {
  assertProject(api, work);
  const id = requireLink(readSpace(work.store, work.name));
  if (dryRun) return { sessionId: id, discarded: false, dryRun };
  return withSpace(work.store, work.name, async (space) => {
    await api.json("POST", route(requireLink(space)) + "/discard", { body: {} });
    resetLink(work, space);
    return { sessionId: id, discarded: true, dryRun };
  });
}

function editableRef(work: WorkingCopy, item: DraftItem): SpaceRef | undefined {
  const { identity } = item;
  if (identity.kind === "entry" && identity.entryId && identity.collectionName)
    return { kind: "entry", name: identity.collectionName, entryId: identity.entryId, locale: identity.locale };
  if (identity.kind === "publicAsset" && identity.path) return { kind: "public", name: identity.path };
  if ((identity.kind === "document" || identity.kind === "file") && identity.path)
    return work.fileRef(identity.path, identity.locale);
}

export async function pullSession(api: ApiClient, work: WorkingCopy, dryRun = false) {
  assertProject(api, work);
  const action = async (space: SpaceFile) => {
    const journal = readJournal(work);
    if (journal)
      throw new CliError("pending_push", "Finish the pending push before pulling reviewer edits.", {
        exitCode: EXIT.conflict,
        fix: `Run 'atmyapp stage push --operation-id ${journal.operationId}'.`,
      });
    const draft = await getNamedSession(api, requireLink(space));
    if (draft.status !== "active")
      throw sessionError("session_expired", "This draft has ended. Pull the published copy.");
    if (!draft.items) throw new CliError("invalid_response", "The server did not return the draft items.");
    const local = new Map(work.itemStates(space).map((item) => [item.key, item]));
    const remoteKeys = new Set<string>();
    const results = [];
    for (const item of draft.items) {
      const ref = editableRef(work, item);
      if (!ref) continue;
      const key = itemKey(ref);
      remoteKeys.add(key);
      const current = local.get(key);
      if (current?.staged?.itemRevision === item.itemRevision) continue;
      if (current?.sha256 && current.state !== "published" && current.sha256 !== current.staged?.sha256)
        throw new CliError("conflict", `Local edits to ${formatRef(ref)} would be overwritten.`, {
          exitCode: EXIT.conflict,
        });
      let value = item.desired.data;
      if (item.desired.type === "upsert" && item.desired.value) {
        const bytes = await api.bytes("staging/read", {
          body: {
            scope: scope(draft.sessionId),
            itemKey: item.itemKey,
            itemRevision: item.itemRevision,
            representation: "value",
          },
        });
        if (!bytes) throw new CliError("invalid_response", `Missing draft value for ${formatRef(ref)}.`);
        const raw = Buffer.from(bytes.bytes);
        const mime = item.desired.value.mimeType ?? work.mime(ref);
        if (ref.kind === "public" || !ref.locale && item.desired.value.encoding !== "utf-8" && !isTextual(mime, ref.name)) value = raw;
        else {
          const text = raw.toString("utf8");
          value = /json/i.test(mime) ? JSON.parse(text) : text;
        }
      }
      results.push({ ref, item, value });
    }
    if (!dryRun) {
      const latest = new Map(work.itemStates(space).map((item) => [item.key, item]));
      for (const { ref } of results) {
        const key = itemKey(ref);
        if (latest.get(key)?.sha256 !== local.get(key)?.sha256)
          throw new CliError("conflict", `Local edits to ${formatRef(ref)} changed during the pull.`, {
            exitCode: EXIT.conflict,
          });
      }
      for (const { ref, item, value } of results) {
        const key = itemKey(ref);
        const entry = recordWorkItem(space, work, ref);
        delete entry.placement;
        let sha256;
        if (item.desired.type === "delete") {
          if (!space.deletions.includes(key)) space.deletions.push(key);
          work.store.remove(work.filename(ref));
          sha256 = sha256Hex("deleted");
        } else {
          space.deletions = space.deletions.filter((deleted) => deleted !== key);
          sha256 = work.writeValue(ref, value);
          if (ref.locale && item.operation?.translationSources) {
            const variant = work.variant(ref)!;
            sha256 = work.store.writeJson(work.filename(ref), { ...variant, sourceHashes: item.operation.translationSources }, false);
          }
        }
        entry.staged = { itemRevision: item.itemRevision, sha256, at: new Date().toISOString() };
      }
      for (const [key, entry] of Object.entries(space.items)) {
        if (!entry.staged || remoteKeys.has(key)) continue;
        const current = latest.get(key);
        if (current && current.sha256 === entry.staged.sha256) {
          work.store.remove(current.file);
          space.deletions = space.deletions.filter((deleted) => deleted !== key);
          delete space.items[key];
        } else {
          delete entry.staged;
        }
      }
      writeSpace(work.store, space);
    }
    return { dryRun, sessionId: draft.sessionId, items: results.map(({ ref }) => formatRef(ref)) };
  };
  return dryRun ? action(readSpace(work.store, work.name)) : withSpace(work.store, work.name, action);
}

/** Drop fully published copies while preserving edits made since their stage receipt. */
export async function reconcilePublishedSpaces(api: ApiClient, store: ContentStore) {
  for (const name of spaceNames(store)) {
    const loaded = readSpace(store, name);
    if (!loaded.session) continue;
    await withSpace(store, name, async (space) => {
      const work = new WorkingCopy(store, name);
      assertProject(api, work);
      if (!space.session) return;
      let published = false;
      try {
        const draft = await getNamedSession(api, space.session.sessionId);
        if (draft.status === "active") return;
        published = draft.status === "committed";
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        if (["missing_scope", "forbidden", "network", "server_error"].includes(error.code)) return;
        if (!["session_expired", "not_found"].includes(error.code)) throw error;
      }
      let changed = false;
      for (const item of work.itemStates(space)) {
        if (!item.staged || item.sha256 !== item.staged.sha256) continue;
        const converged = published || (item.deleted
          ? item.published.fingerprint === null
          : !item.placement &&
            !item.ref.locale &&
            contentFingerprint(item.ref.kind === "entry" ? "entry" : "file", work.value(item)) ===
              item.published.fingerprint);
        if (!converged) continue;
        work.store.remove(item.file);
        space.deletions = space.deletions.filter((key) => key !== item.key);
        delete space.items[item.key];
        changed = true;
      }
      if (published) resetLink(work, space);
      else if (changed) writeSpace(store, space);
    });
  }
}

export const stageConflictSchema = z.object({
  problems: z.array(z.looseObject({ type: z.string(), kind: z.string().optional(), itemKey: z.string().optional() })),
  headSha: z.string().nullable().optional(),
  sessionRevision: z.int(),
});

export async function stageConflicts(api: ApiClient, work: WorkingCopy) {
  assertProject(api, work);
  const id = requireLink(readSpace(work.store, work.name));
  return response(stageConflictSchema, await api.json("POST", "staging/conflicts", {
    body: { scope: scope(id), operationId: "inspect-" + randomUUID(), message: "Inspect named draft conflicts" },
  }));
}
