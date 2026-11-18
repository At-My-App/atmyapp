import { Command } from "commander";
import { listSpaces, removeSpace } from "../../runtime/spaceOperations";
import { collectUnusedObjects, createSpace, useSpace } from "../../runtime/spaces";
import { ContentStore } from "../../runtime/store";
import { runAction, table } from "../output";
import { draftOptions, maybeConnect, type DraftOptions } from "./draftOptions";

export function spaceCommand() {
  return new Command("space")
    .description("Manage local working copies for named drafts")
    .addCommand(
      draftOptions(new Command("create"), { write: true, space: false })
        .description("Create a space from the published copy or another space")
        .argument("<name>")
        .option("--from <space>", "Copy changes from another space")
        .addHelpText("after", "\nExample: atmyapp space create homepage --from published")
        .action((name: string, options: DraftOptions & { from?: string }) =>
          runAction(
            options,
            async () => {
              const space = createSpace(new ContentStore(), name, options);
              return { space: space.name, dryRun: !!options.dryRun };
            },
            (result) => console.log(result.dryRun ? `Would create '${result.space}'.` : `Created '${result.space}'.`),
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("use"), { write: true, space: false })
        .description("Set the active space for the CLI and local website")
        .argument("<name>")
        .addHelpText("after", "\nExample: atmyapp space use homepage")
        .action((name: string, options: DraftOptions) =>
          runAction(
            options,
            async () => ({
              space: useSpace(new ContentStore(), name, options.dryRun).name,
              dryRun: !!options.dryRun,
            }),
            (result) => console.log(result.dryRun ? `Would select '${result.space}'.` : `Using '${result.space}'.`),
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("ls"), { space: false })
        .description("List spaces, their changes and their linked drafts")
        .addHelpText("after", "\nExample: atmyapp space ls --json")
        .action((options: DraftOptions) =>
          runAction(
            options,
            async () =>
              listSpaces(new ContentStore(), {
                active: process.env.ATMYAPP_SPACE,
                connect: () => maybeConnect(options),
              }),
            (result) => {
              console.log(
                table(
                  result.spaces.map((space) => ({
                    ...space,
                    name: (space.active ? "* " : "") + space.name,
                    session: space.session?.sessionId,
                    counts: Object.entries(space.counts)
                      .map(([state, count]) => `${count} ${state}`)
                      .join(", "),
                  })),
                  ["name", "counts", "session", "reviewState", "expiresAt", "removable"],
                ),
              );
              for (const overlap of result.overlaps)
                console.log(`${overlap.key} also edited in ${overlap.spaces.join(", ")}`);
            },
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("rm"), { space: false, write: true })
        .description("Remove a local space")
        .argument("<name>")
        .option("--force", "Remove even with unpushed edits or a draft in review", false)
        .addHelpText("after", "\nExample: atmyapp space rm homepage --dry-run")
        .action((name: string, options: DraftOptions & { force?: boolean }) =>
          runAction(
            options,
            async () => removeSpace(new ContentStore(), name, { ...options, connect: () => maybeConnect(options) }),
            (result) => console.log(result.dryRun ? `Would remove '${result.space}'.` : `Removed '${result.space}'.`),
          ),
        ),
    )
    .addCommand(
      draftOptions(new Command("gc"), { space: false, write: true })
        .description("Remove local objects unused by the published copy and every space")
        .addHelpText("after", "\nExample: atmyapp space gc --dry-run")
        .action((options: DraftOptions) =>
          runAction(
            options,
            async () => collectUnusedObjects(new ContentStore(), options.dryRun),
            (result) =>
              console.log(
                `${result.dryRun ? "Would remove" : "Removed"} ${result.objects} objects (${result.bytes} bytes).`,
              ),
          ),
        ),
    );
}
