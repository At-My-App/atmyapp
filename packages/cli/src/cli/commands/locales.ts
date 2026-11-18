import chalk from "chalk";
import type { LocaleStatus } from "../../runtime/schemas/content";
import { Command } from "commander";
import {
  checkLocale,
  entryLocales,
  listEntries,
  mapLimit,
  readLocalization,
  storagePathLocales,
  type LocaleStatusRow,
} from "../../runtime/content";
import { CliError, EXIT } from "../../runtime/errors";
import { canonicalLocale, parseRef } from "../../runtime/refs";
import { fetchRemoteSchema, type RemoteSchema } from "../../runtime/schema";
import type { ApiClient } from "../../runtime/api";
import { connect, runAction, table, withCommonOptions, type CommonOptions } from "../output";

const COLLECTION_LIMIT = 500;

async function collectionRows(api: ApiClient, collection: string, locale: string | null, notes: string[]): Promise<LocaleStatusRow[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  while (ids.length < COLLECTION_LIMIT) {
    const page = await listEntries(api, collection, { limit: 50, cursor, order: "created.asc" });
    ids.push(...page.entries.map((entry) => entry.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  if (ids.length >= COLLECTION_LIMIT) notes.push(`Only the first ${COLLECTION_LIMIT} entries of ${collection} were checked.`);
  return (await mapLimit(ids, 6, (id) => entryLocales(api, collection, id, locale))).flat();
}

async function allRows(api: ApiClient, schema: RemoteSchema, locale: string | null, notes: string[]) {
  const rows: LocaleStatusRow[] = [];
  for (const summary of schema.summaries()) {
    if (!summary.localizedFields.length) continue;
    if (summary.kind === "collection") rows.push(...(await collectionRows(api, summary.name, locale, notes)));
    else if (summary.path) rows.push(...(await storagePathLocales(api, summary.path, summary.kind === "document" ? `doc:${summary.name}` : `file:${summary.path}`, locale)));
  }
  return rows;
}

export function localesCommand(): Command {
  const status = withCommonOptions(new Command("status"))
    .description("Show which translations are current, incomplete or outdated")
    .argument("[ref]", "doc:<name>, file:<path>, coll:<name> or entry:<collection>/<id> (default: everything translatable)")
    .option("--locale <locale>", "Only this language")
    .option("--only <statuses>", "Only these statuses, comma-separated (current,incomplete,outdated,missing)")
    .action((input: string | undefined, options: CommonOptions & { locale?: string; only?: string }) =>
      runAction(
        options,
        async (): Promise<LocaleStatus> => {
          const { api } = connect(options);
          const [schema, localization] = await Promise.all([fetchRemoteSchema(api), readLocalization(api)]);
          if (!localization || !schema.localizationEnabled) {
            throw new CliError("no_localization", "This project has no languages set up.", {
              exitCode: EXIT.usage,
              fix: "Enable localization in the schema, then add languages in Settings → Localization.",
            });
          }
          const locale = checkLocale(options.locale ? canonicalLocale(options.locale) : undefined, localization);
          const notes: string[] = [];
          let rows: LocaleStatusRow[];
          if (!input) rows = await allRows(api, schema, locale, notes);
          else {
            const ref = parseRef(input);
            if (ref.kind === "entry") rows = await entryLocales(api, ref.name, ref.entryId!, locale);
            else if (ref.kind === "coll") {
              schema.collection(ref.name);
              rows = await collectionRows(api, ref.name, locale, notes);
            } else if (ref.kind === "doc") {
              const document = schema.resolveDocument(ref.name);
              if (!document) throw new CliError("unknown_document", `There is no document '${ref.name}'.`, { exitCode: EXIT.usage });
              rows = await storagePathLocales(api, document.path, `doc:${document.name}`, locale);
            } else if (ref.kind === "file") rows = await storagePathLocales(api, ref.name, `file:${ref.name}`, locale);
            else throw new CliError("not_translatable", "Public assets are not translated.", { exitCode: EXIT.usage });
          }
          const only = options.only?.split(",").map((value) => value.trim()).filter(Boolean);
          if (only?.length) rows = rows.filter((row) => only.includes(row.status));
          const counts: Record<string, number> = {};
          for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
          return { defaultLocale: localization.defaultLocale, locales: localization.supportedLocales, counts, rows, notes };
        },
        (result) => {
          console.log(table(result.rows as unknown as Array<Record<string, unknown>>, ["ref", "locale", "status", "missingPathCount", "outdatedPathCount"]));
          console.log(chalk.gray(`\n${Object.entries(result.counts).map(([status, count]) => `${count} ${status}`).join(", ") || "nothing to translate"}`));
          for (const note of result.notes) console.log(chalk.yellow(note));
        },
      ),
    );
  return new Command("locales").description("Translations").addCommand(status);
}
