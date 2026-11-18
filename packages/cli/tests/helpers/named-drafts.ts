import { entryAssetId, keyPart } from "../../src/runtime/assetDrafts";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { defineCollection, defineDocument, defineSchema, s } from "@atmyapp/structure";
import { ApiClient } from "../../src/runtime/api";
import { serverItemKey, type CompiledOperation } from "../../src/runtime/compile";
import { contentFingerprint, sha256Hex } from "../../src/runtime/fingerprint";
import { createSpace } from "../../src/runtime/spaces";
import { ContentStore, emptyManifest } from "../../src/runtime/store";
import { WorkingCopy } from "../../src/runtime/workingCopy";

export const draftProject = "draft-project";

export function draftFixture(cwd: string) {
  const store = new ContentStore(cwd);
  const schema = defineSchema({
    localization: { enabled: true },
    definitions: {
      home: defineDocument({
        localize: true,
        fields: {
          title: s.string({ localize: true }),
          hero: s.image({ optional: true }),
          blocks: s.array({ items: s.object({ fields: { heading: s.string({ localize: true }) } }) }),
        },
      }),
      about: defineDocument({ fields: { title: s.string() } }),
      posts: defineCollection({ fields: { title: s.string(), order: s.order(), gallery: s.array({ optional: true, items: s.image() }) } }),
    },
  });
  const manifest = emptyManifest({ projectId: draftProject, branch: "main" });
  manifest.baseCommit = "git-1";
  manifest.localization = { defaultLocale: "en", supportedLocales: ["en", "pl"] };
  for (const [name, value] of Object.entries({
    "home.json": { title: "Old homepage", blocks: [{ _key: "n_existing", heading: "Original block" }] },
    "about.json": { title: "About" },
    "notes.txt": "Original notes",
  })) {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
    manifest.files[name] = {
      kind: typeof value === "string" ? "file" : "document",
      definition: typeof value === "string" ? null : name.slice(0, -5),
      mimeType: typeof value === "string" ? "text/plain" : "application/json",
      size: bytes.length,
      downloaded: true,
      sha256: store.writePublishedFile(name, bytes, true),
      fingerprint: contentFingerprint("file", value),
    };
  }
  manifest.collections.posts = { entries: {} };
  for (const id of ["first", "second", "obsolete"]) {
    const data = { title: id, order: 1024 * (Object.keys(manifest.collections.posts.entries).length + 1) };
    const sha256 = store.writeJson(store.entryPath("posts", id), { id, data });
    manifest.collections.posts.entries[id] = { sha256, fingerprint: contentFingerprint("entry", data) };
  }
  store.writeManifest(manifest);
  store.writeSchema(schema);
  createSpace(store, "release");
  const work = new WorkingCopy(store, "release");
  const newFile = path.join(store.collectionDir("posts", "release"), "_new", "article.json");
  const createUntracked = () => {
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    fs.writeFileSync(newFile, JSON.stringify({ title: "New article" }));
  };
  return { work, store, manifest, newFile, createUntracked };
}

type FakeItem = {
  itemKey: string;
  itemRevision: number;
  identity: { kind: string; path?: string; collectionName?: string; entryId?: string; locale?: string };
  desired: { type: "upsert" | "delete"; data?: unknown; value?: { valueId: string; encoding?: "utf-8" | "base64" } };
};
type FakeStatus = {
  state: "saved" | "blocked" | "cancelled";
  receipt?: { sessionRevision: number; items: FakeItem[] };
  pollAfterMs: number;
  lastFailure?: { code: string; message: string };
};

export class FakeDraftApi {
  id = "";
  reviewState = "open";
  status: "active" | "committed" | "expired" = "active";
  creates = 0;
  writes: Array<{ operations: CompiledOperation[]; operationId: string; stepId: string }> = [];
  items = new Map<string, FakeItem>();
  saves = new Map<string, FakeStatus>();
  values = new Map<string, string | Buffer>();
  uploads = new Map<string, { size: number; partSize: number; parts: Map<number, Buffer> }>();
  uploadedParts: number[] = [];
  interruptUploadAfter?: number;
  interrupt = false;
  nextRevision = 0;

  readonly client = new ApiClient(
    { url: "https://api.example.test", projectId: draftProject, token: "test-key" },
    {
      fetch: (async (url: string, init?: RequestInit) => this.request(url, init ?? {})) as typeof fetch,
    },
  );

  session() {
    return {
      sessionId: this.id,
      name: "release",
      status: this.status,
      reviewState: this.reviewState,
      owner: { kind: "key", userId: "author", displayName: "Author via key Writer", keyId: "key" },
      itemCount: this.items.size,
      sessionRevision: this.nextRevision,
      createdAt: "2026-11-18T10:00:00Z",
      expiresAt: "2026-11-25T10:00:00Z",
      items: [...this.items.values()],
    };
  }

  async request(url: string, init: RequestInit) {
    const route = new URL(url).pathname.split("/").slice(4).join("/");
    const scope = new URL(url).searchParams;
    const body = init.method === "PUT" ? { scope: { sessionId: scope.get("sessionId") } }
      : init.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (data: unknown) => Response.json({ success: true, data });
    const error = (status: number, code: string) => Response.json({ success: false, code, error: code }, { status });
    if (route === "members")
      return ok([{ userId: "editor", name: "Editor", email: "editor@example.test", via: "member", roles: ["editor"] }]);
    if (route === "staging/named") {
      if (init.method === "GET") return ok(this.id && this.status === "active" ? [this.session()] : []);
      this.creates++;
      this.id = "ns_" + randomUUID();
      this.reviewState = "open";
      this.status = "active";
      this.items.clear();
      return ok(this.session());
    }
    if (route.startsWith("staging/named/")) {
      const [, , id, action] = route.split("/");
      if (this.id !== id || this.status === "expired") return error(410, "named_session_gone");
      if (!action) return ok(this.session());
      if (action === "review") {
        this.reviewState = "in_review";
        expect(body.reviewerUserId).toBe("editor");
        return ok(this.session());
      }
      if (action === "preview")
        return ok({ url: "https://preview.example.test/?amaPreviewKey=fixture", mode: "devserver" });
      if (action === "diff")
        return ok({
          items: [...this.items.values()].map((item) => ({
            itemKey: item.itemKey,
            change: item.desired.type === "delete" ? "deleted" : "modified",
            fields: [],
          })),
        });
      if (action === "discard") {
        this.status = "expired";
        return ok({ discarded: true });
      }
      if (action === "extend") return ok(this.session());
    }
    if (body?.scope?.sessionId !== this.id) return error(410, "named_session_gone");
    if (route === "staging/read") {
      const item = this.items.get(body.itemKey);
      if (item?.itemRevision !== body.itemRevision) return error(409, "staged-version-conflict");
      const value = this.values.get(item?.desired.value?.valueId ?? "");
      return new Response(Buffer.isBuffer(value) ? new Uint8Array(value).buffer : value, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (this.reviewState === "in_review") return error(409, "session_in_review");
    const saveValue = (bytes: Buffer | string, mimeType: string, encoding?: "base64" | "utf-8") => {
      const sha256 = sha256Hex(bytes);
      const valueId = "v_" + sha256;
      this.values.set(valueId, bytes);
      return ok({ valueId, sha256, size: Buffer.byteLength(bytes), mimeType, encoding });
    };
    if (route === "staging/conflicts") return ok({ problems: [], sessionRevision: this.nextRevision, headSha: "git-2" });
    if (route === "staging/values/inline") {
      return saveValue(body.encoding === "base64" ? Buffer.from(body.content, "base64") : body.content, body.mimeType, body.encoding);
    }
    if (route === "staging/uploads") {
      const intentId = randomUUID();
      this.uploads.set(intentId, { size: body.expectedSize, partSize: body.partSize, parts: new Map() });
      return ok({ intentId, multipart: true, expectedSize: body.expectedSize, partSize: body.partSize });
    }
    if (route.startsWith("staging/uploads/")) {
      const [, , id, action, part] = route.split("/");
      const upload = this.uploads.get(id);
      if (!upload) return error(404, "upload-not-found");
      if (action === "finalize") {
        const bytes = Buffer.concat([...upload.parts].sort(([a], [b]) => a - b).map(([, bytes]) => bytes));
        if (bytes.length !== upload.size) return error(409, "upload-incomplete");
        return saveValue(bytes, "image/png");
      }
      if (init.method === "PUT") {
        const index = Number(part);
        const bytes = Buffer.from(init.body as ArrayBuffer);
        upload.parts.set(index, bytes);
        this.uploadedParts.push(bytes.length);
        if (index === this.interruptUploadAfter) {
          this.interruptUploadAfter = undefined;
          throw new TypeError("Upload reply was lost");
        }
        return ok({});
      }
    }
    if (route === "staging/v2/operation-status") return ok(this.saves.get(body.operationId) ?? null);
    if (route === "staging/v2/cancel-operation") {
      const status = { state: "cancelled", pollAfterMs: 0 } as const;
      this.saves.set(body.operationId, status);
      return ok(status);
    }
    if (route === "staging/v2/submit") {
      if (this.saves.has(body.operationId)) return ok(this.saves.get(body.operationId));
      const operations = body.operations as CompiledOperation[];
      this.writes.push(body);
      const changed = operations.map(({ operation, expectedVersion }) => {
        const locale = "locale" in operation ? operation.locale : undefined;
        const ref = "collectionName" in operation
          ? { kind: "entry" as const, name: operation.collectionName, entryId: operation.entryId, locale }
          : { kind: operation.type === "putPublicAsset" || operation.type === "deletePublicAsset" ? "public" as const : "file" as const,
              name: "documentPath" in operation ? operation.documentPath : operation.path, locale };
        let itemKey = serverItemKey(ref, operation.type);
        if (operation.type === "replaceDocumentAsset")
          itemKey = ["documentAsset", keyPart(operation.documentPath), keyPart(operation.assetPath)].join("|");
        if (operation.type === "addEntryBlob" || operation.type === "replaceEntryBlob") {
          const id = operation.type === "replaceEntryBlob" ? operation.blobId :
            entryAssetId(operation.collectionName, operation.entryId, operation.fieldName, operation.value.sha256, operation.value.mimeType ?? "");
          itemKey = ["entryBlob", keyPart(operation.collectionName), keyPart(id)].join("|");
        }
        const current = this.items.get(itemKey);
        if ((current?.itemRevision ?? 0) !== expectedVersion) return null;
        const kind = operation.type === "replaceDocumentAsset" ? "documentAsset"
          : operation.type.endsWith("Document") ? "document"
          : operation.type.endsWith("EntryBlob") ? "entryBlob"
          : "collectionName" in operation ? "entry" : ref.kind === "public" ? "publicAsset" : "file";
        const identity: FakeItem["identity"] = ref.kind === "entry"
          ? { kind, collectionName: ref.name, entryId: ref.entryId, locale }
          : { kind, path: ref.name, locale };
        const desired: FakeItem["desired"] = operation.type === "upsertEntry"
          ? { type: "upsert", data: operation.data }
          : operation.type === "putDocument" ? { type: "upsert", data: operation.content }
          : "value" in operation ? { type: "upsert", value: operation.value } : { type: "delete" };
        return { itemKey, identity, desired, itemRevision: ++this.nextRevision };
      });
      if (changed.some((item) => !item)) {
        const status: FakeStatus = {
          state: "blocked",
          pollAfterMs: 0,
          lastFailure: { code: "staged-version-conflict", message: "The item changed" },
        };
        this.saves.set(body.operationId, status);
        return ok(status);
      }
      const items = changed as FakeItem[];
      for (const item of items) this.items.set(item.itemKey, item);
      const status: FakeStatus = {
        state: "saved",
        receipt: { items, sessionRevision: this.nextRevision },
        pollAfterMs: 0,
      };
      this.saves.set(body.operationId, status);
      if (this.interrupt) {
        this.interrupt = false;
        throw new Error("Lost the submit response");
      }
      return ok(status);
    }
    throw new Error("Unexpected fixture URL " + route);
  }
}
