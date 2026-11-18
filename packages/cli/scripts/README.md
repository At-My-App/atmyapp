# CLI release smoke

Build the SDK and CLI first with pnpm --filter @atmyapp/cli... build from the SDK checkout. Run the smoke against a dedicated test project after deploying the API and dashboard. Set ATMYAPP_CLI_URL and ATMYAPP_CLI_KEY for the test project. Also set ATMYAPP_CLI_SMOKE_CONTENT_KEY, ATMYAPP_CLI_SMOKE_SCHEMA_KEY, and ATMYAPP_CLI_SMOKE_SNAPSHOT_KEY to keys granted only content.read, schema.push, and snapshot respectively.

Create a fixture JSON file with paths and references from your test project.

~~~json
{
  "document": "doc:home",
  "pointer": "/hero/title",
  "largeDocument": "doc:catalogue",
  "collection": "posts",
  "locale": "de",
  "changedFile": "smoke.json",
  "assets": [
    { "ref": "file:files/menu.pdf", "mimeType": "application/pdf" },
    { "ref": "doc:home#/hero/image", "mimeType": "image/png" },
    { "ref": "entry:posts/example#/cover", "mimeType": "image/jpeg" }
  ]
}
~~~

The fixture needs at least 60 entries, an analysed website with working diagnostics, a document over 20,000 characters, and both current and outdated translations for the additional locale. Use a separate scratch directory for each environment.

~~~sh
node packages/cli/scripts/live-smoke.mjs prepare fixture.json /path/to/cli-smoke
node packages/cli/scripts/live-smoke.mjs verify fixture.json /path/to/cli-smoke
~~~

Run prepare first. Publish one edit to changedFile in the test project's dashboard, then run verify using the same scratch directory. The script checks the downloaded assets, the scope behavior, the full local copy, and the single-file incremental pull.

For B4, include a filter object with a where array such as ["price>=20", "price<40"] and an expectedIds array containing the matching entry IDs in newest-first order. Seed at least two matches so the smoke can follow the filter across two pages.

## Named draft smoke

On a test project with a managed preview and an editable document, give the smoke key `schema.read`, `content.read`, and `content.stage`. Set the fixture's `document` and `pointer`, and add a `draftReview` object with `reviewer`, `value`, and `publishedValue`. The reviewer may be a user ID or email. Both values are JSON values for the selected pointer.

```sh
node packages/cli/scripts/live-smoke.mjs draft-prepare fixture.json /tmp/atmyapp-draft-smoke
node packages/cli/scripts/live-smoke.mjs draft-verify fixture.json /tmp/atmyapp-draft-smoke
```

Between commands, open the named draft from the reviewer notification, change the field to `publishedValue`, and publish in the dashboard. The publication receipt is available for seven days.
