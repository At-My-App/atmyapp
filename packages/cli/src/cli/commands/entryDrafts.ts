import { Command } from "commander";
import * as fs from "node:fs";
import { CliError, EXIT } from "../../runtime/errors";
import { editEntry, moveEntry } from "../../runtime/entryDrafts";
import { runAction } from "../output";
import { draftOptions, workFor, type DraftOptions } from "./draftOptions";

export function jsonInput(input: string): unknown {
  try {
    return JSON.parse(input.startsWith("@") ? fs.readFileSync(input.slice(1), "utf8") : input);
  } catch {
    throw new CliError("invalid_content", "Pass valid JSON or @file pointing to a JSON file.", {
      exitCode: EXIT.validation,
    });
  }
}

function renderEntry(result: Awaited<ReturnType<typeof editEntry>>) {
  console.log(`${result.dryRun ? "Would update" : "Updated"} ${result.ref} · ${result.file}`);
  for (const warning of result.warnings) console.error(warning.message);
}

export function addEntryDraftCommands(command: Command) {
  return command
    .addCommand(
      draftOptions(new Command("create"), { write: true })
        .description("Create a new entry in the active space")
        .argument("<collection>")
        .requiredOption("--data <json-or-file>", "Entry data as JSON or @file")
        .addHelpText("after", "\nExample: atmyapp entries create posts --data @post.json")
        .action((collection: string, options: DraftOptions & { data: string }) =>
          runAction(
            options,
            async () =>
              editEntry({ work: workFor(options), collection, data: jsonInput(options.data), dryRun: options.dryRun }),
            renderEntry,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("update"), { write: true })
        .description("Merge top-level fields into an entry in the active space")
        .argument("<collection>")
        .argument("<id>")
        .requiredOption("--data <json-or-file>", "Fields as JSON or @file")
        .option("--replace", "Replace the entry body instead of merging", false)
        .addHelpText("after", '\nExample: atmyapp entries update posts first --data \'{"title":"New title"}\'')
        .action((collection: string, entryId: string, options: DraftOptions & { data: string; replace?: boolean }) =>
          runAction(
            options,
            async () =>
              editEntry({
                work: workFor(options),
                collection,
                entryId,
                data: jsonInput(options.data),
                replace: options.replace,
                dryRun: options.dryRun,
              }),
            renderEntry,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("delete"), { write: true })
        .description("Mark an entry for deletion in the active space")
        .argument("<collection>")
        .argument("<id>")
        .addHelpText("after", "\nExample: atmyapp entries delete posts first --dry-run")
        .action((collection: string, entryId: string, options: DraftOptions) =>
          runAction(
            options,
            async () =>
              editEntry({ work: workFor(options), collection, entryId, remove: true, dryRun: options.dryRun }),
            renderEntry,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("move"), { write: true })
        .description("Set an entry's order for the next push")
        .argument("<collection>")
        .argument("<id>")
        .option("--before <entry-id>")
        .option("--after <entry-id>")
        .option("--first")
        .option("--last")
        .option("--field <name>", "Order field when the collection has several")
        .addHelpText("after", "\nExample: atmyapp entries move posts first --after second")
        .action(
          (
            collection: string,
            entryId: string,
            options: DraftOptions & {
              before?: string;
              after?: string;
              first?: boolean;
              last?: boolean;
              field?: string;
            },
          ) =>
            runAction(
              options,
              async () => {
                if ([options.before, options.after, options.first, options.last].filter(Boolean).length !== 1)
                  throw new CliError("invalid_placement", "Use exactly one of --before, --after, --first or --last.", {
                    exitCode: EXIT.usage,
                  });
                const placement = options.before
                  ? { position: "before" as const, entryId: options.before }
                  : options.after
                    ? { position: "after" as const, entryId: options.after }
                    : { position: options.first ? ("first" as const) : ("last" as const) };
                return moveEntry({
                  work: workFor(options),
                  collection,
                  entryId,
                  field: options.field,
                  placement,
                  dryRun: options.dryRun,
                });
              },
              (result) => console.log(`${result.dryRun ? "Would move" : "Marked for move"} ${result.ref}`),
            ),
        ),
    );
}
