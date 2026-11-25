import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiClient } from "../../src/runtime/api";
import { EXIT } from "../../src/runtime/errors";
import {
  applyPlan, describePlan, exportProject, parseProjectFile, planProject, projectJsonSchema, PROJECT_SCHEMA_URL,
} from "../../src/runtime/desired";
import { changeRole, inviteMember, removeMember } from "../../src/runtime/team";

const plain = (data: unknown, status = 200) => Response.json(data, { status });
const ok = (data: unknown) => plain({ success: true, data });
const personal = { token: "ama_cs_" + "a".repeat(64), projectId: "p1", url: "https://api.test/v0/projects/p1" };
const projectKey = { ...personal, token: "ama_pk_" + "b".repeat(32) };

beforeAll(() => {
  process.env.ATMYAPP_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-desired-"));
});

type Call = { method: string; path: string; body?: any };
type Rows = Array<Record<string, any>>;

/**
 * A project behind a fake API that applies writes, so an apply can be
 * followed by a second plan (which must be empty) and the links checked.
 */
function project(options: { session?: typeof personal; fail?: (call: Call) => Response | undefined } = {}) {
  let next = 0;
  const id = (prefix: string) => `${prefix}-new${++next}`;
  const state = {
    codeSources: [{ id: "c1", provider: "github", owner: "gamrot", repo: "site", default_branch: "main", status: "synced" }] as Rows,
    github: [
      { fullName: "gamrot/shop", owner: "gamrot", name: "shop", installationId: 9, defaultBranch: "trunk", private: true },
      { fullName: "gamrot/site", owner: "gamrot", name: "site", installationId: 9, defaultBranch: "main", private: true },
    ],
    secrets: [{ id: "s1", name: "STRIPE_KEY", is_secret: true, value: "sk_…1234" }, { id: "s2", name: "OLD_TOKEN", is_secret: true, value: "…" }] as Rows,
    presets: [{ id: "b1", name: "Main build", code_source_id: "c1", branch: "main", framework: "astro", build_command: "pnpm build", output_directory: "dist", env_overrides: { API_URL: "https://x" }, secret_ids: ["s1"] }] as Rows,
    websites: [{ id: "w1", name: "Main", build_preset_id: "b1", auto_promote_on_release: true, auto_rebuild_on_storage_change: true }] as Rows,
    domains: [{ id: "d1", hostname: "example.com", status: "active", deploymentId: "w1", deploymentName: "Main" }] as Rows,
    localization: { defaultLocale: "en", supportedLocales: ["en", "de"], fallback: true } as Record<string, any>,
    jobs: [] as Rows,
    jobOutcome: "completed",
    forms: [{ type: "contact", acceptingResponses: true }] as Rows,
    servers: [] as Rows,
    policy: null as unknown,
  };
  const byId = (rows: Rows, rowId: string) => rows.find((row) => row.id === rowId)!;
  const routes = (call: Call): Response => {
    const [first, second, third] = call.path.split("/");
    const failure = options.fail?.(call);
    if (failure) return failure;
    if (call.method === "GET") {
      if (call.path === "code-sources") return ok({ codeSources: state.codeSources });
      if (call.path === "secrets") return plain({ secrets: state.secrets });
      if (call.path === "build-presets") return plain({ build_presets: state.presets });
      if (call.path === "deployments") return plain({ deployments: state.websites });
      if (call.path === "domains") return ok(state.domains);
      if (call.path === "localization") return ok(state.localization);
      if (call.path === "localization/cleanup-jobs") return ok(state.jobs);
      if (first === "localization" && second === "cleanup-jobs") {
        const job = byId(state.jobs, third);
        job.status = state.jobOutcome;
        return ok({ ...job, error: job.status === "failed" ? "storage busy" : undefined });
      }
      if (call.path === "image-policy") return ok(state.policy);
      if (call.path === "submissions/types") return ok(state.forms);
      if (call.path === "dev-servers") return plain({ devServers: state.servers });
      if (call.path === "/cli-auth/github") return ok({ status: "ok", installations: 1, repositories: state.github, connectUrl: "x" });
    }
    if (call.path === "/cli-approvals/plans") return ok({ approval: null });
    if (call.method === "POST" && call.path === "secrets") {
      const row = { id: id("s"), name: call.body.name, is_secret: true, value: "…" };
      state.secrets.push(row);
      return plain({ secret: { id: row.id, name: row.name } }, 201);
    }
    if (call.method === "POST" && call.path === "code-sources") {
      const row = { id: id("c"), provider: "github", owner: call.body.owner, repo: call.body.repo, default_branch: call.body.default_branch, status: "syncing" };
      state.codeSources.push(row);
      return ok({ codeSource: row });
    }
    if (call.method === "POST" && call.path === "build-presets") {
      const row = { id: id("b"), env_overrides: {}, secret_ids: [], ...call.body };
      state.presets.push(row);
      return plain({ build_preset: row }, 201);
    }
    if (call.method === "PUT" && first === "build-presets") return plain({ build_preset: Object.assign(byId(state.presets, second), call.body) });
    if (call.method === "POST" && call.path === "deployments") {
      const row = { id: id("w"), auto_promote_on_release: true, auto_rebuild_on_storage_change: true, ...call.body };
      state.websites.push(row);
      return plain({ deployment: row }, 201);
    }
    if (call.method === "PUT" && first === "deployments") return plain({ deployment: Object.assign(byId(state.websites, second), call.body) });
    if (call.method === "POST" && call.path === "domains") {
      const website = state.websites.find((row) => row.id === call.body.deploymentId);
      const row = { id: id("d"), hostname: call.body.hostname, status: "pending", deploymentId: website?.id ?? null, deploymentName: website?.name ?? null };
      state.domains.push(row);
      return ok(row);
    }
    if (call.method === "PUT" && first === "domains") {
      const website = state.websites.find((row) => row.id === call.body.deploymentId);
      return ok(Object.assign(byId(state.domains, second), { deploymentId: website?.id ?? null, deploymentName: website?.name ?? null }));
    }
    if (call.method === "POST" && call.path === "dev-servers") {
      const row = { id: id("v"), ...call.body };
      state.servers.push(row);
      return plain({ devServer: row }, 201);
    }
    if (call.method === "PUT" && first === "dev-servers") return plain({ devServer: Object.assign(byId(state.servers, second), call.body) });
    if (call.method === "POST" && call.path === "localization/locales") {
      state.localization.supportedLocales = [...state.localization.supportedLocales, call.body.locale];
      return ok(state.localization);
    }
    if (call.method === "PUT" && call.path === "localization") {
      state.localization = call.body;
      return ok(state.localization);
    }
    if (call.method === "DELETE" && first === "localization") {
      state.localization.supportedLocales = state.localization.supportedLocales.filter((code: string) => code !== decodeURIComponent(third));
      const job = { id: id("j"), locale: decodeURIComponent(third), status: "pending" };
      state.jobs.push(job);
      return ok(job);
    }
    if (call.method === "POST" && first === "localization" && call.path.endsWith("/retry")) {
      const job = byId(state.jobs, third);
      job.status = "pending";
      return ok(job);
    }
    if (call.method === "PUT" && call.path === "image-policy") {
      state.policy = call.body;
      return ok(state.policy);
    }
    if (call.method === "POST" && call.path === "submissions/types") {
      state.forms.push({ type: call.body.type, acceptingResponses: call.body.acceptingResponses !== false });
      return ok({ type: call.body.type });
    }
    if (call.method === "PUT" && first === "submissions") return ok(Object.assign(state.forms.find((form) => form.type === decodeURIComponent(third))!, call.body));
    if (call.method === "DELETE") {
      const table = { domains: state.domains, deployments: state.websites, secrets: state.secrets } as Record<string, Rows>;
      if (table[first]) table[first].splice(table[first].findIndex((row) => row.id === second), 1);
      if (first === "submissions") state.forms = state.forms.filter((form) => form.type !== decodeURIComponent(third));
      return ok({});
    }
    return plain({ error: `unexpected ${call.method} ${call.path}` }, 500);
  };
  const calls: Call[] = [];
  const api = new ApiClient(options.session ?? personal, {
    fetch: (async (url: string, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const call = { method: init?.method ?? "GET", path: parsed.pathname.replace("/v0/projects/p1/", "").replace("/v0/", "/"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return routes(call);
    }) as never,
  });
  return { api, calls, state };
}

const file = (value: unknown) => parseProjectFile(value);
/** The current project, as a file that manages everything. */
const everything = {
  secrets: ["STRIPE_KEY", "OLD_TOKEN"],
  presets: [{ name: "Main build", repo: "gamrot/site", build: "pnpm build", output: "dist", env: { API_URL: "https://x" }, secrets: ["STRIPE_KEY"] }],
  websites: [{ name: "Main", preset: "Main build" }],
  domains: [{ hostname: "example.com", website: "Main" }],
  locales: { default: "en", supported: ["en", "de"] },
  forms: [{ name: "contact" }],
};

describe("export (§5.6)", () => {
  it("writes names and settings, never a secret value", async () => {
    const { api } = project();
    const { project: exported, incomplete } = await exportProject(api);
    expect(incomplete).toEqual([]);
    expect(exported).toMatchObject({
      $schema: PROJECT_SCHEMA_URL,
      secrets: ["OLD_TOKEN", "STRIPE_KEY"],
      presets: [{ name: "Main build", repo: "gamrot/site", build: "pnpm build", output: "dist", env: { API_URL: "https://x" }, secrets: ["STRIPE_KEY"] }],
      websites: [{ name: "Main", preset: "Main build", autoPromote: true, autoRebuild: true }],
      domains: [{ hostname: "example.com", website: "Main" }],
      locales: { default: "en", supported: ["en", "de"] },
      forms: [{ name: "contact", accepting: true }],
    });
    expect(JSON.stringify(exported)).not.toContain("sk_");
    // What export writes, the file accepts, and it plans nothing.
    expect((await planProject(api, file(exported), { env: {} })).steps).toEqual([]);
  });

  it("leaves out a section it couldn't read, and says so (§12.2 P2-2)", async () => {
    const { api } = project({ fail: (call) => (call.path === "localization" ? plain({ error: "timeout" }, 503) : undefined) });
    const { project: exported, incomplete } = await exportProject(api);
    expect(exported.locales).toBeUndefined();
    expect(exported.forms).toBeDefined();
    expect(incomplete).toEqual([{ section: "locales", reason: expect.stringContaining("locales") }]);
  });

  it("publishes a JSON Schema that matches the file format", () => {
    const published = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../../docs/public/schemas/project.json"), "utf8"));
    const { $id, title, description, ...schema } = published;
    expect($id).toBe(PROJECT_SCHEMA_URL);
    expect(title && description).toBeTruthy();
    expect(schema).toEqual(projectJsonSchema());
  });
});

describe("the file (§12.1 P1-6, §12.2 P2-4)", () => {
  it("makes names canonical once and refuses the same thing twice", () => {
    const parsed = file({ secrets: ["stripe_key"], domains: [{ hostname: " Example.COM ", website: null }] });
    expect(parsed.secrets).toEqual(["STRIPE_KEY"]);
    expect(parsed.domains![0].hostname).toBe("example.com");
    expect(() => file({ secrets: ["STRIPE_KEY", "stripe_key"] })).toThrow(expect.objectContaining({ code: "project_file_invalid", message: expect.stringContaining("Listed twice") }));
    expect(() => file({ domains: [{ hostname: "a.com", website: null }, { hostname: "A.com", website: null }] })).toThrow(expect.objectContaining({ code: "project_file_invalid" }));
    expect(() => file({ websites: [{ name: "Main", preset: "x" }, { name: "main", preset: "y" }] })).toThrow(expect.objectContaining({ code: "project_file_invalid" }));
    expect(() => file({ locales: { default: "fr", supported: ["en"] } })).toThrow(expect.objectContaining({ code: "project_file_invalid" }));
  });

  it("refuses a preview port the server refuses", () => {
    expect(() => file({ previewServers: [{ name: "P", repo: "a/b", command: "pnpm dev", port: 3000 }] })).toThrow(expect.objectContaining({ message: expect.stringContaining("reserved") }));
  });

  it("never prunes a declared domain or secret written differently", async () => {
    const { api } = project();
    const plan = await planProject(api, file({ ...everything, secrets: ["stripe_key", "old_token"], domains: [{ hostname: " EXAMPLE.com ", website: "Main" }] }), { prune: true, env: {} });
    expect(plan.steps).toEqual([]);
  });
});

describe("plan (§5.6)", () => {
  it("orders new things after what they need, and asks only for values that don't exist yet", async () => {
    const { api } = project();
    const wanted = file({
      secrets: ["STRIPE_KEY", "OLD_TOKEN"],
      presets: [{ name: "Shop build", repo: "gamrot/shop", build: "pnpm build", secrets: ["SHOP_KEY"] }],
      websites: [{ name: "Main", preset: "Main build" }, { name: "Shop", preset: "Shop build" }],
      domains: [{ hostname: "example.com", website: "Main" }, { hostname: "shop.example.com", website: "Shop" }],
      forms: [],
    });
    await expect(planProject(api, wanted, { env: {} })).rejects.toMatchObject({ code: "secret_values_missing", exitCode: EXIT.usage, details: { secrets: ["SHOP_KEY"] } });

    const plan = await planProject(api, wanted, { env: { SHOP_KEY: "shop-secret-value" } });
    expect(plan.steps.map((step) => step.id)).toEqual(["secret:SHOP_KEY", "code:gamrot/shop", "preset:shop build", "website:shop", "domain:shop.example.com"]);
    expect(plan.steps.find((step) => step.id === "preset:shop build")!.dependsOn).toEqual(["secret:SHOP_KEY", "code:gamrot/shop"]);
    expect(plan.steps.find((step) => step.id === "domain:shop.example.com")!.dependsOn).toEqual(["website:shop"]);
    // Not in the file: listed, deleted only with --prune. Languages aren't in the file at all, so they're left alone.
    expect(plan.pruned.map((step) => step.id)).toEqual(["form:contact:remove"]);
    const view = describePlan(plan);
    expect(JSON.stringify(view)).not.toContain("shop-secret-value");
    expect(view.changes).toBe(5);
  });

  it("adds env and secrets without --prune, makes them exact with it, and deletes a secret only when nothing uses it", async () => {
    const { api } = project();
    const wanted = file({ ...everything, secrets: [], presets: [{ name: "Main build", repo: "gamrot/site", build: "pnpm build", env: { PUBLIC_URL: "https://example.com" } }] });
    const merged = await planProject(api, wanted, { env: {} });
    expect(merged.steps).toHaveLength(1);
    expect(merged.steps[0].request).toEqual({ method: "PUT", path: "build-presets/b1", body: { env_overrides: { API_URL: "https://x", PUBLIC_URL: "https://example.com" } } });
    // What --prune would delete: STRIPE_KEY too, once the preset no longer lists it.
    expect(merged.pruned.map((step) => step.id)).toEqual(["secret:STRIPE_KEY:remove", "secret:OLD_TOKEN:remove"]);

    const exact = await planProject(api, wanted, { prune: true, env: {} });
    expect(exact.steps.map((step) => step.id)).toEqual(["preset:main build", "secret:STRIPE_KEY:remove", "secret:OLD_TOKEN:remove"]);
    expect(exact.steps[0].request).toEqual({ method: "PUT", path: "build-presets/b1", body: { env_overrides: { PUBLIC_URL: "https://example.com" }, secret_ids: [] } });
    expect(exact.steps[1].dependsOn).toEqual(["preset:main build"]);
  });

  it("changes the default language with the whole localization settings", async () => {
    const { api } = project();
    const plan = await planProject(api, file({ locales: { default: "fr", supported: ["en", "de", "fr"] } }), { env: {} });
    expect(plan.steps.map((step) => step.id)).toEqual(["locale:fr", "locale:default"]);
    expect(plan.steps[1]).toMatchObject({ dependsOn: ["locale:fr"], request: { method: "PUT", path: "localization", body: { defaultLocale: "fr", supportedLocales: ["en", "de", "fr"], fallback: true } } });
  });

  it("reads only what the file manages, and fails rather than plan from a failed read (§12.2 P2-2)", async () => {
    // A credential that can't read code sources or secrets can still apply forms.
    const forbidden = (call: Call) => (["code-sources", "secrets", "build-presets"].includes(call.path) ? plain({ error: "forbidden" }, 403) : undefined);
    const formsOnly = project({ fail: forbidden });
    const plan = await planProject(formsOnly.api, file({ forms: [{ name: "contact" }, { name: "newsletter" }] }), { env: {} });
    expect(plan.steps.map((step) => step.id)).toEqual(["form:newsletter"]);
    expect(formsOnly.calls.map((call) => call.path)).toEqual(["submissions/types"]);

    const timeout = project({ fail: (call) => (call.path === "localization" ? plain({ error: "timeout" }, 503) : undefined) });
    await expect(planProject(timeout.api, file({ locales: { default: "en", supported: ["en", "de", "fr"] } }), { env: {} })).rejects.toBeTruthy();
  });

  it("refuses unsafe writes when the variables can't be read (§12.1 P1-4)", async () => {
    const { api, state } = project();
    state.presets = state.presets.map(({ env_overrides: _env, secret_ids: _secrets, ...summary }) => summary);
    await expect(planProject(api, file({ presets: [{ name: "Main build", repo: "gamrot/site", build: "pnpm build", env: { A: "1" } }] }), { env: {} }))
      .rejects.toMatchObject({ code: "settings_unavailable", exitCode: EXIT.auth });
    const { incomplete } = await exportProject(api);
    expect(incomplete).toContainEqual({ section: "presets", reason: expect.stringContaining("hosting.manage") });
  });

  it("checks every reference before planning writes (§12.2 P2-3)", async () => {
    const { api } = project();
    await expect(planProject(api, file({ domains: [{ hostname: "shop.example.com", website: "Shop" }] }), { env: {} }))
      .rejects.toMatchObject({ code: "project_file_invalid", message: expect.stringContaining("Shop") });
    const { api: withServer, state } = project();
    state.servers.push({ id: "v1", name: "Preview", code_source_id: "c1", branch: "main", start_command: "pnpm dev", port: 4321, env_overrides: {}, secret_ids: [] });
    await expect(planProject(withServer, file({ previewServers: [{ name: "Preview", repo: "gamrot/shop", command: "pnpm dev", port: 4321 }] }), { env: {} }))
      .rejects.toMatchObject({ code: "project_file_invalid", message: expect.stringContaining("isn't supported") });
  });
});

describe("apply (§5.6)", () => {
  it("builds a new website on a new repository, links everything, and a second plan is empty (§12.2 P2-3, P2-4)", async () => {
    const { api, state } = project();
    const wanted = file({
      ...everything,
      presets: [...everything.presets, { name: "Shop build", repo: "gamrot/shop", build: "pnpm build", secrets: ["SHOP_KEY"] }],
      // Main moves to the new preset; the new domain points at a new website.
      websites: [{ name: "Main", preset: "Shop build" }, { name: "Shop", preset: "Shop build" }],
      domains: [{ hostname: "example.com", website: "Main" }, { hostname: "shop.example.com", website: "Shop" }],
      previewServers: [{ name: "Shop preview", repo: "gamrot/shop", command: "pnpm dev", port: 4321 }],
    });
    const plan = await planProject(api, wanted, { env: { SHOP_KEY: "shop-secret-value" } });
    expect(plan.steps.find((step) => step.id === "website:main")).toMatchObject({ action: "update", dependsOn: ["preset:shop build"] });
    expect(await applyPlan(api, plan)).toMatchObject({ failed: 0 });

    const shop = state.presets.find((preset) => preset.name === "Shop build")!;
    const shopSource = state.codeSources.find((source) => source.repo === "shop")!;
    expect(shop).toMatchObject({ code_source_id: shopSource.id, branch: "trunk", secret_ids: [state.secrets.find((secret) => secret.name === "SHOP_KEY")!.id] });
    expect(state.websites.map((site) => [site.name, site.build_preset_id])).toEqual([["Main", shop.id], ["Shop", shop.id]]);
    expect(state.domains.map((domain) => [domain.hostname, domain.deploymentName])).toEqual([["example.com", "Main"], ["shop.example.com", "Shop"]]);
    expect(state.servers[0]).toMatchObject({ branch: "trunk", code_source_id: shopSource.id });

    expect((await planProject(api, wanted, { env: {} })).steps).toEqual([]);
  });

  it("moves an existing preset to another repository instead of ignoring it", async () => {
    const { api, state } = project();
    const plan = await planProject(api, file({ presets: [{ ...everything.presets[0], repo: "gamrot/shop" }] }), { env: {} });
    expect(plan.steps.map((step) => step.id)).toEqual(["code:gamrot/shop", "preset:main build"]);
    await applyPlan(api, plan);
    expect(state.presets[0].code_source_id).toBe(state.codeSources.find((source) => source.repo === "shop")!.id);
  });

  it("asks once for the known changes, then skips only what depends on a failed step", async () => {
    const { api, calls } = project({
      fail: (call) => (call.method === "POST" && call.path === "code-sources" ? plain({ error: "GitHub is unavailable" }, 502) : undefined),
    });
    const plan = await planProject(api, file({
      ...everything,
      presets: [...everything.presets, { name: "Shop build", repo: "gamrot/shop", build: "pnpm build", secrets: ["SHOP_KEY"] }],
      websites: [{ name: "Main", preset: "Main build" }, { name: "Shop", preset: "Shop build" }],
      forms: [{ name: "contact" }, { name: "newsletter" }],
    }), { env: { SHOP_KEY: "shop-secret-value" } });
    const result = await applyPlan(api, plan);
    const planned = calls.find((call) => call.path === "/cli-approvals/plans")!.body;
    expect(planned.projectId).toBe("p1");
    expect(planned.operations.map((op: any) => `${op.method} ${op.path}`)).toEqual([
      "POST /projects/p1/secrets", "POST /projects/p1/code-sources", "POST /projects/p1/submissions/types",
    ]);
    expect(calls.findIndex((call) => call.path === "/cli-approvals/plans")).toBeLessThan(calls.findIndex((call) => call.method === "POST" && call.path === "secrets"));
    expect(result.results).toEqual([
      { id: "secret:SHOP_KEY", outcome: "done" },
      { id: "code:gamrot/shop", outcome: "failed", error: expect.objectContaining({ message: expect.stringContaining("GitHub") }) },
      { id: "preset:shop build", outcome: "skipped" },
      { id: "website:shop", outcome: "skipped" },
      { id: "form:newsletter", outcome: "done" },
    ]);
    expect(result).toMatchObject({ applied: 2, failed: 3 });
  });

  it("keeps a failed cleanup's job and how to retry it, and finishes it on the next run (§12.2 P2-5)", async () => {
    const { api, state } = project();
    state.jobOutcome = "failed";
    const wanted = file({ locales: { default: "en", supported: ["en"] } });
    const result = await applyPlan(api, await planProject(api, wanted, { prune: true, env: {} }), { pause: async () => undefined });
    expect(result.results[0]).toMatchObject({
      id: "locale:de:remove", outcome: "failed",
      error: { code: "locale_cleanup_failed", details: { jobId: "j-new1" }, fix: expect.stringContaining("--retry j-new1") },
    });
    // de is gone from the languages, but its cleanup isn't: the next plan retries it.
    state.jobOutcome = "completed";
    const rerun = await planProject(api, wanted, { env: {} });
    expect(rerun.steps.map((step) => step.id)).toEqual(["locale:de:cleanup"]);
    expect(await applyPlan(api, rerun, { pause: async () => undefined })).toMatchObject({ applied: 1, failed: 0 });
  });

  it("doesn't ask for a plan approval with a project key", async () => {
    const { api, calls } = project({ session: projectKey });
    const plan = await planProject(api, file({ forms: [{ name: "contact" }, { name: "newsletter" }] }), { env: {} });
    expect(await applyPlan(api, plan)).toMatchObject({ applied: 1, failed: 0 });
    expect(calls.some((call) => call.path.includes("cli-approvals"))).toBe(false);
  });
});

describe("team (§5.5 4d)", () => {
  const organization = { id: "o1", name: "Gamrot Studio", projects: 4 };
  function teamApi(routes: (call: Call) => Response | undefined = () => undefined) {
    const state = {
      members: [{ id: "m1", name: "Ana", email: "ana@example.com", role: "admin" }],
      invitations: [{ id: "i1", email: "bo@example.com", role: "editor" }],
    };
    const calls: Call[] = [];
    const api = new ApiClient(personal, {
      fetch: (async (url: string, init?: RequestInit) => {
        const call = { method: init?.method ?? "GET", path: new URL(String(url)).pathname.replace("/v0/projects/p1/", ""), body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const custom = routes(call);
        if (custom) return custom;
        if (call.method === "GET" && call.path === "team") return ok({ organization, ...state });
        return ok({});
      }) as never,
    });
    return { api, calls };
  }

  it("invites once, says what a change reaches, and keeps a request ID", async () => {
    const { api, calls } = teamApi();
    await expect(inviteMember(api, "ana@example.com", "editor")).rejects.toMatchObject({ code: "already_member", exitCode: EXIT.conflict });
    expect(await inviteMember(api, "BO@example.com", "editor")).toMatchObject({ unchanged: true });
    expect(await inviteMember(api, "cy@example.com", "reviewer")).toMatchObject({ unchanged: false, organization: { projects: 4 } });
    const post = calls.find((call) => call.method === "POST")!;
    expect(post).toMatchObject({ path: "team/invitations", body: { email: "cy@example.com", role: "reviewer", requestId: expect.any(String) } });
    await expect(inviteMember(api, "cy@example.com", "boss")).rejects.toMatchObject({ code: "invalid_role", exitCode: EXIT.usage });
  });

  it("changes a role by email and removes a member", async () => {
    const { api, calls } = teamApi();
    expect(await changeRole(api, "ana@example.com", "admin")).toMatchObject({ unchanged: true });
    expect(await changeRole(api, "ANA@example.com", "editor")).toMatchObject({ unchanged: false, role: "editor" });
    expect(calls.find((call) => call.method === "PUT")).toMatchObject({ path: "team/members/m1", body: { role: "editor" } });
    await expect(removeMember(api, "zed@example.com", {})).rejects.toMatchObject({ code: "member_not_found" });
    expect(await removeMember(api, "zed@example.com", { ifExists: true })).toMatchObject({ unchanged: true });
    expect(await removeMember(api, "m1", {})).toMatchObject({ unchanged: false, subject: "Ana", role: "admin" });
  });

  it("hands an ownership change to the dashboard (§12.1 P1-1)", async () => {
    const { api } = teamApi((call) => (call.method === "POST" ? plain({
      success: false, code: "dashboard_required", error: "Owners of Gamrot Studio are changed in the dashboard, not from the CLI.",
      details: { reason: "ownership", url: "https://app.test/business/o1/settings" },
    }, 403) : undefined));
    await expect(inviteMember(api, "cy@example.com", "owner")).rejects.toMatchObject({
      code: "needs_person", exitCode: EXIT.confirmation, details: { reason: "dashboard", url: "https://app.test/business/o1/settings", code: "dashboard_required" },
    });
  });
});
