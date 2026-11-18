import chalk from "chalk";
import { Command, Option } from "commander";
import { checkLocale, contentMap, readLocalization, readRef, type ContentView, type ReadResult } from "../../runtime/content";
import { CliError, EXIT } from "../../runtime/errors";
import { LocalContent } from "../../runtime/local";
import { pullContent } from "../../runtime/pull";
import { canonicalLocale, parseRef } from "../../runtime/refs";
import { fetchRemoteSchema } from "../../runtime/schema";
import { viewValue } from "../../runtime/views";
import { connect, printValue, runAction, table, withCommonOptions, type CommonOptions } from "../output";

export const VIEW_HELP = [
  "stored    what is saved; the shape writes accept (assets as $asset/__blob references, list items with _key)",
  "delivered what the website SDK receives (assets as { url, alt })",
  "overlay   a translation's own fields only (needs --locale)",
  "effective the source with the translation applied (default with --locale)",
].join("\n");

export function viewOption() {
  return new Option("--view <view>", "stored | delivered | overlay | effective (see 'atmyapp content get --help')").choices([
    "stored",
    "delivered",
    "overlay",
    "effective",
  ]);
}

export function resolveView(view: string | undefined, locale: string | null): ContentView {
  if (view) return view as ContentView;
  return locale ? "effective" : "stored";
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
    .description("Read a document, file or entry")
    .argument("<ref>", "doc:<name>, file:<path> or entry:<collection>/<id>, optionally with @<locale> and #/<pointer>")
    .option("--locale <locale>", "Read a translation")
    .addOption(viewOption())
    .option("--pointer <pointer>", "Read only the part at this JSON pointer, e.g. /hero/title")
    .option("--full", "Print large values whole instead of as an outline", false)
    .option("--local", "Read the local copy (.ama/content) instead of the project", false)
    .addHelpText("after", `\nViews:\n${VIEW_HELP}\n\nLarge values (over 20,000 characters) print as an outline of JSON pointers; read a part with --pointer.`)
    .action((input: string, options: GetOptions) =>
      runAction(
        options,
        async () => {
          const ref = parseRef(input);
          const requestedLocale = options.locale ? canonicalLocale(options.locale) : ref.locale;
          const pointer = options.pointer ?? ref.pointer;
          if (pointer !== undefined && pointer !== "" && !pointer.startsWith("/")) {
            throw new CliError("invalid_pointer", "A JSON pointer starts with '/', e.g. /hero/title.", { exitCode: EXIT.usage });
          }
          let result: ReadResult;
          if (options.local) {
            const local = new LocalContent();
            const locale = checkLocale(requestedLocale, local.manifest.localization);
            result = local.read(ref, resolveView(options.view, locale), locale);
          } else {
            const { api } = connect(options);
            const [schema, localization] = await Promise.all([fetchRemoteSchema(api), requestedLocale ? readLocalization(api) : Promise.resolve(null)]);
            const locale = checkLocale(requestedLocale, localization);
            result = await readRef(api, schema, ref, { view: resolveView(options.view, locale), locale });
          }
          const view = viewValue(result.value, { pointer, full: options.full });
          if (!view) {
            throw new CliError("pointer_not_found", `Nothing at ${pointer} in ${result.ref}.`, { exitCode: EXIT.usage, pointer });
          }
          const { value: _value, ...meta } = result;
          return { ...meta, ...view };
        },
        (result) => {
          console.error(chalk.gray(`${result.ref}  ${result.view}${result.locale ? ` · ${result.locale}` : ""}  fingerprint ${result.fingerprint.slice(0, 12)}`));
          if (result.view === "outline") {
            console.error(chalk.yellow(result.note));
            console.log(table(result.outline.rows as unknown as Array<Record<string, unknown>>, ["pointer", "summary", "label"]));
            if (result.outline.truncated) console.error(chalk.gray("(outline shortened)"));
          } else {
            printValue(result.value);
          }
        },
      ),
    );
}

function lsCommand(): Command {
  return withCommonOptions(new Command("ls"))
    .description("List the project's documents, collections and files, with where they appear on the website")
    .action((options: CommonOptions) =>
      runAction(
        options,
        async () => {
          const { api } = connect(options);
          const schema = await fetchRemoteSchema(api);
          return contentMap(api, schema);
        },
        (map) => {
          console.log(
            table(
              map.items.map((item) => ({
                ref: item.ref,
                kind: item.kind,
                entries: item.entries,
                pages: item.pages,
                description: item.description ?? item.summary,
              })),
              ["ref", "kind", "entries", "pages", "description"],
            ),
          );
          if (map.localization) {
            console.log(chalk.gray(`\nLanguages: ${map.localization.supportedLocales.join(", ")} (default ${map.localization.defaultLocale})`));
          }
          if (!map.pagesKnown) console.log(chalk.gray("Pages are unknown until the website code is analysed (Settings → Project setup)."));
        },
      ),
    );
}

function pullCommand(): Command {
  return withCommonOptions(new Command("pull"))
    .description("Copy the project's published content to .ama/content/published for offline use and local editing")
    .option("--full", "Read everything again instead of only what changed", false)
    .option("--media", "Download images and files too (default: websites get their published URLs)", false)
    .addHelpText(
      "after",
      "\nWebsites read the copy with ATMYAPP_CLIENT_MODE=local (drafts in spaces included) or clientMode: \"with-fallback\" (published content only).",
    )
    .action((options: CommonOptions & { full?: boolean; media?: boolean }) =>
      runAction(
        options,
        async ({ logger }) => {
          const { api } = connect(options);
          return pullContent(api, { full: options.full, media: options.media, onProgress: (message) => logger.verbose_log(message) });
        },
        (summary) => {
          if (summary.mode === "up-to-date") console.log(`The local copy is already current (${summary.baseCommit?.slice(0, 8)}).`);
          else
            console.log(
              `${summary.mode === "full" ? "Copied" : "Updated"} ${summary.files} files, ${summary.entries} entries and ${summary.translations} translations${
                summary.removed ? `; removed ${summary.removed}` : ""
              } → ${summary.dir}`,
            );
          for (const note of summary.notes) console.log(chalk.yellow(note));
        },
      ),
    );
}

export function contentCommand(): Command {
  return new Command("content")
    .description("Read the project's content and keep a local copy")
    .addCommand(lsCommand())
    .addCommand(getCommand())
    .addCommand(pullCommand());
}
