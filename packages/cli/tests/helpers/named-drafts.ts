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
          blocks: s.array({ items: s.object({ fields: { heading: s.string() } }) }),
        },
      }),
      about: defineDocument({ fields: { title: s.string() } }),
      posts: defineCollection({ fields: { title: s.string(), order: s.order() } }),
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
  values = new Map<string, string>();
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
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
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
      return new Response(this.values.get(item?.desired.value?.valueId ?? ""), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (this.reviewState === "in_review") return error(409, "session_in_review");
    if (route === "staging/values/inline") {
      const sha256 = sha256Hex(body.content);
      const valueId = "v_" + sha256;
      this.values.set(valueId, body.content);
      return ok({ valueId, sha256, size: Buffer.byteLength(body.content), mimeType: body.mimeType, encoding: "utf-8" });
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
        const ref =
          "collectionName" in operation
            ? { kind: "entry" as const, name: operation.collectionName, entryId: operation.entryId, locale }
            : { kind: "file" as const, name: operation.path, locale };
        const itemKey = serverItemKey(ref, operation.type);
        const current = this.items.get(itemKey);
        if ((current?.itemRevision ?? 0) !== expectedVersion) return null;
        const identity =
          "collectionName" in operation
            ? { kind: "entry", collectionName: operation.collectionName, entryId: operation.entryId, locale }
            : { kind: operation.type.endsWith("Document") ? "document" : "file", path: operation.path, locale };
        const desired: FakeItem["desired"] =
          operation.type === "upsertEntry"
            ? { type: "upsert", data: operation.data }
            : operation.type === "putDocument"
              ? { type: "upsert", data: operation.content }
              : operation.type === "writeFile"
                ? { type: "upsert", value: operation.value }
                : { type: "delete" };
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
