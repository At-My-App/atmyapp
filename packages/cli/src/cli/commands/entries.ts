import chalk from "chalk";
import { Command, Option } from "commander";
import { checkLocale, listEntries, readEntry, readLocalization, type ContentView } from "../../runtime/content";
import { CliError, EXIT } from "../../runtime/errors";
import { deliver, LocalContent, applyVariant } from "../../runtime/local";
import { canonicalLocale, resolvePointer } from "../../runtime/refs";
import { fetchRemoteSchema } from "../../runtime/schema";
import { viewValue } from "../../runtime/views";
import { connect, printValue, runAction, table, withCommonOptions, type CommonOptions } from "../output";
import { resolveView, VIEW_HELP, viewOption } from "./content";
import * as fs from "fs";

interface ListOptions extends CommonOptions {
  limit?: string;
  cursor?: string;
  order?: "created.asc" | "created.desc";
  fields?: string;
  locale?: string;
  view?: string;
  local?: boolean;
}

/** Keeps only the named top-level fields (and id). */
function pickFields(data: Record<string, unknown>, fields: string[] | null): Record<string, unknown> {
  if (!fields) return data;
  return Object.fromEntries(fields.filter((field) => field in data).map((field) => [field, data[field]]));
}

function parseFields(fields?: string): string[] | null {
  const list = fields?.split(",").map((field) => field.trim()).filter(Boolean);
  return list?.length ? list : null;
}

function lsCommand(): Command {
  return withCommonOptions(new Command("ls"))
    .description("List a collection's entries")
    .argument("<collection>", "Collection name")
    .option("--limit <n>", "Entries per page (1-50)", "20")
    .option("--cursor <cursor>", "Continue from a previous page's nextCursor")
    .addOption(new Option("--order <order>", "Sort by creation time").choices(["created.asc", "created.desc"]).default("created.desc"))
    .option("--fields <names>", "Only these top-level fields, comma-separated")
    .option("--locale <locale>", "Translated values")
    .addOption(viewOption())
    .option("--local", "List from the local copy (.ama/content)", false)
    .addHelpText("after", `\nViews:\n${VIEW_HELP}\n\nFilters (--where) are not available yet; page with --cursor.`)
    .action((collection: string, options: ListOptions) =>
      runAction(
        options,
        async () => {
          const limit = Number(options.limit ?? 20);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
            throw new CliError("invalid_limit", "--limit must be a whole number from 1 to 50.", { exitCode: EXIT.usage });
          }
          const fields = parseFields(options.fields);
          const requestedLocale = options.locale ? canonicalLocale(options.locale) : undefined;
          if (options.local) {
            const local = new LocalContent();
            local.schema.collection(collection);
            const locale = checkLocale(requestedLocale, local.manifest.localization);
            const view = resolveView(options.view, locale);
            if (view === "overlay") throw new CliError("view_unsupported", "Lists support the stored, delivered and effective views.", { exitCode: EXIT.usage });
            const all = local
              .entries(collection)
              .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) * (options.order === "created.asc" ? 1 : -1));
            const offset = options.cursor ? Number(Buffer.from(options.cursor, "base64url").toString("utf8")) || 0 : 0;
            const page = all.slice(offset, offset + limit).map((entry) => {
              const variantFile = locale ? local.store.entryVariantPath(collection, entry.id, locale) : null;
              const variant = variantFile && fs.existsSync(variantFile) ? JSON.parse(fs.readFileSync(variantFile, "utf8")) : null;
              const effective = variant ? (applyVariant(entry.data, variant) as Record<string, unknown>) : entry.data;
              const data = view === "delivered" ? (deliver(effective, local.manifest.assets) as Record<string, unknown>) : effective;
              return { id: entry.id, createdAt: entry.createdAt, updatedAt: entry.updatedAt, data: pickFields(data, fields) };
            });
            const next = offset + page.length;
            return {
              collection,
              view,
              locale,
              total: all.length,
              entries: page,
              nextCursor: next < all.length ? Buffer.from(String(next), "utf8").toString("base64url") : null,
            };
          }
          const { api } = connect(options);
          const [schema, localization] = await Promise.all([fetchRemoteSchema(api), requestedLocale ? readLocalization(api) : Promise.resolve(null)]);
          schema.collection(collection);
          const locale = checkLocale(requestedLocale, localization);
          const view: ContentView = resolveView(options.view, locale);
          const page = await listEntries(api, collection, { limit, cursor: options.cursor, order: options.order, view, locale });
          return {
            collection,
            view,
            locale,
            total: page.total,
            entries: page.entries.map((entry) => ({
              id: entry.id,
              createdAt: entry.created,
              updatedAt: entry.updated,
              data: pickFields(entry.data, fields),
            })),
            nextCursor: page.nextCursor,
          };
        },
        (result) => {
          const columns = parseFields(options.fields) ?? Object.keys(result.entries[0]?.data ?? {}).slice(0, 4);
          console.log(
            table(
              result.entries.map((entry) => ({ id: entry.id, ...entry.data })),
              ["id", ...columns],
            ),
          );
          console.log(chalk.gray(`\n${result.entries.length} of ${result.total}${result.nextCursor ? ` · next page: --cursor ${result.nextCursor}` : ""}`));
        },
      ),
    );
}

interface GetOptions extends CommonOptions {
  locale?: string;
  view?: string;
  pointer?: string;
  full?: boolean;
  local?: boolean;
}

function getCommand(): Command {
  return withCommonOptions(new Command("get"))
    .description("Read one entry")
    .argument("<collection>", "Collection name")
    .argument("<id>", "Entry ID")
    .option("--locale <locale>", "Read a translation")
    .addOption(viewOption())
    .option("--pointer <pointer>", "Read only the part at this JSON pointer")
    .option("--full", "Print large values whole instead of as an outline", false)
    .option("--local", "Read the local copy (.ama/content)", false)
    .addHelpText("after", `\nViews:\n${VIEW_HELP}`)
    .action((collection: string, id: string, options: GetOptions) =>
      runAction(
        options,
        async () => {
          const requestedLocale = options.locale ? canonicalLocale(options.locale) : undefined;
          const ref = { kind: "entry" as const, name: collection, entryId: id };
          let result;
          if (options.local) {
            const local = new LocalContent();
            local.schema.collection(collection);
            const locale = checkLocale(requestedLocale, local.manifest.localization);
            result = local.read(ref, resolveView(options.view, locale), locale);
          } else {
            const { api } = connect(options);
            const [schema, localization] = await Promise.all([fetchRemoteSchema(api), requestedLocale ? readLocalization(api) : Promise.resolve(null)]);
            schema.collection(collection);
            const locale = checkLocale(requestedLocale, localization);
            const { entry: _entry, ...read } = await readEntry(api, collection, id, { view: resolveView(options.view, locale), locale, ref: `entry:${collection}/${id}` });
            result = read;
          }
          if (options.pointer && !resolvePointer(result.value, options.pointer).found) {
            throw new CliError("pointer_not_found", `Nothing at ${options.pointer} in ${result.ref}.`, { exitCode: EXIT.usage, pointer: options.pointer });
          }
          const view = viewValue(result.value, { pointer: options.pointer, full: options.full })!;
          const { value: _value, ...meta } = result;
          return { ...meta, ...view };
        },
        (result) => {
          console.error(chalk.gray(`${result.ref}  ${result.view}${result.locale ? ` · ${result.locale}` : ""}  fingerprint ${result.fingerprint.slice(0, 12)}`));
          if (result.view === "outline") {
            console.error(chalk.yellow(result.note));
            console.log(table(result.outline.rows as unknown as Array<Record<string, unknown>>, ["pointer", "summary", "label"]));
          } else printValue(result.value);
        },
      ),
    );
}

export function entriesCommand(): Command {
  return new Command("entries").description("Read collection entries").addCommand(lsCommand()).addCommand(getCommand());
}
