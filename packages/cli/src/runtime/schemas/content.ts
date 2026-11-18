import { z } from "zod";

export const contentViewSchema = z.enum(["stored", "delivered", "overlay", "effective"]);
export type ContentView = z.infer<typeof contentViewSchema>;

const nullableText = z.string().nullable();
const count = z.int().nonnegative();
const object = z.record(z.string(), z.unknown());

const readMetadata = z.object({
  ref: z.string(),
  kind: z.enum(["document", "file", "entry"]),
  path: z.string().optional(),
  definition: nullableText,
  locale: nullableText,
  mimeType: z.string(),
  fingerprint: z.string(),
  commitSha: nullableText,
  variant: z.object({
    mode: z.string(),
    status: z.string(),
    sourceHashes: z.record(z.string(), z.string()),
  }).optional(),
});

export const readResultSchema = readMetadata.extend({ view: contentViewSchema, value: z.unknown() });
export type ReadResult = z.infer<typeof readResultSchema>;

const valueFields = {
  full: z.object({ view: z.literal("full"), value: z.unknown() }),
  part: z.object({ view: z.literal("part"), pointer: z.string(), value: z.unknown() }),
  outline: z.object({
    view: z.literal("outline"),
    pointer: z.string(),
    size: count,
    outline: z.object({
      rows: z.array(z.object({ pointer: z.string(), summary: z.string(), label: z.string().optional() })),
      truncated: z.boolean(),
    }),
    note: z.string(),
  }),
};
export const valueViewSchema = z.discriminatedUnion("view", [valueFields.full, valueFields.part, valueFields.outline]);
export type ValueView = z.infer<typeof valueViewSchema>;
export type Outline = z.infer<typeof valueFields.outline>["outline"];
export type OutlineRow = Outline["rows"][number];

export const readOutputSchema = z.discriminatedUnion("view", [
  readMetadata.extend(valueFields.full.shape),
  readMetadata.extend(valueFields.part.shape),
  readMetadata.extend(valueFields.outline.shape),
]);
export type ReadOutput = z.infer<typeof readOutputSchema>;

export const rawEntrySchema = z.object({
  id: z.string(),
  data: object,
  created: z.string().optional(),
  updated: z.string().optional(),
});
export type RawEntry = z.infer<typeof rawEntrySchema>;

export const entryPageSchema = z.object({
  entries: z.array(rawEntrySchema),
  total: count,
  nextCursor: nullableText,
});
export type EntryPage = z.infer<typeof entryPageSchema>;

export const entryListOutputSchema = entryPageSchema.extend({
  collection: z.string(),
  view: contentViewSchema,
  locale: nullableText,
  entries: z.array(z.object({
    id: z.string(),
    createdAt: nullableText.optional(),
    updatedAt: nullableText.optional(),
    data: object,
  })),
});
export type EntryListOutput = z.infer<typeof entryListOutputSchema>;

export const localizationSchema = z.object({ defaultLocale: z.string(), supportedLocales: z.array(z.string()) });
export type Localization = z.infer<typeof localizationSchema>;

export const contentMapSchema = z.object({
  items: z.array(z.object({
    ref: z.string(),
    name: z.string(),
    kind: z.string(),
    path: nullableText,
    description: nullableText,
    entries: count.optional(),
    localizedFields: z.array(z.string()),
    pages: z.array(z.string()),
    summary: nullableText,
  })),
  localization: localizationSchema.nullable(),
  pagesKnown: z.boolean(),
});
export type ContentMap = z.infer<typeof contentMapSchema>;
export type ContentMapItem = ContentMap["items"][number];

export const pullSummarySchema = z.object({
  mode: z.enum(["full", "incremental", "up-to-date"]),
  baseCommit: nullableText,
  previousCommit: nullableText,
  files: count,
  entries: count,
  translations: count,
  removed: count,
  notes: z.array(z.string()),
  dir: z.string(),
});
export type PullSummary = z.infer<typeof pullSummarySchema>;

export const localeStatusRowSchema = z.object({
  ref: z.string(),
  locale: z.string(),
  status: z.string(),
  missingPathCount: count.optional(),
  outdatedPathCount: count.optional(),
});
export type LocaleStatusRow = z.infer<typeof localeStatusRowSchema>;

export const localeStatusSchema = z.object({
  defaultLocale: z.string(),
  locales: z.array(z.string()),
  counts: z.record(z.string(), count),
  rows: z.array(localeStatusRowSchema),
  notes: z.array(z.string()),
});
export type LocaleStatus = z.infer<typeof localeStatusSchema>;
