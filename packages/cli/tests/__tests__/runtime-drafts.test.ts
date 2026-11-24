import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertDraftValid, compileDraft, INLINE_LIMIT, serverItemKey, stageBatches } from "../../src/runtime/compile";
import { editEntry, moveEntry } from "../../src/runtime/entryDrafts";
import { EXIT } from "../../src/runtime/errors";
import { ApiClient } from "../../src/runtime/api";
import { pullContent } from "../../src/runtime/pull";
import { contentFingerprint, sha256Hex } from "../../src/runtime/fingerprint";
import { applyJsonPatch } from "../../src/runtime/jsonPatch";
import {
  discardStage,
  pullSession,
  push,
  reconcilePublishedSpaces,
  requestReview,
  stageDiff,
  stagePreview,
  stageStatus,
} from "../../src/runtime/sessions";
import { collectUnusedObjects, createSpace, currentSpace, readSpace, useSpace } from "../../src/runtime/spaces";
import { editLocalContent, grepSpace, WorkingCopy, workingState } from "../../src/runtime/workingCopy";
import { draftFixture, FakeDraftApi } from "../helpers/named-drafts";

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-drafts-"));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("spaces branch from local changes, protect referenced objects, and select .current", async () => {
  const { work, store } = draftFixture(cwd);
  const [a, b] = [store.putObject("unused"), store.putObject("old-base")];
  const local = await editLocalContent({
    work,
    ref: "doc:home",
    edit: (value) => ({ ...(value as object), title: "Łucja Żółć" }),
  });
  useSpace(store, "release");
  expect(currentSpace(store)).toBe("release");
  expect(readSpace(store, "release").items["file:home.json"].base.sha256).toBeTruthy();
  createSpace(store, "copy", { from: "release" });
  const copy = new WorkingCopy(store, "copy");
  expect(copy.itemStates()[0].state).toBe("modified");
  expect(grepSpace(copy, "lucja zolc").matches).toMatchObject([{ ref: "doc:home.json", pointer: "/title" }]);
  expect(fs.existsSync(local.file)).toBe(true);
  expect(collectUnusedObjects(store, true)).toMatchObject({ objects: 2, dryRun: true });
  expect(fs.existsSync(store.objectPath(a))).toBe(true);
  collectUnusedObjects(store);
  expect(fs.existsSync(store.objectPath(a))).toBe(false);
  expect(fs.existsSync(store.objectPath(b))).toBe(false);
});

test("content operations compile with published baselines, normalized keys and bounded batches", async () => {
  const { work, store } = draftFixture(cwd);
  await editLocalContent({
    work,
    ref: "doc:home",
    edit: () => ({ title: "Home", blocks: [{ _key: "n_existing", heading: "Original block" }, { heading: "New" }] }),
  });
  await editLocalContent({ work, ref: "doc:about", remove: true });
  await editLocalContent({ work, ref: "doc:home@pl", edit: () => ({ title: "Dom" }) });
  await editLocalContent({ work, ref: "file:notes.txt", edit: () => "Changed" });
  await editLocalContent({ work, ref: "file:old.txt", edit: () => "Temporary" });
  await editLocalContent({ work, ref: "file:old.txt", remove: true });
  await editEntry({ work, collection: "posts", entryId: "first", data: { title: "Edited" } });
  await editEntry({ work, collection: "posts", entryId: "obsolete", remove: true });
  await moveEntry({
    work,
    collection: "posts",
    entryId: "second",
    placement: { position: "before", entryId: "first" },
  });
  const compiled = compileDraft(
    work,
    work.itemStates().filter((item) => item.state !== "published"),
  );
  expect(compiled.issues.filter((issue) => issue.severity === "hard")).toEqual([]);
  assertDraftValid(compiled.issues);
  expect(compiled.items.map((item) => item.operation.operation.type)).toEqual(
    expect.arrayContaining(["putDocument", "deleteDocument", "writeFile", "upsertEntry", "deleteEntry"]),
  );
  expect(compiled.items.find((item) => item.key === "file:home.json")).toMatchObject({
    operation: {
      operation: {
        content: {
          blocks: [
            { _key: "n_existing", heading: "Original block" },
            expect.objectContaining({ _key: expect.stringMatching(/^n_/) }),
          ],
        },
      },
      expectedBase: { exists: true, sha256: expect.stringMatching(/^[\da-f]{64}$/) },
    },
  });
  expect(compiled.items.find((item) => item.key === "entry:posts:second")).toMatchObject({
    operation: { operation: { moveOnly: true, placements: { order: { position: "before", entryId: "first" } } } },
  });
  expect(serverItemKey({ kind: "file", name: "żółć" })).toBe("file|8:żółć|-");
  const text = compiled.items.find((item) => item.key === "file:notes.txt")!;
  expect(stageBatches(Array(101).fill(text)).map((batch) => batch.length)).toEqual([100, 1]);
  expect(
    stageBatches(
      Array(3).fill({ ...text, upload: { content: "x".repeat(INLINE_LIMIT / 2), size: INLINE_LIMIT / 2, sha256: "fixture", mimeType: "text/plain" } }),
    ).map((batch) => batch.length),
  ).toEqual([2, 1]);
  expect(readSpace(store, "release").session).toBeNull();
});

test("resumes an accepted push with stable IDs, previews, imports reviewer edits and clears published changes", async () => {
  const { work, store, newFile, createUntracked, manifest } = draftFixture(cwd);
  createUntracked();
  await editLocalContent({
    work,
    ref: "doc:home",
    edit: () => ({
      title: "Homepage draft",
      blocks: [{ _key: "n_existing", heading: "Original block" }, { heading: "Something new" }],
    }),
  });
  await editLocalContent({ work, ref: "doc:about", edit: () => ({ title: "About draft" }) });
  await editLocalContent({ work, ref: "file:notes.txt", edit: () => "Draft notes" });
  await editEntry({ work, collection: "posts", entryId: "first", data: { title: "First draft" } });
  await editEntry({ work, collection: "posts", entryId: "second", data: { title: "Second draft" }, replace: true });
  const api = new FakeDraftApi();
  expect(await push(work, undefined, { dryRun: true })).toMatchObject({
    dryRun: true,
    items: expect.any(Array),
    batches: 1,
  });
  expect(readSpace(store, "release").session).toBeNull();
  expect(fs.existsSync(newFile)).toBe(true);
  api.interrupt = true;
  await expect(push(work, api.client, { operationId: "cli-retry" })).rejects.toMatchObject({ code: "network" });
  const saved = readSpace(store, "release");
  expect((await stageStatus(work)).operationId).toBe("cli-retry");
  await expect(pullSession(api.client, work)).rejects.toMatchObject({ code: "pending_push" });
  const entryId = Object.values(saved.items).find((item) => item.newFile)?.ref?.entryId;
  expect(entryId).toMatch(/^[0-9a-f-]{36}$/);
  expect(fs.existsSync(newFile)).toBe(true);
  expect(await push(work, api.client, { operationId: "cli-retry" })).toMatchObject({
    operationId: "cli-retry",
    staged: 6,
  });
  expect(api.writes).toHaveLength(1);
  expect(fs.existsSync(newFile)).toBe(false);
  expect(fs.existsSync(store.entryPath("posts", entryId!, "release"))).toBe(true);
  expect(work.value(work.itemStates().find((item) => item.key === "file:home.json")!)).toMatchObject({
    blocks: [
      { heading: "Original block", _key: "n_existing" },
      { heading: "Something new", _key: expect.any(String) },
    ],
  });
  expect((await stageStatus(work, api.client)).items.every((item) => item.state === "staged")).toBe(true);
  expect((await stageDiff(api.client, work)).items).toHaveLength(6);
  const previewStatus = jest.fn(async (input: string | URL | Request) => {
    expect(String(input)).toBe("https://preview.example.test/.well-known/atmyapp/preview/status?amaPreviewKey=fixture");
    return new Response(JSON.stringify({ status: "starting" }), { status: 200 });
  });
  expect(await stagePreview(api.client, work, { fetch: previewStatus as typeof fetch })).toMatchObject({
    url: expect.stringContaining("amaPreviewKey"),
    state: "starting",
    ready: false,
  });
  expect(await requestReview(api.client, work, "editor@example.test", "Review")).toMatchObject({
    session: { reviewState: "in_review" },
  });
  await expect(push(work, api.client)).rejects.toMatchObject({ code: "session_in_review", exitCode: EXIT.session });
  const item = api.items.get("document|9:home.json")!;
  item.desired = { type: "upsert", data: { title: "Reviewer title", blocks: [] } };
  item.itemRevision++;
  const notes = api.items.get("file|9:notes.txt|-")!;
  api.values.set(notes.desired.value!.valueId, "Reviewer notes");
  notes.itemRevision++;
  expect((await pullSession(api.client, work)).items).toContain("doc:home.json");
  expect(fs.readFileSync(work.filename({ kind: "doc", name: "home.json" }), "utf8")).toContain("Reviewer title");
  expect(fs.readFileSync(work.filename({ kind: "file", name: "notes.txt" }), "utf8")).toBe("Reviewer notes");
  api.status = "committed";
  manifest.baseCommit = "git-2";
  store.writeManifest(manifest);
  await reconcilePublishedSpaces(api.client, store);
  expect(work.itemStates()).toEqual([]);
  expect(readSpace(store, "release").session).toBeNull();
});

test("recreates an expired draft and reports a stale reviewer edit with the current item", async () => {
  const { work, store } = draftFixture(cwd);
  const api = new FakeDraftApi();
  const edit = (title: string) => editLocalContent({ work, ref: "doc:about", edit: () => ({ title }) });
  await edit("First draft");
  await push(work, api.client);
  const old = api.id;
  api.status = "expired";
  await expect(stageStatus(work, api.client)).rejects.toMatchObject({ code: "session_expired", exitCode: 7 });
  await push(work, api.client);
  expect(api.id).not.toBe(old);
  expect(api.creates).toBe(2);
  const item = api.items.get("document|10:about.json")!;
  item.itemRevision++;
  await edit("Local edit");
  await expect(push(work, api.client)).rejects.toMatchObject({
    code: "staged_version_conflict",
    exitCode: 5,
    details: { current: [{ itemKey: item.itemKey, itemRevision: item.itemRevision }] },
  });
  expect(readSpace(store, "release").lastPushOperationId).toBeUndefined();
  await expect(pullSession(api.client, work)).rejects.toMatchObject({ code: "conflict" });
  expect((await discardStage(api.client, work)).discarded).toBe(true);
  expect(fs.readFileSync(work.filename({ kind: "doc", name: "about.json" }), "utf8")).toContain("Local edit");
});

test("working states distinguish clean pulls, stale changes, new items, deletions and receipts", () => {
  const stored = { sha256: sha256Hex("old"), fingerprint: "original", commit: "c1" };
  const changed = { ...stored, fingerprint: "new" };
  const input = { base: stored, published: stored, sha256: stored.sha256, local: true, deleted: false };
  const receipt = { itemRevision: 1, at: "now", sha256: stored.sha256 };
  expect(workingState(input)).toBe("published");
  expect(workingState({ ...input, published: changed })).toBe("remote-changed");
  expect(workingState({ ...input, published: changed, sha256: "edit" })).toBe("conflict");
  expect(workingState({ ...input, sha256: "edit" })).toBe("modified");
  expect(workingState({ ...input, deleted: true })).toBe("deleted");
  expect(workingState({ ...input, staged: receipt })).toBe("staged");
  expect(workingState({ ...input, staged: receipt, sha256: "edit" })).toBe("staged+modified");
  expect(
    workingState({
      ...input,
      base: { ...stored, sha256: null, fingerprint: null },
      published: { ...stored, sha256: null, fingerprint: null },
    }),
  ).toBe("new");
});

test("JSON Patch supports escaped paths, arrays, copying and moving atomically", () => {
  const source = { "": "empty", "x/y": [1, 2], copy: {} };
  const patch = [
    { op: "test", path: "/", value: "empty" },
    { op: "add", path: "/x~1y/-", value: 3 },
    { op: "copy", from: "/x~1y/1", path: "/copy/picked" },
    { op: "move", from: "/x~1y/0", path: "/x~1y/1" },
    { op: "replace", path: "/", value: "changed" },
    { op: "remove", path: "/x~1y/2" },
  ];
  expect(applyJsonPatch(source, patch)).toEqual({ "": "changed", "x/y": [2, 1], copy: { picked: 2 } });
  expect(() => applyJsonPatch(source, [...patch, { op: "test", path: "/copy/picked", value: 1 }])).toThrow(
    "test did not match",
  );
  expect(source).toEqual({ "": "empty", "x/y": [1, 2], copy: {} });
});

test.each([true, false])("protects draft spaces when switching projects (full=%s)", async (full) => {
  const { work, store, manifest } = draftFixture(cwd);
  const fetch = jest.fn();
  const original = new FakeDraftApi().client;
  manifest.projectBase = original.projectBase;
  store.writeManifest(manifest);
  const { file } = await editLocalContent({ work, ref: "doc:about", edit: () => ({ title: "Keep this draft" }) });
  for (const session of [
    { ...original.session, projectId: "other-project" },
    { ...original.session, url: "https://another.example.test" },
  ]) {
    const other = new ApiClient(session, { fetch });
    await expect(pullContent(other, { full }, cwd)).rejects.toMatchObject({ code: "project_mismatch" });
    await expect(push(new WorkingCopy(store, "release"), other)).rejects.toMatchObject({ code: "project_mismatch" });
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(store.readManifest()).toEqual(manifest);
  expect(fs.readFileSync(file, "utf8")).toContain("Keep this draft");
});

test("preserves receipts when an active draft matches published content or cannot be read", async () => {
  const { work, store, manifest } = draftFixture(cwd);
  const api = new FakeDraftApi();
  const data = { title: "Matching draft" };
  await editLocalContent({ work, ref: "doc:about", edit: () => data });
  await push(work, api.client);
  manifest.files["about.json"].fingerprint = contentFingerprint("file", data);
  store.writeManifest(manifest);
  const original = readSpace(store, "release");
  await reconcilePublishedSpaces(api.client, store);
  expect(readSpace(store, "release")).toEqual(original);
  jest.spyOn(api, "request").mockRejectedValueOnce(new TypeError("offline"));
  await reconcilePublishedSpaces(api.client, store);
  expect(readSpace(store, "release")).toEqual(original);
});

test("imports reviewer removals without resurrecting them and preserves later edits", async () => {
  const { work } = draftFixture(cwd);
  const api = new FakeDraftApi();
  await editLocalContent({ work, ref: "doc:about", remove: true });
  await editLocalContent({ work, ref: "file:notes.txt", edit: () => "Initial notes" });
  await editEntry({ work, collection: "posts", entryId: "first", data: { title: "First edit" } });
  await push(work, api.client);
  const first = api.items.get("entry|5:posts|5:first|-")!;
  await editEntry({ work, collection: "posts", entryId: "first", data: { title: "Second edit" } });
  await editLocalContent({ work, ref: "file:notes.txt", edit: () => "Keep my notes" });
  api.items.clear();
  api.items.set(first.itemKey, first);
  await pullSession(api.client, work);
  const remaining = work.itemStates();
  expect(remaining.map((item) => [item.key, item.state])).toEqual([
    ["entry:posts:first", "staged+modified"], ["file:notes.txt", "modified"],
  ]);
  expect(work.value(remaining[0])).toMatchObject({ title: "Second edit" });
  expect(work.value(remaining[1])).toBe("Keep my notes");
  expect((await push(work, api.client)).staged).toBe(2);
});

test("an interrupted journal write can retry the same operation ID", async () => {
  const { work, store } = draftFixture(cwd);
  const api = new FakeDraftApi();
  await editLocalContent({ work, ref: "doc:about", edit: () => ({ title: "Retry" }) });
  const write = store.writeJson.bind(store);
  const spy = jest.spyOn(store, "writeJson").mockImplementation((file, data, object) => {
    if (file.endsWith(".push.json")) throw new Error("Disk full");
    return write(file, data, object);
  });
  await expect(push(work, api.client, { operationId: "retry" })).rejects.toThrow("Disk full");
  spy.mockRestore();
  expect(api.writes).toHaveLength(0);
  expect(await push(work, api.client, { operationId: "retry" })).toMatchObject({ staged: 1 });
  expect(await push(work, api.client, { operationId: "retry" })).toMatchObject({ staged: 0 });
  expect(api.creates).toBe(1);
  expect(api.writes).toHaveLength(1);
});

test("retains replacement semantics when a field is removed between entry merges", async () => {
  const { work } = draftFixture(cwd);
  await editEntry({ work, collection: "posts", entryId: "first", data: { title: "Revised" } });
  await editLocalContent({ work, ref: "entry:posts/first", edit: (value) =>
    applyJsonPatch(value, [{ op: "remove", path: "/order" }]),
  });
  await editEntry({ work, collection: "posts", entryId: "first", data: { title: "Final" } });
  const compiled = compileDraft(work, work.itemStates());
  expect(compiled.items[0].operation.operation).toMatchObject({ data: { title: "Final" }, replaceData: true });
  expect(compiled.items[0].operation.operation).not.toHaveProperty("data.order");
});
