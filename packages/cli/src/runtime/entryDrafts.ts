import { randomUUID } from "node:crypto";
import type { Placement } from "@atmyapp/structure";
import { CliError, EXIT } from "./errors";
import { editLocalContent, itemKey, record, type WorkingCopy } from "./workingCopy";

export async function editEntry(input: {
  work: WorkingCopy;
  collection: string;
  entryId?: string;
  data?: unknown;
  replace?: boolean;
  remove?: boolean;
  dryRun?: boolean;
}) {
  input.work.schema.collection(input.collection);
  const entryId = input.entryId ?? randomUUID();
  const ref = { kind: "entry" as const, name: input.collection, entryId };
  if (input.remove)
    return {
      ...(await editLocalContent({ work: input.work, ref, remove: true, dryRun: input.dryRun })),
      entryId,
      warnings: [],
    };
  if (
    input.entryId &&
    !input.work.published(ref).fingerprint &&
    !input.work.itemStates().some((item) => item.key === itemKey(ref) && !item.deleted && item.sha256)
  )
    throw new CliError(
      "not_found",
      "The entry is not in this working copy. Pull the published copy or create a new entry.",
      { exitCode: EXIT.usage },
    );
  const data = input.data;
  if (!record(data))
    throw new CliError("invalid_content", "Entry data must be a JSON object.", { exitCode: EXIT.validation });
  const warnings: Array<{ code: string; message: string }> = [];
  const replace = !input.entryId || !!input.replace;
  const edited = await editLocalContent({
    work: input.work,
    ref,
    dryRun: input.dryRun,
    replaceData: replace,
    edit: (base) => {
      if (!replace && record(base)) {
        for (const [key, value] of Object.entries(data)) {
          const previous = base[key];
          if (record(previous) && record(value) && Object.keys(previous).some((field) => !(field in value))) {
            warnings.push({
              code: "partial_nested_object",
              message: `'${key}' replaces the whole nested object. Include every field you want to keep.`,
            });
          }
        }
        return { ...base, ...data };
      }
      return data;
    },
  });
  return { ...edited, entryId, warnings };
}

export async function moveEntry(input: {
  work: WorkingCopy;
  collection: string;
  entryId: string;
  placement: Placement;
  field?: string;
  dryRun?: boolean;
}) {
  const definition = input.work.schema.collection(input.collection);
  const order = Object.entries(definition.fields)
    .filter(([, value]) => value.kind === "order")
    .map(([field]) => field);
  const field = input.field ?? (order.length === 1 ? order[0] : undefined);
  if (!field || !order.includes(field))
    throw new CliError(
      "invalid_order_field",
      order.length
        ? `Choose an order field with --field (${order.join(", ")}).`
        : "This collection has no order field.",
      { exitCode: EXIT.usage },
    );
  const ref = { kind: "entry", name: input.collection, entryId: input.entryId } as const;
  const items = input.work.itemStates();
  function exists(entryId: string) {
    const coordinate = { ...ref, entryId };
    const local = items.find((item) => item.key === itemKey(coordinate));
    return !local?.deleted && !!(input.work.published(coordinate).fingerprint || local?.staged);
  }
  if (!exists(input.entryId))
    throw new CliError("not_found", "Move an entry that has already been saved.", { exitCode: EXIT.usage });
  if ("entryId" in input.placement && (input.placement.entryId === input.entryId || !exists(input.placement.entryId)))
    throw new CliError("invalid_anchor", "Choose another saved entry in this collection.", { exitCode: EXIT.usage });
  return editLocalContent({ work: input.work, ref, dryRun: input.dryRun, placement: { field, ...input.placement } });
}
