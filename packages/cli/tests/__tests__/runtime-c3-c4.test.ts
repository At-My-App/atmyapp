import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { putDraftAsset, putDraftFile } from "../../src/runtime/assetDrafts";
import { compileDraft } from "../../src/runtime/compile";
import { contentFingerprint } from "../../src/runtime/fingerprint";
import { editTranslation, exportSegments, importSegments, outdatedTranslations } from "../../src/runtime/locales";
import { mergeSpace } from "../../src/runtime/refresh";
import { push, stageConflicts } from "../../src/runtime/sessions";
import { readSpace } from "../../src/runtime/spaces";
import { editLocalContent, WorkingCopy } from "../../src/runtime/workingCopy";
import { draftFixture, FakeDraftApi } from "../helpers/named-drafts";

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-c34-"));
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

test("refresh merges a dashboard edit and fences a re-stage at both revisions", async () => {
  const { work, store, manifest } = draftFixture(cwd);
  const api = new FakeDraftApi();
  await editLocalContent({ work, ref: "doc:home", edit: (value) => ({ ...(value as object), title: "Local title" }) });
  await push(work, api.client);
  const saved = readSpace(store, "release").items["file:home.json"].staged!;
  const updated = { title: "Old homepage", blocks: [{ _key: "n_existing", heading: "Saved in dashboard" }] };
  const raw = Buffer.from(JSON.stringify(updated));
  manifest.files["home.json"].sha256 = store.writePublishedFile("home.json", raw, true);
  manifest.files["home.json"].fingerprint = contentFingerprint("file", updated);
  manifest.baseCommit = "git-2";
  store.writeManifest(manifest);

  const next = new WorkingCopy(store, "release");
  expect(await mergeSpace(next, { refs: ["doc:home"] })).toMatchObject({ updated: ["doc:home.json"], conflicts: [] });
  const local = next.itemStates().find((item) => item.ref.name === "home.json")!;
  expect(next.value(local)).toEqual({ ...updated, title: "Local title" });
  expect(local.state).toBe("modified");
  await push(next, api.client);
  expect(api.writes[1].operations[0]).toMatchObject({
    expectedVersion: saved.itemRevision,
    expectedBase: { exists: true, sha256: manifest.files["home.json"].fingerprint },
    rebase: true,
  });
  expect(await stageConflicts(api.client, next)).toMatchObject({ problems: [] });
});

test("multipart image push resumes the same intent with immutable bytes and replaces a gallery item", async () => {
  const { work, store, manifest } = draftFixture(cwd);
  const large = path.join(cwd, "cover.png");
  const size = 20 * 1024 * 1024;
  fs.writeFileSync(large, Buffer.alloc(size, 63));
  await putDraftAsset(work, "doc:home#/hero", large, { alt: "Cover" });
  const first = { title: "first", order: 1024, gallery: ["gcb_existing"] };
  const entry = store.entryPath("posts", "first");
  manifest.collections.posts.entries.first = {
    sha256: store.writeJson(entry, { id: "first", data: first }),
    fingerprint: contentFingerprint("entry", first),
  };
  store.writeManifest(manifest);
  const fresh = new WorkingCopy(store, "release");
  const small = path.join(cwd, "gallery.png");
  fs.writeFileSync(small, Buffer.from([0, 1, 2, 3]));
  await putDraftAsset(fresh, "entry:posts/first#/gallery/0", small, {});
  await putDraftFile(fresh, "public:logos/test.png", small);
  const api = new FakeDraftApi();
  api.interruptUploadAfter = 2;
  await expect(push(fresh, api.client, { operationId: "fixture-upload" })).rejects.toMatchObject({ code: "network" });
  await push(fresh, api.client, { operationId: "fixture-upload" });
  expect(api.uploads.size).toBe(1);
  expect(api.uploadedParts).toEqual([8, 8, 8, 4].map((mb) => mb * 1024 * 1024));
  expect(api.writes.flatMap(({ operations }) => operations).map(({ operation }) => operation)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "replaceDocumentAsset",
        metadata: expect.objectContaining({ alt: "Cover" }),
        value: expect.objectContaining({ size }),
      }),
      expect.objectContaining({ type: "replaceEntryBlob", fieldName: "gallery.0", blobId: "gcb_existing" }),
      expect.objectContaining({ type: "putPublicAsset", path: "logos/test.png" }),
    ]),
  );
});

test("segment round trip retains array identities and rejects a stale source segment", async () => {
  const { work } = draftFixture(cwd);
  const exported = exportSegments(work, { locale: "pl", refs: ["doc:home"], space: true });
  expect(exported.segments.map(({ pointer }) => pointer)).toEqual(["/title", "/blocks/_key=n_existing/heading"]);
  await editLocalContent({
    work,
    ref: "doc:home",
    edit: (source) => ({ ...(source as object), title: "Changed source" }),
  });
  const edited = {
    ...exported,
    segments: exported.segments.map((segment) => ({ ...segment, translation: "Po polsku" })),
  };
  expect(await importSegments(work, edited)).toMatchObject({ count: 1, outdated: [{ pointer: "/title" }] });
  const translation = work.describe("doc:home@pl");
  expect(work.variant(translation)).toMatchObject({
    data: { blocks: [{ _key: "n_existing", heading: "Po polsku" }] },
    sourceHashes: { "content.blocks[_key=n_existing].heading": '"Original block"' },
  });
  const compiled = compileDraft(
    work,
    work.itemStates().filter((item) => item.ref.locale),
  );
  expect(compiled.issues).toEqual([]);
  expect(compiled.items[0].operation.operation).toMatchObject({
    type: "writeFile",
    locale: "pl",
    translationSources: { "content.blocks[_key=n_existing].heading": '"Original block"' },
  });
  expect(exportSegments(work, { locale: "pl", refs: ["doc:home"], space: true }).segments[1].status).toBe("current");
});

test("the merged translation editor rejects identity changes and reports later source edits", async () => {
  const { work, store } = draftFixture(cwd);
  const edit = await editTranslation(work, "doc:home", { locale: "pl" });
  const original = JSON.parse(fs.readFileSync(edit.file, "utf8"));
  expect(original).toMatchObject({ title: "Old homepage" });
  store.writeJson(edit.file, { ...original, blocks: [{ _key: "unknown", heading: "New" }] }, false);
  await expect(editTranslation(work, "doc:home@pl", { save: true })).rejects.toMatchObject({ code: "not_localizable" });
  store.writeJson(edit.file, { ...original, title: "Dom" }, false);
  await editTranslation(work, "doc:home@pl", { save: true });
  expect(work.variant(work.describe("doc:home@pl"))?.data).toEqual({ title: "Dom" });
  await editLocalContent({ work, ref: "doc:home", edit: () => ({ ...original, title: "New source" }) });
  expect(outdatedTranslations(work)).toEqual([{ ref: "doc:home.json", locales: ["pl"] }]);
  expect(
    exportSegments(work, { locale: "pl", space: true, statuses: ["outdated"] }).segments.map(({ pointer }) => pointer),
  ).toEqual(["/title"]);
});

test("an import with only stale source hashes leaves the variant untouched", async () => {
  const { work } = draftFixture(cwd);
  const exported = exportSegments(work, { locale: "pl", refs: ["doc:home"], space: true });
  const title = exported.segments.find((segment) => segment.pointer === "/title")!;
  await editLocalContent({ work, ref: "doc:home", edit: (value) => ({ ...(value as object), title: "New source" }) });
  expect(await importSegments(work, { ...exported, segments: [{ ...title, translation: "Dom" }] })).toMatchObject({
    count: 0,
    outdated: [{ pointer: "/title" }],
  });
  expect(work.variant(work.describe("doc:home@pl"))).toBeUndefined();
});
