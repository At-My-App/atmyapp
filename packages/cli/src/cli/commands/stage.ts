import { outdatedTranslations } from "../../runtime/locales";
import { Command, Option } from "commander";
import {
  discardStage,
  extendSession,
  listMembers,
  listNamedSessions,
  parseTtl,
  push,
  requestReview,
  stageDiff,
  stageConflicts,
  stagePreview,
  stageStatus,
  undoStage,
} from "../../runtime/sessions";
import { draftSchemaWarnings } from "../../runtime/compile";
import { connect, printValue, runAction, table } from "../output";
import { confirm, draftOptions, maybeConnect, workFor, type DraftOptions } from "./draftOptions";

function printOutdated(items: Array<{ ref: string; locales: string[] }>) {
  for (const item of items)
    console.error(`${item.ref} outdates ${item.locales.join(", ")}. Run 'atmyapp locales export --space --status outdated' with --locale.`);
}

export function stageCommand() {
  return new Command("stage")
    .description("Stage local content and hand it to a reviewer")
    .addCommand(draftOptions(new Command("conflicts"))
      .description("Inspect conflicts between a named draft and current published content")
      .addHelpText("after", "\nExample: atmyapp stage conflicts --json")
      .action((options: DraftOptions) => runAction(options,
        () => stageConflicts(connect(options).api, workFor(options)), printValue)))

    .addCommand(
      draftOptions(new Command("push"), { write: true })
        .description("Validate and push changes from the active space")
        .argument("[refs...]", "Push only these content references")
        .option("--ttl <duration>", "Lifetime for a new draft, e.g. 24h")
        .option("--operation-id <id>", "Resume a pending push with this ID")
        .addHelpText("after", "\nExamples:\n  atmyapp stage push doc:home --dry-run\n  atmyapp stage push --json")
        .action((refs: string[], options: DraftOptions & { ttl?: string; operationId?: string }) =>
          runAction(
            options,
            async () => {
              const work = workFor(options);
              const warnings = draftSchemaWarnings(work, process.cwd());
              const outdated = outdatedTranslations(work);
              const result = await push(work, options.dryRun ? undefined : connect(options).api, {
                refs,
                dryRun: options.dryRun,
                operationId: options.operationId,
                ttlSeconds: options.ttl === undefined ? undefined : parseTtl(options.ttl),
                onOperation: (id) => console.error(`Operation ${id}`),
              });
              return { ...result, warnings, outdatedTranslations: outdated };
            },
            (result) => {
              console.log(
                `${result.dryRun ? "Would stage" : "Staged"} ${result.dryRun ? result.items.length : result.staged} changes in ${result.batches} batch(es).`,
              );
              if ("session" in result && result.session) console.log(`Draft ${result.session.sessionId}`);
              for (const warning of result.warnings) console.error(warning.message);
              printOutdated(result.outdatedTranslations);
              for (const issue of result.issues) console.log(`${issue.ref}${issue.pointer}: ${issue.message}`);
            },
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("status"))
        .description("Check the active space and its named draft")
        .addHelpText("after", "\nExample: atmyapp stage status --json")
        .action((options: DraftOptions) =>
          runAction(
            options,
            async () => {
              const work = workFor(options);
              return { ...await stageStatus(work, maybeConnect(options)), outdatedTranslations: outdatedTranslations(work) };
            },
            (result) => {
              console.log(
                result.session
                  ? `${result.session.name} · ${result.session.reviewState} · expires ${result.session.expiresAt}`
                  : result.link
                    ? `Draft ${result.link.sessionId}`
                    : "No named draft is linked.",
              );
              console.log(table(result.items, ["ref", "state"]));
              printOutdated(result.outdatedTranslations);
            },
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("ls"), { space: false })
        .description("List named drafts in the project")
        .addOption(new Option("--state <state>").choices(["open", "in_review", "sent_back"]))
        .option("--mine", "Show only drafts owned by this key")
        .addHelpText("after", "\nExample: atmyapp stage ls --mine")
        .action((options: DraftOptions & Parameters<typeof listNamedSessions>[1]) =>
          runAction(
            options,
            async () => ({ sessions: await listNamedSessions(connect(options).api, options) }),
            (result) =>
              console.log(
                table(
                  result.sessions.map((session) => ({
                    ...session,
                    owner: session.owner.displayName,
                    reviewer: session.reviewer?.name,
                  })),
                  ["name", "sessionId", "owner", "reviewState", "reviewer", "itemCount", "expiresAt"],
                ),
              ),
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("diff"))
        .description("Compare the named draft with current published content")
        .argument("[ref]")
        .addHelpText("after", "\nExample: atmyapp stage diff entry:posts/article")
        .action((ref: string | undefined, options: DraftOptions) =>
          runAction(
            options,
            async () => stageDiff(connect(options).api, workFor(options), ref),
            (result) => {
              for (const item of result.items) {
                console.log(`${item.change} ${item.itemKey}`);
                for (const field of item.fields) console.log(`  ${field.label}: ${field.change}`);
              }
            },
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("undo"), { write: true })
        .description("Undo a saved step in the named draft")
        .argument("[stepId]")
        .addHelpText("after", "\nExample: atmyapp stage undo --dry-run")
        .action((stepId: string | undefined, options: DraftOptions) =>
          runAction(
            options,
            async () => undoStage(connect(options).api, workFor(options), stepId, options.dryRun),
            printValue,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("discard"), { write: true, confirm: true })
        .description("Discard the named draft and keep the local working copy")
        .addHelpText("after", "\nExample: atmyapp stage discard --yes")
        .action((options: DraftOptions) =>
          runAction(
            options,
            async () => {
              const work = workFor(options);
              await confirm(options, "Discard this space's named draft?");
              return discardStage(connect(options).api, work, options.dryRun);
            },
            printValue,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("preview"))
        .description("Get the managed website preview URL")
        .option("--wait", "Retry while the preview URL is being prepared")
        .addHelpText("after", "\nExample: atmyapp stage preview --wait")
        .action((options: DraftOptions & { wait?: boolean }) =>
          runAction(
            options,
            async () => stagePreview(connect(options).api, workFor(options), options.wait),
            (result) => console.log(result.url),
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("extend"), { write: true })
        .description("Extend the named draft's lifetime")
        .requiredOption("--ttl <duration>", "Lifetime from now, 1h–7d")
        .addHelpText("after", "\nExample: atmyapp stage extend --ttl 3d")
        .action((options: DraftOptions & { ttl: string }) =>
          runAction(
            options,
            async () => extendSession(connect(options).api, workFor(options), parseTtl(options.ttl), options.dryRun),
            printValue,
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("review"), { write: true })
        .description("Ask a project member to review the named draft")
        .requiredOption("--to <email-or-user-id>", "Choose a member who can edit content")
        .option("--message <text>", "Review note (up to 2,000 characters)")
        .addHelpText(
          "after",
          "\nExample: atmyapp stage review --to editor@example.com --message 'Please check the headline'",
        )
        .action((options: DraftOptions & { to: string; message?: string }) =>
          runAction(
            options,
            async () =>
              requestReview(connect(options).api, workFor(options), options.to, options.message, options.dryRun),
            (result) =>
              console.log(
                `${result.dryRun ? "Would ask" : "Asked"} ${result.reviewer.name} to review ${result.sessionId}.`,
              ),
          ),
        ),
    );
}

export function membersCommand() {
  return new Command("members").description("Find project members who can review drafts").addCommand(
    draftOptions(new Command("ls"), { space: false })
      .description("List project members, optionally filtered by capability")
      .option("--can <capability>", "E.g. content.edit or content.publish")
      .addHelpText("after", "\nExample: atmyapp members ls --can content.edit --json")
      .action((options: DraftOptions & { can?: string }) =>
        runAction(
          options,
          async () => ({ members: await listMembers(connect(options).api, options.can) }),
          (result) => console.log(table(result.members, ["name", "email", "userId", "roles", "via"])),
        ),
      ),
  );
}
