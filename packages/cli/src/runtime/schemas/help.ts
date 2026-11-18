import { z } from "zod";
import {
  assetDownloadSchema,
  doctorResultSchema,
  outputEnvelope,
  schemaShowSchema,
  useResultSchema,
  whoamiResultSchema,
} from "./commands";
import {
  contentMapSchema,
  entryListOutputSchema,
  localeStatusSchema,
  pullSummarySchema,
  readOutputSchema,
} from "./content";

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
  ["doctor", outputEnvelope(doctorResultSchema)],
  ["schema show", outputEnvelope(schemaShowSchema)],
  ["content ls", outputEnvelope(contentMapSchema)],
  ["content get", outputEnvelope(readOutputSchema)],
  ["content pull", outputEnvelope(pullSummarySchema)],
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
]);

export function outputSchemaFor(command: string): z.ZodType | undefined {
  return outputs.get(command);
}
