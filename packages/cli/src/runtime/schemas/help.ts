import { z } from "zod";
import {
  assetDownloadSchema,
  doctorResultSchema,
  outputEnvelope,
  schemaShowSchema,
  useResultSchema,
  whoamiResultSchema,
  cliErrorEnvelopeSchema,
} from "./commands";
import {
  contentMapSchema,
  entryListOutputSchema,
  localeStatusSchema,
  readOutputSchema,
} from "./content";
import { contentPullResultSchema, draftOutputSchemas } from "./drafts";
import { hostingStatusSchema, hostingDeploySchema, hostingLogRecordSchema, hostingPromoteSchema, hostingReleasesSchema } from "../hosting";
import { keyCreateSchema, keyRevokeSchema, keysListSchema } from "../keys";
import { domainListSchema, domainRemoveSchema, domainResultSchema } from "../domains";
import { organizationListSchema, projectCreateSchema, projectListSchema, projectShowSchema, projectUseSchema } from "../projects";
import { statusResultSchema } from "../status";
import { loginResultSchema, logoutResultSchema } from "../login";
import { stageCommitResultSchema } from "../publish";
import {
  submissionExportSchema, submissionFileSchema, submissionListSchema, submissionShowSchema, submissionStatsSchema, submissionUpdateSchema,
} from "../submissions";
import {
  analyticsResultSchema, analyticsSettingsSchema, eventsResultSchema, linkListSchema, linkRemoveSchema, linkResultSchema,
} from "../analytics";
import {
  previewActionSchema, previewGitSchema, previewLogRecordSchema, previewStatusSchema, previewUrlSchema, shareLinkSchema,
} from "../previewServers";

const description = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
  arguments: z.array(z.object({
    name: z.string(),
    required: z.boolean(),
    variadic: z.boolean(),
    description: z.string(),
  })),
  options: z.array(z.object({
    flags: z.string(),
    description: z.string(),
    default: z.unknown().optional(),
    choices: z.array(z.string()).optional(),
    required: z.boolean(),
  })),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type CommandDescription = z.infer<typeof description> & { commands: CommandDescription[] };
const commandDescription = description.extend({
  commands: z.array(z.lazy((): z.ZodType<CommandDescription> => commandDescription)),
});

export const helpResultSchema = commandDescription.extend({
  exitCodes: z.record(z.string(), z.int()),
  output: z.string(),
});
export type HelpResult = z.infer<typeof helpResultSchema>;

const outputs = new Map<string, z.ZodType>([
  ["use", outputEnvelope(useResultSchema)],
  ["whoami", outputEnvelope(whoamiResultSchema)],
  ["login", outputEnvelope(loginResultSchema)],
  ["logout", outputEnvelope(logoutResultSchema)],
  ["stage commit", outputEnvelope(stageCommitResultSchema)],
  ["hosting status", outputEnvelope(hostingStatusSchema)],
  ["hosting deploy", outputEnvelope(hostingDeploySchema)],
  ["hosting releases ls", outputEnvelope(hostingReleasesSchema)],
  ["hosting promote", outputEnvelope(hostingPromoteSchema)],
  ["hosting logs", z.union([hostingLogRecordSchema, cliErrorEnvelopeSchema])],
  ["projects ls", outputEnvelope(projectListSchema)],
  ["projects show", outputEnvelope(projectShowSchema)],
  ["projects use", outputEnvelope(projectUseSchema)],
  ["projects create", outputEnvelope(projectCreateSchema)],
  ["orgs ls", outputEnvelope(organizationListSchema)],
  ["status", outputEnvelope(statusResultSchema)],
  ["domains ls", outputEnvelope(domainListSchema)],
  ["domains show", outputEnvelope(domainResultSchema)],
  ["domains add", outputEnvelope(z.union([
    domainResultSchema.extend({ dryRun: z.literal(false), unchanged: z.boolean() }),
    z.object({ dryRun: z.literal(true), unchanged: z.boolean(), hostname: z.string(), deployment: z.object({ id: z.string(), name: z.string() }).nullable() }),
  ]))],
  ["domains edit", outputEnvelope(z.union([
    domainResultSchema.extend({ dryRun: z.literal(false), changes: z.record(z.string(), z.unknown()) }),
    z.object({ dryRun: z.literal(true), id: z.string(), hostname: z.string(), changes: z.record(z.string(), z.unknown()) }),
  ]))],
  ["domains check", outputEnvelope(domainResultSchema)],
  ["domains rm", outputEnvelope(domainRemoveSchema)],
  ["keys ls", outputEnvelope(keysListSchema)],
  ["keys create", outputEnvelope(keyCreateSchema)],
  ["keys revoke", outputEnvelope(keyRevokeSchema)],
  ["doctor", outputEnvelope(doctorResultSchema)],
  ["schema show", outputEnvelope(schemaShowSchema)],
  ["content ls", outputEnvelope(contentMapSchema)],
  ["content get", outputEnvelope(readOutputSchema)],
  ["content pull", outputEnvelope(contentPullResultSchema)],
  ["entries ls", outputEnvelope(entryListOutputSchema)],
  ["entries get", outputEnvelope(readOutputSchema)],
  ["assets get", outputEnvelope(assetDownloadSchema)],
  ["locales status", outputEnvelope(localeStatusSchema)],
  ["help", outputEnvelope(helpResultSchema)],
  // The older commands print server responses directly, preserving extra fields.
  ["generate", z.json()],
  ["migrate", z.looseObject({ status: z.string() })],
  ["migrate-status", z.looseObject({ status: z.string() })],
  ["submissions tail", z.looseObject({ type: z.string(), event: z.looseObject({ seq: z.number() }) })],
  // CliEverywherePlan Phase 2: daily work.
  ["submissions ls", outputEnvelope(submissionListSchema)],
  ["submissions show", outputEnvelope(submissionShowSchema)],
  ["submissions files", outputEnvelope(submissionFileSchema)],
  ["submissions stats", outputEnvelope(submissionStatsSchema)],
  ["submissions export", outputEnvelope(submissionExportSchema)],
  ["submissions update", outputEnvelope(submissionUpdateSchema)],
  ["analytics overview", outputEnvelope(analyticsResultSchema)],
  ["analytics pages", outputEnvelope(analyticsResultSchema)],
  ["analytics breakdown", outputEnvelope(analyticsResultSchema)],
  ["analytics reports", outputEnvelope(analyticsResultSchema)],
  ["analytics search", outputEnvelope(analyticsResultSchema)],
  ["analytics events", outputEnvelope(eventsResultSchema)],
  ["analytics settings", outputEnvelope(analyticsSettingsSchema)],
  ["links ls", outputEnvelope(linkListSchema)],
  ["links show", outputEnvelope(linkResultSchema.omit({ unchanged: true, dryRun: true }).extend({ detail: z.unknown() }))],
  ["links create", outputEnvelope(linkResultSchema)],
  ["links edit", outputEnvelope(linkResultSchema)],
  ["links duplicate", outputEnvelope(linkResultSchema)],
  ["links rm", outputEnvelope(linkRemoveSchema)],
  ["preview status", outputEnvelope(previewStatusSchema)],
  ["preview logs", z.union([previewLogRecordSchema, cliErrorEnvelopeSchema])],
  ["preview start", outputEnvelope(previewActionSchema)],
  ["preview stop", outputEnvelope(previewActionSchema)],
  ["preview restart", outputEnvelope(previewActionSchema)],
  ["preview url", outputEnvelope(previewUrlSchema)],
  ["preview branch", outputEnvelope(previewGitSchema)],
  ["preview pull", outputEnvelope(previewGitSchema)],
  ["hosting previews share", outputEnvelope(shareLinkSchema)],
  ["hosting previews open", outputEnvelope(z.object({ website: z.object({ id: z.string(), name: z.string() }), url: z.string() }))],
  ["hosting previews links revoke", outputEnvelope(z.object({ id: z.string(), revoked: z.boolean() }))],
]);
for (const [command, schema] of Object.entries(draftOutputSchemas)) outputs.set(command, outputEnvelope(schema));

export function outputSchemaFor(command: string): z.ZodType | undefined {
  return outputs.get(command);
}
