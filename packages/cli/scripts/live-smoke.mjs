#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const [phase, fixtureFile, workDir] = process.argv.slice(2);
const scopeKeys = [
  ["content.read", "ATMYAPP_CLI_SMOKE_CONTENT_KEY"],
  ["schema.push", "ATMYAPP_CLI_SMOKE_SCHEMA_KEY"],
  ["snapshot", "ATMYAPP_CLI_SMOKE_SNAPSHOT_KEY"],
];

function env(name) {
  const value = process.env[name];
  assert(value, "Set " + name);
  return value;
}

async function run(cwd, args, { key = env("ATMYAPP_CLI_KEY"), error, exit = 0, local = false } = {}) {
  let stdout;
  let status = 0;
  try {
    ({ stdout } = await runFile(process.execPath, [cli, ...args, "--json"], {
      cwd,
      env: {
        ...process.env,
        ATMYAPP_CLI_URL: local ? "" : env("ATMYAPP_CLI_URL"),
        ATMYAPP_PROJECT_ID: local ? "" : process.env.ATMYAPP_PROJECT_ID,
        ATMYAPP_CLI_KEY: local ? "" : key,
      },
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (failure) {
    stdout = failure.stdout;
    status = failure.code;
  }
  const label = args.slice(0, 3).join(" ");
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(label + " did not print a JSON document (exit " + status + ").");
  }
  assert.equal(status, exit, label + " failed with " + (result.error?.code ?? status));
  assert.equal(result.ok, !error, label + " returned an unexpected envelope.");
  if (error) assert.equal(result.error.code, error, label + " returned the wrong error.");
  return result.data;
}

function read(cwd, ref, view, local = false) {
  return run(cwd, ["content", "get", ref, "--view", view, "--full", ...(local ? ["--local"] : [])], { local });
}

async function checkLocalCopy(cwd, manifest) {
  const refs = Object.keys(manifest.files).map((path) => "file:" + path);
  for (const [name, collection] of Object.entries(manifest.collections)) {
    for (const id of Object.keys(collection.entries)) refs.push("entry:" + name + "/" + id);
  }

  // Keep the number of simultaneous CLI processes and API requests bounded.
  for (let index = 0; index < refs.length; index += 3) {
    await Promise.all(refs.slice(index, index + 3).map(async (ref) => {
      for (const view of ["stored", "delivered"]) {
        const [remote, local] = await Promise.all([read(cwd, ref, view), read(cwd, ref, view, true)]);
        // Compare without disclosing fixture content on an assertion failure.
        try {
          assert.deepEqual(local.value, remote.value);
        } catch {
          throw new Error(ref + " differs between the remote and local " + view + " views.");
        }
      }
    }));
  }
}

async function checkScopes(cwd, entryRef) {
  for (const [scope, variable] of scopeKeys) {
    const key = env(variable);
    const identity = await run(cwd, ["whoami"], { key });
    assert.deepEqual(identity.key.scopes, [scope], variable + " must grant just " + scope);
    const schema = scope === "content.read" ? { key, error: "missing_scope", exit: 3 } : { key };
    const content = scope === "snapshot" ? { key } : { key, error: "missing_scope", exit: 3 };
    await run(cwd, ["schema", "show"], schema);
    if (scope === "content.read") {
      // An explicit entry asset can be read without loading a project schema.
      await run(cwd, ["assets", "get", entryRef, "-o", "content-key-asset", "--force"], { key });
    } else {
      await run(cwd, ["content", "get", entryRef.split("#")[0]], content);
    }
  }
}

async function prepare(cwd, fixture, manifestPath, checkpointPath) {
  const identity = await run(cwd, ["whoami"]);
  for (const scope of ["schema.read", "content.read"]) {
    assert(identity.key.effectiveScopes.includes(scope), "The smoke key needs " + scope);
  }
  const content = await run(cwd, ["content", "ls"]);
  const collection = content.items.find((item) => item.ref === "coll:" + fixture.collection);
  assert(collection?.entries >= 60, "The fixture collection needs at least 60 entries.");
  assert(content.pagesKnown && content.items.some((item) => item.pages.length > 0), "The fixture needs website placement data.");
  assert(content.localization?.supportedLocales.includes(fixture.locale), "The fixture needs the configured additional locale.");

  for (const view of ["stored", "delivered", "overlay", "effective"]) {
    const ref = ["overlay", "effective"].includes(view) ? fixture.document + "@" + fixture.locale : fixture.document;
    const result = await read(cwd, ref, view);
    assert.equal(result.kind, "document");
    assert(Object.hasOwn(result, "value"), "The document view must return a value.");
    if (view === "overlay") assert(result.variant?.mode, "The fixture needs a translation overlay.");
  }
  const part = await run(cwd, ["content", "get", fixture.document, "--pointer", fixture.pointer]);
  assert.equal(part.view, "part");
  const outline = await run(cwd, ["content", "get", fixture.largeDocument]);
  assert.equal(outline.view, "outline");
  assert(outline.outline.rows.length > 0);

  const first = await run(cwd, ["entries", "ls", fixture.collection, "--limit", "50"]);
  assert.equal(first.entries.length, 50);
  assert(first.nextCursor);
  const second = await run(cwd, ["entries", "ls", fixture.collection, "--limit", "50", "--cursor", first.nextCursor]);
  assert(second.entries.length >= 10);
  const ids = [...first.entries, ...second.entries].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "Entry pages overlap.");
  const entry = await run(cwd, ["entries", "get", fixture.collection, first.entries[0].id, "--view", "delivered"]);
  assert.equal(entry.kind, "entry");
  if (fixture.filter) {
    const { where, expectedIds } = fixture.filter;
    assert(Array.isArray(where) && where.length > 0 && expectedIds.length >= 2, "Set fixture.filter with at least two matching entries.");
    const args = ["entries", "ls", fixture.collection, "--limit", "1", ...where.flatMap((term) => ["--where", term])];
    const filtered = await run(cwd, args);
    assert.equal(filtered.total, expectedIds.length);
    assert(filtered.nextCursor);
    const cursor = JSON.parse(Buffer.from(filtered.nextCursor, "base64url").toString());
    assert.equal(cursor.v, 2);
    const continued = await run(cwd, [...args, "--cursor", filtered.nextCursor]);
    assert.deepEqual([...filtered.entries, ...continued.entries].map(({ id }) => id), expectedIds.slice(0, 2));
  }

  for (const [index, { ref, mimeType }] of fixture.assets.entries()) {
    const filename = "asset-" + index;
    const asset = await run(cwd, ["assets", "get", ref, "-o", filename, "--force"]);
    assert.equal(asset.mimeType.split(";")[0], mimeType);
    assert(asset.size > 0 && asset.size === (await stat(resolve(cwd, filename))).size);
  }
  const locales = await run(cwd, ["locales", "status", "--locale", fixture.locale]);
  assert(locales.counts.current > 0 && locales.counts.outdated > 0, "The fixture needs current and outdated translations.");
  await checkScopes(cwd, fixture.assets.find(({ ref }) => ref.startsWith("entry:")).ref);

  const pull = await run(cwd, ["content", "pull", "--full", "--media"]);
  assert.equal(pull.mode, "full");
  assert(pull.baseCommit, "The smoke fixture needs a Git history.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(manifest.files[fixture.changedFile], "The file to edit needs to exist in the fixture.");
  await checkLocalCopy(cwd, manifest);
  const doctor = await run(cwd, ["doctor"]);
  assert.equal(doctor.healthy, true);
  assert.equal(doctor.checks.find(({ name }) => name === "website")?.status, "ok");
  await writeFile(checkpointPath, JSON.stringify(manifest), { mode: 0o600 });
  console.log("Initial CLI smoke passed. Publish one edit to " + fixture.changedFile + " in the test dashboard, then run verify.");
}

async function verify(cwd, fixture, manifestPath, checkpointPath) {
  const previous = JSON.parse(await readFile(checkpointPath, "utf8"));
  const identity = await run(cwd, ["whoami"]);
  assert.equal(identity.projectId, previous.projectId, "Use the same test project for both phases.");
  const pull = await run(cwd, ["content", "pull", "--media"]);
  assert.equal(pull.mode, "incremental");
  assert.equal(pull.previousCommit, previous.baseCommit);
  assert.notEqual(pull.baseCommit, previous.baseCommit);
  assert.equal(pull.files, 1);
  assert.equal(pull.entries, 0);
  assert.equal(pull.removed, 0);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const paths = new Set([...Object.keys(previous.files), ...Object.keys(manifest.files)]);
  const modified = [...paths].filter((path) => previous.files[path]?.sha256 !== manifest.files[path]?.sha256);
  assert.deepEqual(modified, [fixture.changedFile], "The incremental pull must update just the edited file.");
  assert.deepEqual(Object.keys(manifest.collections), Object.keys(previous.collections));
  await checkLocalCopy(cwd, manifest);
  console.log("Incremental pull and local content parity passed.");
}

async function prepareDraft(cwd, fixture, checkpoint) {
  const { reviewer, value, publishedValue } = fixture.draftReview ?? {};
  assert(reviewer && value !== undefined && publishedValue !== undefined,
    "Set fixture.draftReview with reviewer, value and expected publishedValue.");
  const identity = await run(cwd, ["whoami"]);
  assert(identity.key.effectiveScopes.includes("content.stage"), "The draft smoke key needs content.stage.");
  await run(cwd, ["content", "pull"]);
  const space = "draft-smoke-" + Date.now();
  await run(cwd, ["space", "create", space]);
  try {
    await run(cwd, ["content", "set", fixture.document + "#" + fixture.pointer, JSON.stringify(value), "--space", space]);
    assert.equal((await run(cwd, ["stage", "push", "--space", space, "--dry-run"])).items.length, 1);
    const push = await run(cwd, ["stage", "push", "--space", space]);
    assert.equal(push.staged, 1);
    assert.equal((await run(cwd, ["stage", "diff", "--space", space])).items.length, 1);
    const preview = await run(cwd, ["stage", "preview", "--space", space, "--wait"]);
    assert(new URL(preview.url).searchParams.has("amaPreviewKey"), "Expected a managed draft preview.");
    await run(cwd, ["stage", "review", "--space", space, "--to", reviewer, "--message", "Review the CLI smoke draft"]);
    await run(cwd, ["stage", "push", "--space", space], { error: "session_in_review", exit: 7 });
    if (process.env.ATMYAPP_CLI_SMOKE_CONTENT_KEY) {
      await run(cwd, ["stage", "ls"], { key: process.env.ATMYAPP_CLI_SMOKE_CONTENT_KEY, error: "missing_scope", exit: 3 });
    }
    await writeFile(checkpoint, JSON.stringify({ projectId: identity.projectId, space, session: push.session.sessionId }), { mode: 0o600 });
    console.log("CLI draft is in review. Edit it to the expected publishedValue and publish in the test dashboard, then run draft-verify.");
  } catch (error) {
    console.error("Draft smoke stopped in local space " + space + ".");
    throw error;
  }
}

async function verifyDraft(cwd, fixture, checkpoint) {
  const { projectId, space } = JSON.parse(await readFile(checkpoint, "utf8"));
  assert.equal((await run(cwd, ["whoami"])).projectId, projectId, "Use the same test project for both phases.");
  await run(cwd, ["content", "pull"]);
  const result = await run(cwd, ["content", "get", fixture.document, "--pointer", fixture.pointer, "--local"]);
  assert.deepEqual(result.value, fixture.draftReview.publishedValue);
  const status = await run(cwd, ["space", "ls"]);
  assert.equal(status.spaces.find(({ name }) => name === space)?.removable, true);
  await run(cwd, ["space", "rm", space]);
  console.log("Reviewer changes arrived in the published copy and the CLI space was cleared.");
}

async function checkAuthoring(cwd, fixture, fixturePath) {
  const spec = fixture.authoring;
  assert(spec && spec.documentAssetRef && spec.galleryAssetRef && spec.binary && spec.locale && spec.translationRef && spec.pointer,
    "Set fixture.authoring with the binary, asset references, locale and translation field.");
  const binary = resolve(fixturePath, "..", spec.binary);
  assert.equal((await stat(binary)).size, 20 * 1024 * 1024, "Use a 20 MiB image for the multipart smoke.");
  assert.equal(typeof spec.translation, "string", "Set fixture.authoring.translation.");
  await run(cwd, ["content", "pull", "--media"]);
  const space = "authoring-" + Date.now();
  await run(cwd, ["space", "create", space]);
  await run(cwd, ["assets", "put", spec.documentAssetRef, binary, "--space", space]);
  await run(cwd, ["assets", "put", spec.galleryAssetRef, binary, "--space", space]);
  const exported = await run(cwd, ["locales", "export", spec.translationRef, "--locale", spec.locale, "--space", space]);
  const segment = exported.segments.find((item) => item.pointer === spec.pointer);
  assert(segment, "The translation fixture did not export the requested segment.");
  const translations = resolve(cwd, space + "-translations.json");
  await writeFile(translations, JSON.stringify({ locale: spec.locale, segments: [{ ...segment, translation: spec.translation }] }), { mode: 0o600 });
  const imported = await run(cwd, ["locales", "import", translations, "--space", space]);
  assert.equal(imported.count, 1);
  assert.equal(imported.outdated.length, 0);
  const plan = await run(cwd, ["stage", "push", "--dry-run", "--space", space]);
  assert(plan.items.length >= 3, "Expected both asset items and a translation.");
  const result = await run(cwd, ["stage", "push", "--space", space]);
  assert(result.operationId && result.session.sessionId, "The staged changes need a named session.");
  assert.equal((await run(cwd, ["stage", "conflicts", "--space", space])).problems.length, 0);
  const preview = await run(cwd, ["stage", "preview", "--wait", "--space", space]);
  assert(new URL(preview.url).searchParams.has("amaPreviewKey"));
  console.log("Preview is ready in local space " + space + ". Check the gallery and translation, then discard the test draft.");
}

async function main() {
  assert(
    ["prepare", "verify", "draft-prepare", "draft-verify", "authoring"].includes(phase) && fixtureFile && workDir,
    "Usage: node packages/cli/scripts/live-smoke.mjs <prepare|verify|draft-prepare|draft-verify|authoring> <fixture.json> <scratch-dir>",
  );
  const fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
  const cwd = resolve(workDir);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  if (phase === "authoring") return checkAuthoring(cwd, fixture, resolve(fixtureFile));
  if (phase.startsWith("draft-")) {
    assert(typeof fixture.document === "string" && typeof fixture.pointer === "string", "Set fixture.document and fixture.pointer.");
    const checkpoint = resolve(cwd, "draft-smoke-checkpoint.json");
    return (phase === "draft-prepare" ? prepareDraft : verifyDraft)(cwd, fixture, checkpoint);
  }
  for (const name of ["document", "pointer", "largeDocument", "collection", "locale", "changedFile"]) {
    assert(typeof fixture[name] === "string" && fixture[name], "Set fixture." + name);
  }
  for (const kind of ["entry:", "doc:", "file:"]) {
    assert(fixture.assets?.some(({ ref, mimeType }) => ref.startsWith(kind) && mimeType), "Set fixture.assets for " + kind);
  }
  const manifestPath = resolve(cwd, ".ama/content/published/manifest.json");
  const checkpointPath = resolve(cwd, "smoke-checkpoint.json");
  await (phase === "prepare" ? prepare : verify)(cwd, fixture, manifestPath, checkpointPath);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
