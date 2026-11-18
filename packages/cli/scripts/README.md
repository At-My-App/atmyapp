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


## C3 and C4 authoring smoke

After the backend and CLI are available on staging, run `node packages/cli/scripts/live-smoke.mjs authoring <fixture.json> <scratch-dir>` with the staging project key. Set `fixture.authoring` with `binary` (a 20 MiB image relative to the fixture), `documentAssetRef`, `galleryAssetRef`, `locale`, `translationRef`, `pointer`, and the intended `translation` text. The script stages the assets and translation in a named draft and checks that it has a managed preview. Use that space to inspect the gallery and translation on the staging website, then discard the draft.

## C5 publishing, hosting, and browser login smoke

Once rollout resumes, set `ATMYAPP_CLI_SMOKE_HOSTING_KEY` to a staging key with `hosting.read` and run `node packages/cli/scripts/live-smoke.mjs c5 <fixture.json> <scratch-dir>`. The test project needs a deployment. Set `fixture.c5.deploymentId` to target a specific deployment.

Set `fixture.c5.publishSpace` to a scratch space with a prepared named draft. Use a staging key without `content.publish` as `ATMYAPP_CLI_KEY` and set `ATMYAPP_CLI_SMOKE_PUBLISH_KEY` to an explicit publish key. The script checks refusal and runs publication inspection. Set `fixture.c5.publish` to `true` only when the test draft is ready to publish.

Set `fixture.c5.browserLogin` to `true` after authorizing a staging browser login with `keys.manage,content.read`. This checks login identity, key listing and a key creation preview. Confirm real key creation and revocation with a temporary env file. Revoke the browser login from project settings and check that `whoami` refuses the revoked session.

On the dedicated staging deployment, manually run `hosting deploy --deployment <id> --wait` with a `hosting.deploy` credential, follow the release with `hosting logs <releaseId> --follow --json`, and promote the ready test release. Keep the test login and keys in the staging environment.
