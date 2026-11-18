import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApiClient } from "./api";
import { CliError, EXIT } from "./errors";
import { assertProject, requireLink, sessionIdSchema } from "./sessions";
import { readSpace, withSpace } from "./spaces";
import type { WorkingCopy } from "./workingCopy";

const issueSchema = z.looseObject({ code: z.string().optional(), message: z.string().optional() });
const inspectionSchema = z.object({
  ready: z.boolean(),
  headSha: z.string(),
  sessionRevision: z.int(),
  conflictCount: z.int(),
  problems: z.array(issueSchema),
  warnings: z.array(issueSchema).optional(),
});
const receiptSchema = z.object({
  committed: z.literal(true),
  receipt: z.object({ operationId: z.string(), commitSha: z.string(), projected: z.boolean() }),
  remainingItemCount: z.int().nonnegative(),
});
const journalSchema = z.object({
  sessionId: sessionIdSchema,
  message: z.string(),
  operationId: z.string(),
  pushOperationId: z.string().optional(),
  warningConsentToken: z.string().optional(),
  completed: z.boolean(),
});
const warningSchema = z.object({
  problems: z.array(z.object({ type: z.string(), consentToken: z.string().optional(), issues: z.array(issueSchema).optional() })),
});

export const stageCommitResultSchema = z.discriminatedUnion("dryRun", [
  z.object({ dryRun: z.literal(true), sessionId: sessionIdSchema, inspection: inspectionSchema }),
  z.object({
    dryRun: z.literal(false), sessionId: sessionIdSchema, operationId: z.string(), commitSha: z.string(),
    projection: z.enum(["projected", "pending"]), remainingItemCount: z.int().nonnegative(),
  }),
]);

function readJournal(file: string) {
  try {
    return journalSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError("publish_journal_invalid", "Could not read the pending publish record in this space.");
  }
}

function needsConsent(operationId: string, issues: z.infer<typeof issueSchema>[] = []) {
  return new CliError("needs_confirmation", "Publication has content warnings that require a person to review.", {
    exitCode: EXIT.confirmation, details: { operationId, issues },
    fix: "Review the warnings, then repeat 'atmyapp stage commit' with --accept-warnings in a terminal.",
  });
}

export async function stageCommit(
  api: ApiClient,
  work: WorkingCopy,
  options: {
    message: string; dryRun?: boolean; acceptWarnings?: boolean; terminal?: boolean; operationId?: string;
    confirmWarnings?: (issues: z.infer<typeof issueSchema>[]) => Promise<boolean>;
  },
): Promise<z.infer<typeof stageCommitResultSchema>> {
  const message = options.message.trim();
  if (message.length < 1 || message.length > 500) {
    throw new CliError("invalid_message", "Enter a publication message of 1–500 characters.", { exitCode: EXIT.usage });
  }
  assertProject(api, work);
  const makeScope = (sessionId: string) => ({ kind: "named", branch: "main", sessionId });
  if (options.dryRun) {
    const sessionId = requireLink(readSpace(work.store, work.name));
    const inspection = inspectionSchema.safeParse(await api.json("POST", "staging/inspect", {
      body: { scope: makeScope(sessionId) },
    }));
    if (!inspection.success) throw new CliError("invalid_response", "The server returned an invalid publication inspection.");
    return { dryRun: true, sessionId, inspection: inspection.data };
  }
  if (options.operationId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(options.operationId)) {
    throw new CliError("invalid_operation_id", "Choose an operation ID containing only letters, numbers, hyphens, or underscores.", { exitCode: EXIT.usage });
  }
  return withSpace(work.store, work.name, async (space) => {
    const sessionId = requireLink(space);
    const file = path.join(work.store.spaceDir(work.name), ".publish.json");
    const previous = readJournal(file);
    const matchesDraft = previous?.sessionId === sessionId;
    const matchesMessage = previous?.message === message && (!options.operationId || options.operationId === previous.operationId);
    if (matchesDraft && !previous.completed && !matchesMessage) {
      throw new CliError("publish_pending", "A publish attempt is pending for this draft.", {
        details: { operationId: previous.operationId },
        fix: "Repeat the original command with the same message to recover its result.",
      });
    }
    const journal = matchesDraft && matchesMessage && (!previous.completed || previous.pushOperationId === space.lastPushOperationId)
      ? previous : {
        sessionId, message, operationId: options.operationId ?? randomUUID(),
        pushOperationId: space.lastPushOperationId, completed: false,
      };
    const canAccept = options.acceptWarnings && options.terminal && options.confirmWarnings;
    if (journal.warningConsentToken && !journal.completed && !canAccept) throw needsConsent(journal.operationId);
    const persist = () => work.store.writeJson(file, journal, false);
    const commit = async () => {
      const result = receiptSchema.safeParse(await api.json("POST", "staging/commit", {
        body: {
          scope: makeScope(sessionId), message, operationId: journal.operationId,
          warningConsentToken: canAccept ? journal.warningConsentToken : undefined,
        },
      }));
      if (!result.success || result.data.receipt.operationId !== journal.operationId) {
        throw new CliError("invalid_response", "The server returned an invalid publication receipt.");
      }
      return result.data;
    };
    persist();
    try {
      let result: z.infer<typeof receiptSchema>;
      try {
        result = await commit();
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "publication-warnings") throw error;
        const parsed = warningSchema.safeParse(error.details);
        const warnings = parsed.success ? parsed.data.problems.find((problem) => problem.type === "warning") : undefined;
        if (!canAccept || !warnings?.consentToken || journal.warningConsentToken || !await canAccept(warnings.issues ?? [])) {
          if (journal.warningConsentToken) {
            // The server produced a new warning after the accepted candidate moved.
            fs.rmSync(file, { force: true });
          }
          throw needsConsent(journal.operationId, warnings?.issues);
        }
        journal.warningConsentToken = warnings.consentToken;
        persist();
        result = await commit().catch((retryError: unknown) => {
          if (!(retryError instanceof CliError) || retryError.code !== "publication-warnings") throw retryError;
          fs.rmSync(file, { force: true });
          const updated = warningSchema.safeParse(retryError.details);
          throw needsConsent(journal.operationId, updated.success ? updated.data.problems.find((problem) => problem.type === "warning")?.issues : []);
        });
      }
      journal.completed = true;
      delete journal.warningConsentToken;
      persist();
      return {
        dryRun: false, sessionId, operationId: journal.operationId, commitSha: result.receipt.commitSha,
        projection: result.receipt.projected ? "projected" : "pending", remainingItemCount: result.remainingItemCount,
      };
    } catch (error) {
      if (error instanceof CliError && (["hard-validation-failure", "commit-conflict", "stale-resolutions-token"].includes(error.code) ||
          (error.code === "missing_scope" && !matchesDraft))) {
        if (!journal.completed) fs.rmSync(file, { force: true });
      }
      throw error;
    }
  });
}
