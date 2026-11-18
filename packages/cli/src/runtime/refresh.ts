import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FieldDefinition } from "@atmyapp/structure";
import { CliError, EXIT } from "./errors";
import { sha256Hex } from "./fingerprint";
import { mergeContent, type MergeConflict, type MergeSide } from "./merge";
import { formatRef } from "./refs";
import { readSpace, withSpace, writeSpace, type SpaceFile } from "./spaces";
import { recordWorkItem, selectWorkItems, type WorkingCopy, type WorkItem } from "./workingCopy";

function itemSchema(work: WorkingCopy, item: WorkItem): FieldDefinition | undefined {
  const ref = item.ref;
  const definition =
    ref.kind === "entry" ? work.schema.collection(ref.name) : work.schema.definitionForPath(ref.name)?.definition;
  return definition && "fields" in definition ? { kind: "object", fields: definition.fields } : undefined;
}

function reportValue(value: unknown): unknown {
  return Buffer.isBuffer(value) ? { sha256: sha256Hex(value), size: value.length } : value;
}

export async function mergeSpace(
  work: WorkingCopy,
  options: {
    refs?: string[];
    dryRun?: boolean;
    resolve?: { take: MergeSide; pointer?: string };
  } = {},
) {
  const action = (space: SpaceFile) => {
    if (existsSync(join(work.store.spaceDir(work.name), ".push.json")))
      throw new CliError("pending_push", "Finish the pending push before refreshing this space.", {
        exitCode: EXIT.conflict,
      });

    const selection = selectWorkItems(work, work.itemStates(space, !!options.refs?.length), options.refs ?? []);
    const updated: string[] = [];
    const conflicts: Array<MergeConflict & { ref: string }> = [];
    for (const item of selection) {
      const ref = formatRef(item.ref);
      if (item.state === "remote-changed") {
        if (!options.dryRun) {
          work.store.remove(item.file);
          delete space.items[item.key];
          updated.push(ref);
        }
        continue;
      }
      if (item.state !== "conflict") continue;
      const ours = item.deleted ? undefined : item.sha256 ? work.value(item) : undefined;
      const theirs = work.publishedValue(item.ref);
      if (theirs === undefined && item.published.fingerprint && !item.ref.locale)
        throw new CliError("not_downloaded", `${ref} must be downloaded to merge or resolve its edits.`, {
          exitCode: EXIT.conflict,
          fix: "Run 'atmyapp content pull --media' and try again.",
        });
      let base: unknown;
      let missingBase = false;
      try {
        base = work.baseValue(item);
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "base_unavailable") throw error;
        missingBase = true;
      }
      const schema = itemSchema(work, item);
      const saved = space.items[item.key]?.merge;
      const choices = new Map(
        saved?.local === item.sha256 && saved.head === item.published.fingerprint ? saved.choices : [],
      );
      const merge = () =>
        missingBase
          ? {
              value: choices.get("") === "theirs" ? theirs : ours,
              conflicts: choices.has("") ? [] : [{ pointer: "", base, ours, theirs }],
            }
          : mergeContent(base, ours, theirs, schema, choices);
      const resolve = options.resolve;
      if (resolve) {
        const available = merge().conflicts;
        if (resolve.pointer !== undefined && !available.some((conflict) => conflict.pointer === resolve.pointer))
          throw new CliError("pointer_not_found", "No merge conflict exists at that pointer.", {
            exitCode: EXIT.conflict,
            pointer: resolve.pointer,
          });
        for (const conflict of available)
          if (resolve.pointer === undefined || conflict.pointer === resolve.pointer)
            choices.set(conflict.pointer, resolve.take);
      }
      const result = merge();
      if (result.conflicts.length) {
        conflicts.push(
          ...result.conflicts.map(({ pointer, base, ours, theirs }) => ({
            pointer,
            base: reportValue(base),
            ours: reportValue(ours),
            theirs: reportValue(theirs),
            ref,
          })),
        );
        if (!options.dryRun && resolve) {
          recordWorkItem(space, work, item.ref).merge = {
            local: item.sha256,
            head: item.published.fingerprint,
            choices: [...choices],
          };
        }
        continue;
      }
      if (!options.dryRun) {
        const savedItem = recordWorkItem(space, work, item.ref);
        savedItem.base = item.published;
        if (savedItem.staged) savedItem.rebase = true;
        delete savedItem.merge;
        space.deletions = space.deletions.filter((key) => key !== item.key);
        if (result.value === undefined) {
          work.store.remove(item.file);
          if (item.published.fingerprint || savedItem.staged) space.deletions.push(item.key);
          else delete space.items[item.key];
        } else if (Buffer.isBuffer(result.value)) work.store.writeBytes(item.file, result.value);
        else work.writeValue(item.ref, result.value, item.file, !!item.newFile);
      }
      updated.push(ref);
    }
    if (options.resolve && !updated.length && !conflicts.length)
      throw new CliError("no_conflict", "This item has no merge conflict.", { exitCode: EXIT.conflict });
    if (!options.dryRun) writeSpace(work.store, space);
    return { dryRun: !!options.dryRun, space: work.name, updated, conflicts };
  };
  return options.dryRun ? action(readSpace(work.store, work.name)) : withSpace(work.store, work.name, action);
}
