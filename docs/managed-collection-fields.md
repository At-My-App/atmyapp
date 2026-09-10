# Slugs, references, and custom ordering

Declare managed fields in the collection schema. Ordinary strings and numbers keep their existing behavior.

```ts
const categories = defineCollection({
  localize: true,
  fields: {
    name: s.string({ localize: true }),
    slug: s.slug({ source: 'name' }),
    order: s.order(),
  },
});
const dishes = defineCollection({
  localize: true,
  fields: {
    name: s.string({ localize: true }),
    category: s.reference('categories', { by: 'slug' }),
    order: s.order({ groupBy: 'category' }),
    featuredOrder: s.order(),
  },
});
```

Register both collections under these names in `defineSchema`. Managed fields are shared across languages. Collection references return keys; they do not automatically fetch objects. Omit `by` to reference entry IDs. Use `multiple: true` for an ordered list without duplicate references. Optional single references can be empty. `groupBy` must name a top-level single reference; multiple references, strings, numbers, and nested paths cannot define ordering groups.

## Creating and editing

A slug is generated from its primary-language source if omitted. Accented Latin characters are normalized, whitespace becomes hyphens, and generated collisions gain `-2`, `-3`, etc. Slugs contain up to 96 lowercase ASCII letters, digits, and single hyphens. A manually supplied slug must already satisfy this syntax and be unique. An empty generated result needs a manual identifier. The first successful save locks the slug; changing a name or translation never regenerates it. Deleting an entry makes its slug available again.

The legacy enabled system-slug configuration is normalized to a native field. Conflicting native and system declarations fail schema compilation. Disabling uniqueness or immutability is unsupported.

Create a referenced category first, then create its dishes in a subsequent call. A saved unpublished category in the same draft session is a valid target. Separate sessions do not share unpublished entries. Deleting a target is blocked until its referencing entries have been reassigned or removed. Undo and discard also validate the resulting relationships.

## Placement operations

Create and update operations accept `placements`, keyed by the exact order-field name:

```ts
{
  type: 'upsertEntry',
  collectionName: 'dishes',
  entryId: 'dish-123',
  data: { name: 'Ravioli', category: 'pasta' },
  placements: {
    order: { position: 'after', entryId: 'dish-456' },
    featuredOrder: { position: 'first' },
  },
}
```

The complete placement union is:

```ts
type Placement =
  | { position: 'first' }
  | { position: 'last' }
  | { position: 'before'; entryId: string }
  | { position: 'after'; entryId: string };
```

Anchors are always entry IDs, including when the grouping reference uses slugs. Create and placement can use one call. Without placement, creation appends to every order field. Changing a grouping reference appends in affected order fields and preserves unrelated order fields. Empty optional references form one group.

The assistant's `moveCollectionEntryTool` requires collection name, entry ID, order-field name, and placement. `listCollectionDraftEntriesTool` exposes saved changes in the current session; the ordinary list tool lists published content. Read the current entry before updating it. Never write rank numbers. Invalid fields, missing/deleted anchors, wrong-group anchors, and self-anchors reject the entire move. Repeating an already-satisfied placement leaves ranks unchanged. Replay the same completed operation ID to recover its receipt without repeating a move; a new command needs a new operation ID.

Ranks are safe integers. Insertion uses gaps, and exhausted groups are deterministically rebalanced at intervals of 1,024. All internal writes are atomic with the move, even above normal assistant batch limits. Internal maintenance is hidden from publication selection. Each order field and group is independent.

Web and mobile entry editors provide searchable reference choices and first/last/before/after actions. Multiple references retain selection order. Multiple ordering fields have an active-field selector. Saved slugs are read-only. Save the entry to apply pending placement.

## Publishing

Publishing validates the current committed content plus only the selected changes. Select a new category along with dishes that reference it, or publish the category first. Dependencies are never automatically published. Placement intent is recalculated against the proposed published state; a missing anchor requires selecting its creation or choosing another anchor. Session revisions and Git head checks protect writes; changed heads are revalidated on retry.

A rebalance must not publish unrelated draft text or media changes. Pure maintenance is omitted from the selection and recalculated during publication. Remaining draft rank collisions after partial publication are repaired without discarding their placement commands.

## Local development

The matching SDK source lives in `/home/macie/projects/libs/atmyapp`. AMA currently consumes the locally built structure package from `.yarn/vendor/atmyapp-structure-0.1.5.tgz`. This makes local verification independent of an npm release. Publish the corresponding public packages and replace the file dependencies as part of release preparation; no npm publication or deployment is performed by this change.

Focused checks cover SDK schema/value validation, staging and commit compilation, Durable Object integrity/concurrency, assistant tools, and existing editor/review behavior. Local tests and TypeScript checks do not establish deployed behavior or physical-device usability. Interactive web/mobile validation and the full publish/reassign/delete journey remain release checks.
