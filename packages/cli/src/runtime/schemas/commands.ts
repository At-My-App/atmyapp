import { z } from "zod";

const nullableText = z.string().nullable();
const object = z.record(z.string(), z.unknown());

export const whoamiResultSchema = z.object({
  projectId: z.string(),
  url: z.string(),
  key: z.object({
    name: z.string(),
    hint: nullableText,
    id: nullableText,
    createdAt: nullableText,
    scopes: z.array(z.string()),
    effectiveScopes: z.array(z.string()),
    stoppedReason: nullableText,
  }),
  sources: z.record(z.string(), z.string()),
});
export type WhoamiResult = z.infer<typeof whoamiResultSchema>;

export const useResultSchema = z.object({
  projectId: z.string(),
  keyName: z.string(),
  url: z.string(),
  sessionFile: z.string(),
});
export type UseResult = z.infer<typeof useResultSchema>;

export const doctorResultSchema = z.object({
  healthy: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    status: z.enum(["ok", "warn", "fail", "skipped"]),
    message: z.string(),
    fix: z.string().optional(),
    details: object.optional(),
  })),
});
export type DoctorResult = z.infer<typeof doctorResultSchema>;
export type DoctorCheck = DoctorResult["checks"][number];
export type CheckStatus = DoctorCheck["status"];

const definitionKind = z.enum(["collection", "document", "system_config", "file", "image"]);
const definitionInfo = z.object({
  name: z.string(),
  kind: definitionKind,
  path: nullableText,
  description: nullableText,
});
export const definitionSummarySchema = definitionInfo.extend({ localizedFields: z.array(z.string()) });
export type DefinitionSummary = z.infer<typeof definitionSummarySchema>;

export const fieldRowSchema = z.object({
  pointer: z.string(),
  kind: z.string(),
  type: z.string(),
  required: z.boolean(),
  nullable: z.boolean(),
  localize: z.boolean(),
  description: nullableText,
  limits: object,
});
export type FieldRow = z.infer<typeof fieldRowSchema>;

const schemaOverview = z.object({ schemaHash: z.string() });
const schemaDefinition = schemaOverview.extend(definitionInfo.shape);
export const schemaShowSchema = z.union([
  schemaOverview.extend({ schema: z.unknown() }),
  schemaOverview.extend({ localization: z.boolean(), definitions: z.array(definitionSummarySchema) }),
  schemaDefinition.extend({ fields: z.array(fieldRowSchema) }),
  schemaDefinition.extend({ definition: z.unknown() }),
]);
export type SchemaShowResult = z.infer<typeof schemaShowSchema>;

export const assetDownloadSchema = z.object({
  ref: z.string(),
  source: z.string(),
  output: z.string(),
  size: z.int().nonnegative(),
  mimeType: z.string(),
});
export type AssetDownload = z.infer<typeof assetDownloadSchema>;

export const cliErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    fix: z.string().optional(),
    pointer: z.string().optional(),
    status: z.int().optional(),
    details: object.optional(),
  }),
});
export type CliErrorDetails = z.infer<typeof cliErrorEnvelopeSchema>["error"];

export function outputEnvelope<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data }), cliErrorEnvelopeSchema]);
}
