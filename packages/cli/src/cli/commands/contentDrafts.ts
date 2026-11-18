import { Command, Option } from "commander";
import { editTranslation } from "../../runtime/locales";
import { mergeSpace } from "../../runtime/refresh";
import { pullContent } from "../../runtime/pull";
import { ContentStore } from "../../runtime/store";
import type { MergeSide } from "../../runtime/merge";
import { assertDraftValid, compileDraft, draftSchemaWarnings } from "../../runtime/compile";
import { CliError, EXIT } from "../../runtime/errors";
import { applyJsonPatch, setJsonValue } from "../../runtime/jsonPatch";
import { parseRef } from "../../runtime/refs";
import { editLocalContent, grepSpace, selectWorkItems, workSummary } from "../../runtime/workingCopy";
import { connect, printValue, runAction, table } from "../output";
import { jsonInput } from "./entryDrafts";
import { draftOptions, workFor, type DraftOptions } from "./draftOptions";

function renderEdit(result: Awaited<ReturnType<typeof editLocalContent>>) {
  console.log(result.dryRun ? `Would change ${result.ref} · ${result.file}` : result.file);
}

function changedItems(options: DraftOptions, refs: string[]) {
  const work = workFor(options);
  const items = selectWorkItems(work, work.itemStates(), refs).filter(
    (item) => item.state !== "published" && item.state !== "remote-changed",
  );
  return { work, items };
}

function mergeResult(result: Awaited<ReturnType<typeof mergeSpace>>) {
  if (result.conflicts.length)
    throw new CliError("conflict", `${result.conflicts.length} field conflict(s) require a choice.`, {
      exitCode: EXIT.conflict, details: result, fix: "Use 'atmyapp content resolve' with the reported ref and pointer.",
    });
  return result;
}

export function addContentDraftCommands(command: Command) {
  return command
    .addCommand(
      draftOptions(new Command("refresh"), { write: true })
        .description("Pull published content and merge changes into the active space")
        .argument("[ref]")
        .addHelpText("after", "\nExample: atmyapp content refresh doc:home\nDry-run compares with the last local pull.")
        .action((ref: string | undefined, options: DraftOptions) => runAction(options, async () => {
          const store = new ContentStore();
          if (!options.dryRun) await pullContent(connect(options).api, { store });
          return mergeResult(await mergeSpace(workFor(options, store), { refs: ref ? [ref] : [], dryRun: options.dryRun }));
        }, printValue)),
    )
    .addCommand(
      draftOptions(new Command("resolve"), { write: true })
        .description("Resolve one or all field conflicts for an item")
        .argument("<ref>")
        .addOption(new Option("--take <side>").choices(["ours", "theirs"]).makeOptionMandatory())
        .option("--pointer <json-pointer>", "Resolve only this conflict")
        .addHelpText("after", "\nExample: atmyapp content resolve doc:home --take ours --pointer /title")
        .action((ref: string, options: DraftOptions & { take: MergeSide; pointer?: string }) => runAction(options,
          async () => mergeResult(await mergeSpace(workFor(options), { refs: [ref], dryRun: options.dryRun, resolve: options })),
          printValue,
        )),
    )
    .addCommand(
      draftOptions(new Command("edit"), { write: true })
        .description("Copy published content into the active space for editing")
        .argument("<ref>")
        .option("--locale <locale>", "Open a merged translation for editing")
        .addHelpText("after", "\nExamples:\n  atmyapp content edit doc:home\n  atmyapp content edit doc:home --locale de")
        .action((ref: string, options: DraftOptions & { locale?: string }) =>
          runAction(
            options,
            async () => options.locale || parseRef(ref).locale
              ? editTranslation(workFor(options), ref, options)
              : editLocalContent({ work: workFor(options), ref, dryRun: options.dryRun }),
            renderEdit,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("save"), { write: true })
        .description("Save a merged translation to the active space")
        .argument("<ref>").option("--locale <locale>", "Language of the saved edit")
        .addHelpText("after", "\nExample: atmyapp content save doc:home@de")
        .action((ref: string, options: DraftOptions & { locale?: string }) =>
          runAction(options, () => editTranslation(workFor(options), ref, { ...options, save: true }), renderEdit)),
    )
    .addCommand(
      draftOptions(new Command("rm"), { write: true })
        .description("Mark content for deletion in the active space")
        .argument("<ref>")
        .addHelpText("after", "\nExample: atmyapp content rm file:old.txt --dry-run")
        .action((ref: string, options: DraftOptions) =>
          runAction(
            options,
            async () => editLocalContent({ work: workFor(options), ref, remove: true, dryRun: options.dryRun }),
            renderEdit,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("status"))
        .description("Show changes and conflicts in the active space")
        .option("--all", "Include unchanged published items", false)
        .addHelpText("after", "\nExample: atmyapp content status --json")
        .action((options: DraftOptions & { all?: boolean }) =>
          runAction(
            options,
            async () => {
              const work = workFor(options);
              const items = work
                .itemStates(undefined, options.all)
                .filter((item) => options.all || item.state !== "published");
              return { space: work.name, items: items.map(workSummary) };
            },
            (result) => console.log(table(result.items, ["ref", "state"])),
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("diff"))
        .description("Compare local edits with the published copy")
        .argument("[refs...]")
        .addHelpText("after", "\nExample: atmyapp content diff doc:home --json")
        .action((refs: string[], options: DraftOptions) =>
          runAction(
            options,
            async () => {
              const { work, items } = changedItems(options, refs);
              return {
                items: items.map((item) => ({
                  ...workSummary(item),
                  before: work.publishedValue(item.ref),
                  after: item.deleted || !item.sha256 ? undefined : work.value(item),
                })),
              };
            },
            printValue,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("grep"))
        .description("Search the active space over published content")
        .argument("<text>")
        .option("--limit <n>", "Maximum number of matches", "50")
        .addHelpText("after", "\nExample: atmyapp content grep 'Opening hours'")
        .action((text: string, options: DraftOptions & { limit: string }) =>
          runAction(
            options,
            async () => {
              const limit = Number(options.limit);
              if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
                throw new CliError("invalid_limit", "Give a limit between 1 and 1000.", { exitCode: EXIT.usage });
              return grepSpace(workFor(options), text, limit);
            },
            (result) => console.log(table(result.matches, ["ref", "pointer", "text"])),
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("validate"))
        .description("Validate space edits against the published schema")
        .argument("[refs...]")
        .addHelpText("after", "\nExample: atmyapp content validate doc:home --json")
        .action((refs: string[], options: DraftOptions) =>
          runAction(
            options,
            async () => {
              const { work, items } = changedItems(options, refs);
              const { issues } = compileDraft(work, items);
              assertDraftValid(issues);
              return { items: items.length, issues, warnings: draftSchemaWarnings(work, process.cwd()) };
            },
            (result) => {
              console.log(`Validated ${result.items} item(s).`);
              for (const warning of result.warnings) console.error(warning.message);
              for (const issue of result.issues) console.log(`${issue.ref}${issue.pointer}: ${issue.message}`);
            },
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("set"), { write: true })
        .description("Set one JSON value in the active space")
        .argument("<ref#pointer>")
        .argument("<value>")
        .addHelpText("after", "\nExample: atmyapp content set doc:home#/title 'Welcome back'")
        .action((ref: string, raw: string, options: DraftOptions) =>
          runAction(
            options,
            async () => {
              const { pointer } = parseRef(ref);
              if (pointer === undefined)
                throw new CliError("pointer_required", "Include a pointer such as '#/title'.", {
                  exitCode: EXIT.usage,
                });
              let value: unknown;
              try {
                value = JSON.parse(raw);
              } catch {
                value = raw;
              }
              const work = workFor(options);
              const edit = (previous: unknown) => setJsonValue(previous, pointer, value);
              return parseRef(ref).locale ? editTranslation(work, ref, { ...options, apply: edit })
                : editLocalContent({ work, ref, dryRun: options.dryRun, edit });
            },
            renderEdit,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("patch"), { write: true })
        .description("Apply an RFC 6902 patch to local content")
        .argument("<ref>")
        .requiredOption("--json-patch <file>", "A JSON Patch file (prefix with @)")
        .addHelpText("after", "\nExample: atmyapp content patch doc:home --json-patch @edits.json")
        .action((ref: string, options: DraftOptions & { jsonPatch: string }) =>
          runAction(
            options,
            async () => {
              const patch = jsonInput(options.jsonPatch.startsWith("@") ? options.jsonPatch : "@" + options.jsonPatch);
              const work = workFor(options);
              const edit = (previous: unknown) => applyJsonPatch(previous, patch);
              return parseRef(ref).locale ? editTranslation(work, ref, { ...options, apply: edit })
                : editLocalContent({ work, ref, dryRun: options.dryRun, edit });
            },
            renderEdit,
          ),
        ),
    );
}
