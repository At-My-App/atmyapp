import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { http, HttpResponse } from "msw";
import { createAtMyAppClient, defineCollection, defineDocument, defineImage, defineSchema, s } from "../src";
import { resolveClientOptions } from "../src/client/client";
import { LocalStore } from "../src/client/localStore";
import { server } from "./server";

const schema = defineSchema({
  definitions: {
    home: defineDocument({ fields: { title: s.shortText(), hero: s.image({ optional: true }) } }),
    posts: defineCollection({ fields: { title: s.shortText(), cover: s.image({ optional: true }) } }),
    logo: defineImage({ path: "logo.png" }),
  },
});

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

/** A store as `atmyapp content pull` writes it, plus a space with drafts. */
function buildStore(root: string) {
  const published = path.join(root, "published");
  write(path.join(published, "manifest.json"), {
    version: 2,
    projectId: "p1",
    branch: "main",
    baseCommit: "c1",
    localization: { defaultLocale: "en", supportedLocales: ["en", "de"] },
    media: "lazy",
    files: {
      "home.json": { kind: "document", mimeType: "application/json", downloaded: true },
      "logo.png": { kind: "image", mimeType: "image/png", downloaded: false, url: "https://edge.test/static/p1/logo?hash=1" },
    },
    collections: { posts: { entries: { e1: { createdAt: "2026-01-01" }, e2: { createdAt: "2026-01-02" } } } },
    assets: {
      "$asset:home.json/assets/hero.png": { url: "https://cdn/hero.png", alt: "Hero" },
      "__blob:b1": { url: "https://cdn/b1.png", blobId: "b1" },
    },
  });
  write(path.join(published, "f", "home.json"), { title: "Hello", hero: { $asset: "home.json/assets/hero.png" } });
  write(path.join(published, "locales", "f", "home.json", "de.json"), { mode: "overlay", status: "current", sourceHashes: {}, data: { title: "Hallo" } });
  write(path.join(published, "collections", "posts", "e1", "entry.json"), { id: "e1", data: { title: "First", cover: { __blob: "b1" } }, createdAt: "2026-01-01" });
  write(path.join(published, "collections", "posts", "e1", "locales", "de.json"), { mode: "overlay", status: "current", sourceHashes: {}, data: { title: "Erster" } });
  write(path.join(published, "collections", "posts", "e2", "entry.json"), { id: "e2", data: { title: "Second" }, createdAt: "2026-01-02" });

  const space = path.join(root, "spring");
  write(path.join(space, "space.json"), { version: 1, deletions: ["entry:posts:e2"] });
  write(path.join(space, "f", "home.json"), { title: "Hello spring", hero: { $file: "./hero-new.png", alt: "New" } });
  write(path.join(space, "collections", "posts", "_new", "easter.json"), { title: "Easter special" });
}

describe("local content store (format 2)", () => {
  const originalCwd = process.cwd();
  const env = { ...process.env };
  let cwd: string;
  let root: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ama-local-"));
    root = path.join(cwd, ".ama", "content");
    buildStore(root);
    process.chdir(cwd);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...env };
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("serves published content with translations and delivered assets", () => {
    const store = LocalStore.open({ publishedOnly: true })!;
    expect(store.readJson("home.json")).toEqual({ title: "Hello", hero: { url: "https://cdn/hero.png", alt: "Hero" } });
    expect(store.readJson("home.json", { locale: "de" })).toMatchObject({ title: "Hallo" });
    expect(store.listCollection("posts", { locale: "de" }).map((entry) => entry.data)).toEqual([
      { title: "Erster", cover: { url: "https://cdn/b1.png", blobId: "b1" } },
      { title: "Second" },
    ]);
    expect(store.staticUrl("logo.png")).toBe("https://edge.test/static/p1/logo?hash=1");
  });

  it("lays a space's drafts over published content", () => {
    const store = LocalStore.open({ space: "spring" })!;
    const home = store.readJson("home.json") as any;
    expect(home.title).toBe("Hello spring");
    expect(home.hero.url).toMatch(/^file:.*spring\/f\/hero-new\.png$/);
    expect(store.listCollection("posts").map((entry) => entry.id)).toEqual(["e1", "easter"]);
  });

  it("finds the active space from ATMYAPP_SPACE or .current", () => {
    process.env.ATMYAPP_SPACE = "spring";
    expect((LocalStore.open()!.readJson("home.json") as any).title).toBe("Hello spring");
    delete process.env.ATMYAPP_SPACE;
    expect((LocalStore.open()!.readJson("home.json") as any).title).toBe("Hello");
    fs.writeFileSync(path.join(root, ".current"), "spring\n");
    expect((LocalStore.open()!.readJson("home.json") as any).title).toBe("Hello spring");
    // with-fallback never shows drafts, whatever the active space.
    expect((LocalStore.open({ publishedOnly: true })!.readJson("home.json") as any).title).toBe("Hello");
  });

  it("feeds the client in local mode, switched on by ATMYAPP_CLIENT_MODE", async () => {
    process.env.ATMYAPP_CLIENT_MODE = "local";
    process.env.ATMYAPP_SPACE = "spring";
    expect(resolveClientOptions({ apiKey: "k", baseUrl: "http://x", clientMode: "online" }).clientMode).toBe("local");
    const client = createAtMyAppClient({ apiKey: "k", baseUrl: "http://localhost", schema });
    expect(await client.storage.getValue("home")).toMatchObject({ title: "Hello spring" });
    // The published German title still applies over the draft source, as on the
    // server once the source change is published (the translation is then outdated).
    expect(await client.storage.getValue("home", { locale: "de" })).toMatchObject({ title: "Hallo", hero: { alt: "New" } });
    expect((await client.collections.list("posts")).map((post: any) => post.title)).toEqual(["First", "Easter special"]);
    expect(await client.storage.getValue("logo")).toEqual({ url: "https://edge.test/static/p1/logo?hash=1" });
  });

  it("falls back to published content only when the API fails", async () => {
    server.use(http.get("http://localhost/storage/f/*", () => HttpResponse.json({ error: "down" }, { status: 503 })));
    fs.writeFileSync(path.join(root, ".current"), "spring\n");
    const client = createAtMyAppClient({ apiKey: "k", baseUrl: "http://localhost", schema, clientMode: "with-fallback", localStorage: { timeoutMs: 50 } });
    expect(await client.storage.getValue("home")).toMatchObject({ title: "Hello" });
  });

  it("picks up a new pull without restarting", () => {
    const first = LocalStore.open({ publishedOnly: true })!;
    expect((first.readJson("home.json") as any).title).toBe("Hello");
    write(path.join(root, "published", "f", "home.json"), { title: "Pulled again" });
    expect((LocalStore.open({ publishedOnly: true })!.readJson("home.json") as any).title).toBe("Pulled again");
  });
});
