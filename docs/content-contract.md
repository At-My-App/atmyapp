# Content validation and normalization

The beta contract uses the same pure rules in the SDK and AMA's write/publication boundaries. `@atmyapp/structure/testing` exports the shared field-kind fixture corpus for integration checks.

```ts
import { defineDocument, s, normalizeContent, validate, createItemKey } from '@atmyapp/structure';

const definition = defineDocument({
  fields: {
    title: s.string({ default: 'Untitled' }),
    items: s.array({
      items: s.object({ fields: { text: s.string() } }),
      default: [],
    }),
  },
});
const normalized = normalizeContent(input, definition, {
  base: immutableBase, // undefined only for creation
  resourceIdentity: 'document:home.json',
  createKey: createItemKey,
});
const validation = validate(normalized.value, definition, 'draft');
const hardIssues = [...normalized.issues, ...validation.issues]
  .filter(issue => issue.severity === 'hard');
// Store the proposal only if hardIssues is empty; retain normalized IDs on retry.
```

Validation returns stable `code`, `path`, `severity` (`hard` or `overridable`), and developer `message`. `valid` is false for either kind of issue. Drafts may omit required properties; supplied values must be structurally correct. Publication requires the complete stored shape. Editorial issues require explicit human consent bound to the exact reviewed content; clients cannot turn structural errors into warnings.

Defaults are creation values. They do not make a stored field optional and are not returned in place of missing read values. Existing edits do not populate unrelated defaults, even after a schema default changes. `buildDefaultsFromFields` and `createDefaultWebsiteSettings` are creation helpers using the shared normalizer. Website settings' delivered type reflects its optional schema fields.

`optional` permits absence. Use `nullable: true` or an explicit null alternative for null; this applies uniformly to scalars, references and assets. For example `s.reference('authors', { optional: true, nullable: true })` allows an explicitly cleared reference. Empty reference strings are invalid. The compatibility `legacy` preparation mode is internal rollout support, not an alternative validation policy for new content.

Integer values must be safe integers; all numbers must be finite. Dates are real `YYYY-MM-DD` calendar values. Datetime/timestamp strings include a timezone. Enum alternatives, managed slugs, references, required stored shape and item identities are structural. Length/count/range preferences, patterns, email/URL preferences, and business uniqueness are editorial. HTTP/HTTPS URLs are the supported URL preference. Renderers still own escaping and safe links.

`unique` is supported on non-localized top-level collection values; unsupported scopes are rejected by schema validation. Equality is case-sensitive canonical JSON, with missing values ignored and explicit permitted null counted. Internal `_key` does not affect business uniqueness; repeated item identities are hard errors. Object union alternatives should have a required enum discriminator. Overlapping alternatives that imply different defaults or identity normalization fail with `ambiguous-union`.

Editable object arrays get reserved `_key` values unless `identityField` is declared. Initial legacy IDs are derived from immutable resource/array/base-item context; new IDs are random and must be retained in the saved operation. Recovery uses unique base matches, never edited position. Ambiguity, duplicate keys and stale deterministic identities reject the proposal without replacing IDs. Primitive arrays stay atomic. `_key` is delivered unchanged and optional in generated object-item types until the project is backfilled.

Translations address source items by identity. A translation may set only `localize: true` fields; anything else fails with `not-localizable`. When the source deletes an item, its translated fragments are removed in the same write (`pruneDeletedItemTranslations`). A translation that names an item the source does not have is still rejected.

Unknown schema kinds/versions/properties, malformed defaults/regexes/cardinalities, reserved fields and colliding aliases fail closed. `validateSchemaDocument` also checks semantic constraints, including targets and supported uniqueness scopes. Root transport metadata is excluded from semantic serialization. Top-level content properties removed from the editor remain stored; nested closed objects keep their declared additional-property policy and permit internal `_key`.

AMA's rollout requires a read-only audit of tester snapshots and site builds before enabling enforcement. Untouched legacy content is not globally rewritten; pending item IDs are reported separately. Locales require an explicit project backfill and no pending content drafts. Migration warning acceptance is separate from publication consent.
