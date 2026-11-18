import { segmentSchema } from "../locales";
import { z } from "zod";
import { draftDiffSchema, memberSchema, namedSessionSchema, previewSchema, stageConflictSchema } from "../sessions";
import { workStates } from "../workingCopy";
import { pullSummarySchema } from "./content";

const ref = z.string();
const dryRun = z.boolean();
const sessionId = z.string();
const warning = z.object({ code: z.string(), message: z.string() });
const item = z.object({
  ref,
  key: z.string(),
  state: z.enum(workStates),
  base: z.object({ sha256: z.string().nullable(), fingerprint: z.string().nullable(), commit: z.string().nullable() }),
  staged: z.object({ itemRevision: z.int(), sha256: z.string(), at: z.string() }).optional(),
  newFile: z.string().optional(),
});
const link = z.object({ sessionId, createdAt: z.string() });
const edit = z.object({ ref, file: z.string(), dryRun, changed: z.boolean() });
const space = z.object({ space: z.string(), dryRun });
const entry = edit.extend({ entryId: z.string(), warnings: z.array(warning) });
const issue = warning.extend({ ref, pointer: z.string(), severity: z.enum(["hard", "overridable"]) });
const stageAction = z.object({ sessionId, dryRun, session: namedSessionSchema.optional() });
export const pushResultSchema = z.object({
  dryRun,
  operationId: z.string().optional(),
  stepId: z.string().optional(),
  session: namedSessionSchema.optional(),
  items: z.array(z.object({ ref, type: z.string() })),
  staged: z.int(),
  batches: z.int(),
  issues: z.array(issue),
  warnings: z.array(warning),
  outdatedTranslations: z.array(z.object({ ref, locales: z.array(z.string()) })).optional(),
});
export type PushResult = z.infer<typeof pushResultSchema>;

export const contentPullResultSchema = z.union([
  pullSummarySchema,
  z.object({ mode: z.literal("session"), dryRun, sessionId, items: z.array(ref) }),
  z.object({ mode: z.literal("dry-run"), projectId: z.string(), full: z.boolean(), media: z.boolean() }),
]);

const outdated = z.array(z.object({ ref, locales: z.array(z.string()) }));
const merge = z.object({ dryRun, space: z.string(), updated: z.array(ref), conflicts: z.array(z.object({
  ref, pointer: z.string(), base: z.unknown(), ours: z.unknown(), theirs: z.unknown(),
})) });

export const draftOutputSchemas = {
  "content save": edit,
  "locales export": z.object({ locale: z.string(), segments: z.array(segmentSchema), output: z.string().optional(), dryRun }),
  "locales import": z.object({ locale: z.string(), count: z.int(), outdated: z.array(z.object({ ref, pointer: z.string() })), dryRun }),
  "content refresh": merge,
  "content resolve": merge,
  "assets put": edit,
  "files put": edit,
  "stage conflicts": stageConflictSchema,
  "space create": space,
  "space use": space,
  "space rm": space,
  "space gc": z.object({ dryRun, objects: z.int(), bytes: z.int() }),
  "space ls": z.object({
    active: z.string(),
    spaces: z.array(
      z.object({
        name: z.string(),
        active: z.boolean(),
        counts: z.record(z.string(), z.int()),
        session: link.nullable(),
        reviewState: z.string().optional(),
        expiresAt: z.string().optional(),
        removable: z.boolean(),
      }),
    ),
    overlaps: z.array(z.object({ key: z.string(), spaces: z.array(z.string()) })),
  }),
  "content edit": edit,
  "content rm": edit,
  "content set": edit,
  "content patch": edit,
  "content status": z.object({ space: z.string(), items: z.array(item) }),
  "content diff": z.object({
    items: z.array(item.extend({ before: z.unknown().optional(), after: z.unknown().optional() })),
  }),
  "content grep": z.object({ matches: z.array(z.object({ ref, pointer: z.string(), text: z.string() })) }),
  "content validate": z.object({ items: z.int(), issues: z.array(issue), warnings: z.array(warning) }),
  "entries create": entry,
  "entries update": entry,
  "entries delete": entry,
  "entries move": edit,
  "stage push": pushResultSchema,
  "stage status": z.object({
    space: z.string(),
    session: namedSessionSchema.optional(),
    link: link.nullable(),
    operationId: z.string().optional(),
    items: z.array(item),
    outdatedTranslations: outdated,
  }),
  "stage ls": z.object({ sessions: z.array(namedSessionSchema) }),
  "stage diff": draftDiffSchema,
  "stage undo": stageAction.extend({ stepId: z.string().optional(), restoredItemKeys: z.array(z.string()).optional() }),
  "stage discard": stageAction.extend({ discarded: z.boolean() }),
  "stage preview": previewSchema,
  "stage extend": stageAction.extend({ ttlSeconds: z.int() }),
  "stage review": stageAction.extend({ reviewer: memberSchema }),
  "members ls": z.object({ members: z.array(memberSchema) }),
  init: z.object({ file: z.string(), changed: z.boolean(), dryRun }),
};
