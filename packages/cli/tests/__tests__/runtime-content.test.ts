import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assetsCommand } from "../../src/cli/commands/assets";
import { contentCommand } from "../../src/cli/commands/content";
import { doctorCommand } from "../../src/cli/commands/doctor";
import { entriesCommand } from "../../src/cli/commands/entries";
import { localesCommand } from "../../src/cli/commands/locales";
import { schemaCommand } from "../../src/cli/commands/schema";
import { useCommand } from "../../src/cli/commands/use";
import { defineCollection, defineDocument, defineSchema, s } from "@atmyapp/structure";
import { ApiClient, projectApiUrl } from "../../src/runtime/api";
import { listEntries, readRef } from "../../src/runtime/content";
import { CliError, EXIT } from "../../src/runtime/errors";
import { contentFingerprint, documentAssetId } from "../../src/runtime/fingerprint";
import { deliver, LocalContent } from "../../src/runtime/local";
import { pullContent } from "../../src/runtime/pull";
import { formatRef, parseRef, resolvePointer, toItemKey } from "../../src/runtime/refs";
import { RemoteSchema } from "../../src/runtime/schema";
import { resolveCredentials } from "../../src/runtime/session";
import { ContentStore, encodeSegment } from "../../src/runtime/store";
import { collectAssetMap, outlineOf, viewValue } from "../../src/runtime/views";
import { outputSchemaFor } from "../../src/runtime/schemas/help";
import { run } from "../helpers/run-command";

const SCHEMA = defineSchema({
  localization: { enabled: true },
  definitions: {
    home: defineDocument({
      description: "Homepage",
      fields: {
        title: s.shortText({ max: 60 }),
        hero: s.object({ fields: { image: s.image({ optional: true }) } }),
      },
    }),
    posts: defineCollection({
      fields: { title: s.shortText(), cover: s.image({ optional: true }), price: s.number(), active: s.boolean() },
    }),
  },
});

describe("content fingerprints", () => {
  // Reference digests from ama-shared editBaselineDigest (the server's baseline check).
  it("match the server's edit baseline digest", () => {
    expect(
      contentFingerprint("file", {
        title: "Hello",
        hero: { image: { $asset: "home.json/assets/hero.png" }, alt: "x" },
        list: [{ _key: "a", b: 1 }],
      }),
    ).toBe("c522e74713b1015f1476d3c229ad0cb5f93096b0e0b541be481e334727409edb");
    expect(contentFingerprint("file", '{"b":1,"a":"z"}')).toBe("284c266995fee4aa1a8aca3f6fea0046357776fd4041b17d913978e8a19bd069");
    expect(contentFingerprint("file", "# Title\nBody")).toBe("dba1d99e409373c10cb261d9673b1d94a0b26bf1186faf1af3e003eaf98f82cd");
    expect(
      contentFingerprint("entry", {
        id: "e1",
        createdAt: "x",
        title: "Post",
        cover: { blobId: "b1", url: "https://x/y.png" },
        tags: ["a", "b"],
      }),
    ).toBe("3f7542736f1dac791e6aba90648e7c47885349586bb3c8e442f3d28e8af0bd9e");
  });

  it("names document assets like the server", () => {
    expect(documentAssetId("/home.json/assets/hero.png")).toBe(`ga_${Buffer.from("home.json/assets/hero.png").toString("base64url")}`);
  });
});

describe("content references", () => {
  it("parses every kind with locale and pointer", () => {
    expect(parseRef("doc:home")).toEqual({ kind: "doc", name: "home" });
    expect(parseRef("doc:home@de#/hero/title")).toEqual({ kind: "doc", name: "home", locale: "de", pointer: "/hero/title" });
    expect(parseRef("entry:posts/8f2a@pt-br")).toEqual({ kind: "entry", name: "posts", entryId: "8f2a", locale: "pt-BR" });
    expect(parseRef("file:files/menu.pdf")).toEqual({ kind: "file", name: "files/menu.pdf" });
    expect(parseRef("coll:posts").kind).toBe("coll");
  });

  it("keeps @ in paths that are not language tags", () => {
    expect(parseRef("file:images/logo@2x.png")).toEqual({ kind: "file", name: "images/logo@2x.png" });
  });

  it("round-trips and maps to staging item keys", () => {
    const ref = parseRef("entry:posts/a:b@de#/title");
    expect(formatRef(ref)).toBe("entry:posts/a:b@de#/title");
    expect(toItemKey(ref)).toBe("entry:posts:a:b");
    expect(toItemKey(parseRef("doc:home"), "home.json")).toBe("file:home.json");
    expect(toItemKey(parseRef("coll:posts"))).toBeNull();
  });

  it("refuses malformed references with a usage error", () => {
    for (const input of ["home", "thing:x", "entry:posts", "coll:a/b", "doc:home#title"]) {
      expect(() => parseRef(input)).toThrow(CliError);
      try {
        parseRef(input);
      } catch (error) {
        expect((error as CliError).exitCode).toBe(EXIT.usage);
      }
    }
  });

  it("resolves JSON pointers with escapes", () => {
    const value = { "a/b": [{ "~x": 1 }] };
    expect(resolvePointer(value, "/a~1b/0/~0x")).toEqual({ found: true, value: 1 });
    expect(resolvePointer(value, "/a~1b/5").found).toBe(false);
  });
});

describe("credentials", () => {
  const file = { token: "file-key", url: "https://api.test/v0/projects/from-file" };

  it("prefers flags, then ATMYAPP_CLI_* variables, then the session file", () => {
    expect(resolveCredentials({ sessionFile: file }).token).toBe("file-key");
    const fromEnv = resolveCredentials({ env: { ATMYAPP_CLI_KEY: "env-key" }, sessionFile: file });
    expect(fromEnv).toMatchObject({ token: "env-key", projectId: "from-file", sources: { token: "env", url: "session-file", projectId: "url" } });
    expect(resolveCredentials({ flags: { token: "flag-key" }, env: { ATMYAPP_CLI_KEY: "env-key" }, sessionFile: file }).token).toBe("flag-key");
  });

  it("explains how to connect when nothing is configured", () => {
    try {
      resolveCredentials({ env: {} });
      throw new Error("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("not_connected");
      expect((error as CliError).exitCode).toBe(EXIT.auth);
      expect((error as CliError).fix).toContain("ATMYAPP_CLI_KEY");
    }
  });

  it("builds project API URLs from any accepted session URL", () => {
    expect(projectApiUrl("https://api.test/v0/projects/p1", "p1", "storage/f/a b.json", { branch: "main", x: undefined })).toBe(
      "https://api.test/v0/projects/p1/storage/f/a%20b.json?branch=main",
    );
    expect(projectApiUrl("https://api.test", "p1", "localization")).toBe("https://api.test/v0/projects/p1/localization");
  });
});

describe("views", () => {
  it("returns small values whole and large ones as an outline", () => {
    expect(viewValue({ a: 1 })).toEqual({ view: "full", value: { a: 1 } });
    const large = { items: Array.from({ length: 400 }, (_, index) => ({ name: `Item ${index}`, text: "x".repeat(60) })) };
    const view = viewValue(large);
    expect(view?.view).toBe("outline");
    if (view?.view === "outline") {
      expect(view.outline.rows[1]).toEqual({ pointer: "/items/0", summary: "2 fields", label: "Item 0" });
    }
    expect(viewValue(large, { pointer: "/items/3" })).toEqual({ view: "part", pointer: "/items/3", value: large.items[3] });
    expect(viewValue(large, { pointer: "/missing" })).toBeNull();
  });

  it("caps outlines", () => {
    const outline = outlineOf({ list: Array.from({ length: 1000 }, () => 1) });
    expect(outline.truncated).toBe(true);
    expect(outline.rows.length).toBe(400);
  });

  it("pairs stored asset references with what websites receive", () => {
    const map = collectAssetMap(
      { hero: { $asset: "home.json/assets/a.png" }, gallery: [{ __blob: "b1" }, "b2"] },
      { hero: { url: "https://cdn/a.png", alt: "A" }, gallery: [{ url: "https://cdn/b1.png" }, { url: "https://cdn/b2.png", blobId: "b2" }] },
    );
    expect(map).toEqual({
      "$asset:home.json/assets/a.png": { url: "https://cdn/a.png", alt: "A" },
      "__blob:b1": { url: "https://cdn/b1.png" },
      "__blob:b2": { url: "https://cdn/b2.png", blobId: "b2" },
    });
    expect(deliver({ hero: { $asset: "home.json/assets/a.png" }, other: 1 }, map)).toEqual({ hero: { url: "https://cdn/a.png", alt: "A" }, other: 1 });
  });
});

describe("remote schema", () => {
  const schema = new RemoteSchema(SCHEMA);

  it("resolves documents by name or path and lists localized fields", () => {
    expect(schema.resolveDocument("home")?.path).toBe("home.json");
    expect(schema.resolveDocument("home.json")?.name).toBe("home");
    expect(schema.summaries().find((summary) => summary.name === "posts")?.localizedFields).toEqual(["/title"]);
    expect(schema.collections()).toEqual(["posts"]);
  });

  it("describes fields for editing", () => {
    expect(schema.fieldRows("home")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer: "/title", type: "string:short", required: true, localize: true, limits: expect.objectContaining({ max: 60 }) }),
        expect.objectContaining({ pointer: "/hero/image", type: "image", required: false }),
      ]),
    );
  });

  it("explains an unknown collection", () => {
    expect(() => schema.collection("nope")).toThrow(/no collection 'nope'/);
  });
});

// --- A fake project API -------------------------------------------------------

type Handler = (url: URL, init: RequestInit) => Response | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function bytes(body: string, contentType: string) {
  return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
}

class FakeProject {
  head = "c1";
  home: unknown = { title: "Hello", hero: { image: { $asset: "home.json/assets/hero.png" } } };
  entries: Array<{ id: string; title: string; created: string }> = [{ id: "e1", title: "Post", created: "2026-01-01T00:00:00Z" }];
  diffs: Record<string, unknown> = {};
  calls: string[] = [];
  extra: Handler[] = [];

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/v0\/projects\/p1\//, "");
    this.calls.push(`${init.method ?? "GET"} ${route}${url.search}`);
    for (const handler of this.extra) {
      const response = handler(url, init);
      if (response) return response;
    }
    const stored = url.searchParams.get("skipTransformations") === "true" || url.searchParams.get("expandBlobs") === "none";
    if (route === "storage/history") return json({ success: true, data: { headCommitSha: this.head, commits: [] } });
    const diff = /^storage\/history\/([^/]+)\/diff$/.exec(route);
    if (diff) {
      const key = `${url.searchParams.get("baseCommitSha")}..${diff[1]}`;
      return this.diffs[key] ? json({ success: true, data: this.diffs[key] }) : json({ success: false, error: "no diff" }, 404);
    }
    if (route === "storage/structure") return json({ success: true, data: { found: true, structure: SCHEMA } });
    if (route === "localization") return json({ success: true, data: { defaultLocale: "en", supportedLocales: ["en", "de"] } });
    if (route === "content-placements") return json({ success: true, data: { usage: [{ definition: "home", summary: "Hero", pages: [{ route: "/" }] }] } });
    if (route === "staging/named") return json({ data: [], success: true });
    if (route === "storage/public") return json({ files: [] });
    if (route === "storage/f") {
      const manifestFiles: Record<string, unknown> = { ".structure.json": {}, "files/menu.pdf": { mimeType: "application/pdf" } };
      if (this.home) manifestFiles["home.json"] = { mimeType: "application/json" };
      return json({ manifestFiles });
    }
    if (route === "storage/f/home.json") {
      if (!this.home) return json({ success: false, error: "File not found" }, 404);
      const delivered = JSON.parse(JSON.stringify(this.home));
      if (!stored && delivered.hero?.image) delivered.hero.image = { url: "https://cdn/hero.png", alt: "Hero" };
      return bytes(JSON.stringify(stored ? this.home : delivered), "application/json");
    }
    if (route === "storage/static/files/menu.pdf") {
      return json({ success: true, data: { staticUrl: "https://edge.test/static/p1/m1?hash=abc" } });
    }
    if (route === "storage/variants/home.json") {
      return json({ success: true, data: [{ scope: { locale: "de" }, mode: "overlay", data: { title: "Hallo" }, status: "current", sourceHashes: {} }] });
    }
    if (route === "collections/posts/entries") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const page = this.entries.slice(offset, offset + limit).map((entry) => this.entry(entry, stored));
      return json({ entries: page, total: this.entries.length });
    }
    const entry = /^collections\/posts\/entries\/([^/]+)(\/variants)?$/.exec(route);
    if (entry) {
      const found = this.entries.find((item) => item.id === decodeURIComponent(entry[1]));
      if (entry[2]) {
        return json({ success: true, data: found ? [{ scope: { locale: "de" }, mode: "overlay", data: { title: `${found.title} (de)` }, status: "outdated", sourceHashes: {} }] : [] });
      }
      return found ? json(this.entry(found, stored)) : json({ success: false, error: "Entry not found" }, 404);
    }
    return json({ success: false, error: `unexpected ${route}` }, 500);
  };

  private entry(entry: { id: string; title: string; created: string }, stored: boolean) {
    return {
      id: entry.id,
      created: entry.created,
      updated: entry.created,
      data: { title: entry.title, cover: stored ? { __blob: `b-${entry.id}` } : { url: `https://cdn/${entry.id}.png`, blobId: `b-${entry.id}` } },
    };
  }
}

function client(project: FakeProject) {
  return new ApiClient({ token: "ama_pk_test", url: "https://api.test/v0/projects/p1", projectId: "p1" }, { fetch: project.fetch as typeof fetch });
}

describe("documented JSON output", () => {
  const env = { ...process.env };
  const fetch = globalThis.fetch;
  const originalCwd = process.cwd();
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ama-json-"));
    process.chdir(cwd);
    process.env.ATMYAPP_CLI_URL = "https://api.test/v0/projects/p1";
    process.env.ATMYAPP_CLI_KEY = "ama_pk_x";
    process.env.ATMYAPP_PROJECT_ID = "p1";
    const project = new FakeProject();
    project.extra.push((url) => {
      if (url.pathname.endsWith("/auth/verify")) {
        return json({ success: true, data: { valid: true, keyName: "CI", scopes: ["snapshot"], projectId: "p1" } });
      }
      if (url.pathname.endsWith("/integration-check")) return json({ status: "passed", code: "verified" });
      if (url.pathname.endsWith("/files/menu.pdf")) return bytes("pdf", "application/pdf");
      if (url.pathname.includes("/storage/locales/") || url.pathname.endsWith("/e1/locales")) {
        return json({ defaultLocale: "en", locales: [{ locale: "de", status: "current" }] });
      }
      return undefined;
    });
    globalThis.fetch = project.fetch;
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    process.env = { ...env };
    globalThis.fetch = fetch;
    process.exitCode = undefined;
  });

  it.each([
    ["use", useCommand, []],
    ["doctor", doctorCommand, []],
    ["schema show", schemaCommand, ["show"]],
    ["schema show", schemaCommand, ["show", "--raw"]],
    ["schema show", schemaCommand, ["show", "coll:posts"]],
    ["schema show", schemaCommand, ["show", "doc:home", "--for-editing"]],
    ["content ls", contentCommand, ["ls"]],
    ["content get", contentCommand, ["get", "doc:home"]],
    ["content get", contentCommand, ["get", "doc:home#/title"]],
    ["content get", contentCommand, ["get", "doc:home@de", "--view", "overlay"]],
    ["content pull", contentCommand, ["pull"]],
    ["entries ls", entriesCommand, ["ls", "posts"]],
    ["entries get", entriesCommand, ["get", "posts", "e1"]],
    ["assets get", assetsCommand, ["get", "file:files/menu.pdf", "-o", "asset.pdf"]],
    ["locales status", localesCommand, ["status"]],
  ] as const)("validates %s with the help schema", async (name, command, args) => {
    const output = await run(command(), [...args, "--json"]);
    expect(output?.ok).toBe(true);
    expect(outputSchemaFor(name)!.parse(output)).toEqual(output);
    expect(process.exitCode).toBeUndefined();
  });

  it("accepts repeated --where options and sends them to the project API", async () => {
    const unfiltered = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/collections/posts/entries")) return unfiltered(input, init);
      expect(url.searchParams.get("price.gte")).toBe("20");
      expect(url.searchParams.get("price.lt")).toBe("40");
      return json({ entries: [{ id: "e1", data: { price: 25 } }], total: 1, nextAfter: null });
    });
    const output = await run(entriesCommand(), ["ls", "posts", "--where", "price>=20", "--where", "price<40", "--json"]);
    expect(output).toMatchObject({ ok: true, data: { entries: [{ id: "e1" }], nextCursor: null } });
  });
});

describe("remote reads", () => {
  it("reads documents in every view and lists entries with opaque cursors", async () => {
    const project = new FakeProject();
    project.entries = Array.from({ length: 3 }, (_, index) => ({ id: `e${index}`, title: `Post ${index}`, created: `2026-01-0${index + 1}` }));
    const api = client(project);
    const schema = new RemoteSchema(SCHEMA);
    const stored = await readRef(api, schema, parseRef("doc:home"), { view: "stored", locale: null });
    expect(stored).toMatchObject({ ref: "doc:home", path: "home.json", definition: "home", value: project.home });
    expect(stored.fingerprint).toBe(contentFingerprint("file", project.home));
    const delivered = await readRef(api, schema, parseRef("doc:home"), { view: "delivered", locale: null });
    expect((delivered.value as any).hero.image).toEqual({ url: "https://cdn/hero.png", alt: "Hero" });
    const overlay = await readRef(api, schema, parseRef("doc:home"), { view: "overlay", locale: "de" });
    expect(overlay).toMatchObject({ value: { title: "Hallo" }, variant: { status: "current", mode: "overlay" } });

    const first = await listEntries(api, "posts", { limit: 2 });
    expect(first.entries.map((entry) => entry.id)).toEqual(["e0", "e1"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listEntries(api, "posts", { limit: 2, cursor: first.nextCursor! });
    expect(second.entries.map((entry) => entry.id)).toEqual(["e2"]);
    expect(second.nextCursor).toBeNull();
    await expect(listEntries(api, "posts", { cursor: first.nextCursor!, order: "created.asc" })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("turns key scope refusals into an auth error with a fix", async () => {
    const project = new FakeProject();
    project.extra.push(() =>
      json({ success: false, code: "project_key_scope", scopes: ["content.read"], error: "This key isn't allowed to read content." }, 403),
    );
    await expect(readRef(client(project), new RemoteSchema(SCHEMA), parseRef("doc:home"), { view: "stored", locale: null })).rejects.toMatchObject({
      code: "missing_scope",
      exitCode: EXIT.auth,
      fix: expect.stringContaining("content.read"),
    });
  });

  it("forwards a keyset cursor with the same filters and stops at the null nextAfter marker", async () => {
    const project = new FakeProject();
    const after = Buffer.from(JSON.stringify({ c: "2026-01-01T00:00:00Z", i: "e1/b" })).toString("base64url");
    const where = ["price>=2", "price>=3", "price<10", "price!=5", "title=001", "title~%_+", "active=true", "id>abc", "id<=zzz"];
    project.extra.push((url) => {
      if (!url.pathname.endsWith("/collections/posts/entries")) return undefined;
      const params = url.searchParams;
      expect(params.getAll("price.gte")).toEqual(["2", "3"]);
      expect(params.get("price.lt")).toBe("10");
      expect(params.get("price.neq")).toBe("5");
      expect(params.get("title.eq")).toBe('"001"');
      expect(params.get("title.contains")).toBe("%_+");
      expect(params.get("active.eq")).toBe("true");
      expect(params.get("id.gt")).toBe('"abc"');
      expect(params.get("id.lte")).toBe('"zzz"');
      if (params.has("after")) {
        expect(params.get("after")).toBe(after);
        expect(params.has("offset")).toBe(false);
        return json({ entries: [{ id: "e2", data: {} }], total: 2, nextAfter: null });
      }
      expect(params.get("offset")).toBe("1");
      return json({ entries: [{ id: "e1/b", data: {} }], total: 2, nextAfter: after });
    });
    const api = client(project);
    const v1 = Buffer.from(JSON.stringify({ v: 1, o: 1, s: "created.desc" })).toString("base64url");
    const first = await listEntries(api, "posts", { where, cursor: v1 });
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toEqual({ v: 2, k: after, s: "created.desc" });
    const end = await listEntries(api, "posts", { where, cursor: first.nextCursor! });
    expect(end).toEqual({ entries: [{ id: "e2", data: {} }], total: 2, nextCursor: null });
    await expect(listEntries(api, "posts", { cursor: first.nextCursor!, order: "created.asc" })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("fails clearly if an older server ignores a requested filter", async () => {
    await expect(listEntries(client(new FakeProject()), "posts", { where: ["price>=2"] }))
      .rejects.toMatchObject({ code: "filters_unsupported" });
  });

  it.each([
    ["typo=2", "unknown_filter_field"],
    ["price>=invalid", "invalid_filter"],
    ["cover~jpg", "invalid_filter"],
    ["price", "invalid_filter"],
  ])("rejects an invalid filter %s before listing entries", async (term, code) => {
    const project = new FakeProject();
    await expect(listEntries(client(project), "posts", { where: [term] })).rejects.toMatchObject({ code, exitCode: EXIT.usage });
    expect(project.calls.some((call) => call.includes("collections/posts/entries"))).toBe(false);
  });
});

describe("content pull and the local copy", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ama-store-"));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("copies everything, then applies only changes, then reports up to date", async () => {
    const project = new FakeProject();
    const api = client(project);

    const full = await pullContent(api, {}, cwd);
    expect(full).toMatchObject({ mode: "full", baseCommit: "c1", files: 2, entries: 1, translations: 2 });
    const store = new ContentStore(cwd);
    const manifest = store.readManifest()!;
    expect(manifest.files["home.json"]).toMatchObject({ kind: "document", definition: "home", downloaded: true, locales: { de: { status: "current" } } });
    expect(manifest.files["files/menu.pdf"]).toMatchObject({ downloaded: false, url: "https://edge.test/static/p1/m1?hash=abc" });
    expect(manifest.files[".structure.json"]).toBeUndefined();
    expect(manifest.assets["$asset:home.json/assets/hero.png"]).toEqual({ url: "https://cdn/hero.png", alt: "Hero" });
    expect(manifest.assets["__blob:b-e1"]).toEqual({ url: "https://cdn/e1.png", blobId: "b-e1" });
    expect(JSON.parse(fs.readFileSync(store.entryPath("posts", "e1"), "utf8"))).toMatchObject({ id: "e1", data: { title: "Post" } });
    expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toContain(".ama/content/");
    expect(fs.existsSync(path.join(cwd, ".ama", "content", "published.next"))).toBe(false);

    const local = new LocalContent(store);
    expect(local.read(parseRef("doc:home"), "stored", null).value).toEqual(project.home);
    expect((local.read(parseRef("doc:home"), "delivered", null).value as any).hero.image.url).toBe("https://cdn/hero.png");
    expect(local.read(parseRef("doc:home"), "effective", "de").value).toMatchObject({ title: "Hallo", hero: project.home && (project.home as any).hero });
    expect(local.read(parseRef("entry:posts/e1"), "effective", "de").value).toMatchObject({ title: "Post (de)" });
    expect(() => local.read(parseRef("file:files/menu.pdf"), "stored", null)).toThrow(/not downloaded/);

    // A second commit: e1 renamed, home deleted.
    project.head = "c2";
    project.entries[0].title = "Renamed";
    project.home = null;
    project.diffs["c1..c2"] = {
      changes: [
        { key: "entry:posts:e1", kind: "entry", change: "modified", label: "e1", path: "collections/posts/entries/e1/entry.json" },
        { key: "file:home.json", kind: "file", change: "deleted", label: "home.json", path: "files/home.json" },
      ],
      truncated: false,
    };
    project.calls = [];
    const incremental = await pullContent(api, {}, cwd);
    expect(incremental).toMatchObject({ mode: "incremental", baseCommit: "c2", previousCommit: "c1", entries: 1, removed: 1 });
    expect(project.calls.some((call) => call.startsWith("GET collections/posts/entries?"))).toBe(false);
    const updated = store.readManifest()!;
    expect(updated.files["home.json"]).toBeUndefined();
    expect(fs.existsSync(store.filePath("home.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(store.entryPath("posts", "e1"), "utf8")).data.title).toBe("Renamed");

    expect(await pullContent(api, {}, cwd)).toMatchObject({ mode: "up-to-date", baseCommit: "c2" });
  });

  it("recovers the published copy after interruption between directory renames", async () => {
    const api = client(new FakeProject());
    const store = new ContentStore(cwd);
    await pullContent(api, {}, cwd);
    fs.renameSync(store.spaceDir(), store.spaceDir("published.old"));
    expect(await pullContent(api, {}, cwd)).toMatchObject({ mode: "up-to-date", baseCommit: "c1" });
    expect(fs.existsSync(store.filePath("home.json"))).toBe(true);
  });

  it("keeps the last complete published copy after a failed incremental pull", async () => {
    const project = new FakeProject();
    const api = client(project);
    await pullContent(api, {}, cwd);
    const store = new ContentStore(cwd);
    const before = store.readManifest();
    const entry = fs.readFileSync(store.entryPath("posts", "e1"));
    project.head = "c2";
    project.diffs["c1..c2"] = { changes: [
      { key: "entry:posts:e1", kind: "entry", change: "deleted", label: "e1", path: "" },
      { key: "file:home.json", kind: "file", change: "modified", label: "home.json", path: "" },
    ] };
    project.extra.push((url) => url.pathname.endsWith("/storage/f/home.json") ? json({ error: "offline" }, 503) : undefined);
    await expect(pullContent(api, {}, cwd)).rejects.toThrow();
    expect(store.readManifest()).toEqual(before);
    expect(fs.readFileSync(store.entryPath("posts", "e1"))).toEqual(entry);
    project.extra = [];
    expect(await pullContent(api, {}, cwd)).toMatchObject({ mode: "incremental", baseCommit: "c2" });
    expect(fs.existsSync(store.entryPath("posts", "e1"))).toBe(false);
  });

  it("falls back to a full pull when the diff is truncated or the schema changed", async () => {
    const project = new FakeProject();
    const api = client(project);
    await pullContent(api, {}, cwd);
    project.head = "c2";
    project.diffs["c1..c2"] = { changes: [{ key: "structure", kind: "structure", change: "modified", label: "", path: ".structure.json" }] };
    const result = await pullContent(api, {}, cwd);
    expect(result.mode).toBe("full");
    expect(result.notes.join(" ")).toMatch(/schema changed/i);
  });

  it("pulls bare blob IDs from projected entries and reads downloaded binary files", async () => {
    const project = new FakeProject();
    project.extra.push((url) => {
      if (url.pathname.endsWith("/storage/f/files/menu.pdf")) return bytes("pdf", "application/pdf");
      if (url.pathname.endsWith("/collections/posts/entries")) {
        const stored = url.searchParams.get("expandBlobs") === "none";
        return json({ entries: [{
          id: "e1", created: "2026-01-01T00:00:00Z",
          data: stored ? { cover: "b-e1" } : { cover: { blobId: "b-e1", url: "https://cdn/e1.png" } },
        }], total: 1 });
      }
      if (url.pathname.endsWith("/blobs/b-e1")) return bytes("image", "image/png");
      return undefined;
    });
    await pullContent(client(project), { media: true }, cwd);
    const local = new LocalContent(new ContentStore(cwd));
    expect(local.manifest.collections.posts.entries.e1.blobs).toEqual(["b-e1"]);
    expect(local.read(parseRef("entry:posts/e1"), "delivered", null).value).toEqual({
      cover: { blobId: "b-e1", url: "https://cdn/e1.png" },
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(local.read(parseRef("file:files/menu.pdf"), "stored", null).value).toEqual({
      binary: true, size: 3, mimeType: "application/pdf",
    });
  });

  it("refuses to run while another pull holds the lock", async () => {
    const store = new ContentStore(cwd);
    const release = store.lockPublished();
    await expect(pullContent(client(new FakeProject()), {}, cwd)).rejects.toMatchObject({ code: "store_locked" });
    release();
  });

  it("encodes path segments safely", () => {
    expect(encodeSegment("..")).toBe("%2E%2E");
    expect(encodeSegment("a*b c")).toBe("a%2Ab%20c");
    expect(encodeSegment("ok-id_1")).toBe("ok-id_1");
  });
});
