import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exportSegments, importSegments, parseStatuses } from "../../runtime/locales";
import { listNamedSessions } from "../../runtime/sessions";
import { draftOptions, workFor, type DraftOptions } from "./draftOptions";
import { jsonInput } from "./entryDrafts";
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
          const [schema, localization, drafts] = await Promise.all([
            fetchRemoteSchema(api), readLocalization(api),
            listNamedSessions(api).catch((error: unknown) => {
              if (error instanceof CliError && [403, 404].includes(error.status ?? 0)) return [];
              throw error;
            }),
          ]);
          const blocking = drafts.filter((draft) => draft.status === "active");
          const notes = blocking.length ? [
            "Finish these named drafts before enabling more languages: " + blocking.map((draft) => draft.name).join(", "),
          ] : [];
          if (!localization || !schema.localizationEnabled) {
            throw new CliError("no_localization", "This project has no languages set up.", {
              exitCode: EXIT.usage,
              details: notes.length ? { notes } : undefined,
              fix: "Enable localization in the schema, then add languages in Settings → Localization.",
            });
          }
          const locale = checkLocale(options.locale ? canonicalLocale(options.locale) : undefined, localization);
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
  return new Command("locales").description("Translations").addCommand(status)
    .addCommand(draftOptions(new Command("export"), { write: true, space: false })
      .description("Export source text, current translations and source hashes")
      .argument("[refs...]").requiredOption("--locale <locale>", "Language to translate")
      .option("--space [name]", "Read source edits and translations from the selected space")
      .option("--status <statuses>", "Only these segment statuses, comma separated")
      .option("-o, --output <file>", "Write a segment file")
      .addHelpText("after", "\nExample: atmyapp locales export doc:home --locale de --space --status outdated -o de.json")
      .action((refs: string[], options: Omit<DraftOptions, "space"> & { locale: string; space?: string | true; status?: string; output?: string }) =>
        runAction(options, async () => {
          const work = workFor({ ...options, space: typeof options.space === "string" ? options.space : undefined });
          const result = exportSegments(work, { ...options, refs, statuses: parseStatuses(options.status), space: !!options.space });
          const output = options.output && resolve(options.output);
          if (output && existsSync(output))
            throw new CliError("output_exists", "Use a different output filename.", { exitCode: EXIT.usage });
          if (output && !options.dryRun) work.store.writeJson(output, result, false);
          return { ...result, output, dryRun: !!options.dryRun };
        }, (result) => {
          if (result.output) console.log(`${result.dryRun ? "Would export" : "Exported"} ${result.segments.length} segments to ${result.output}.`);
          else console.log(JSON.stringify({ locale: result.locale, segments: result.segments }, null, 2));
        })))
    .addCommand(draftOptions(new Command("import"), { write: true })
      .description("Apply translated segments that still match their source text")
      .argument("<file>").option("--locale <locale>", "Language of an input file without locale metadata")
      .addHelpText("after", "\nExample: atmyapp locales import de.json --dry-run")
      .action((filename: string, options: DraftOptions & { locale?: string }) =>
        runAction(options, () => importSegments(workFor(options), jsonInput(filename.startsWith("@") ? filename : "@" + filename), options),
          (result) => {
            console.log(`${result.dryRun ? "Would save" : "Saved"} ${result.count} translation(s).`);
            for (const outdated of result.outdated) console.log(`Outdated ${outdated.ref}#${outdated.pointer}`);
          })));

}
