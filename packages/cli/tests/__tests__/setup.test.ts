import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiClient } from "../../src/runtime/api";
import { EXIT } from "../../src/runtime/errors";
import { addCodeSource, connectGithub } from "../../src/runtime/code";
import { connectWebsite, createWebsite, listSecrets, removeEnv, removeSecret, secretValue, setEnv, setSecret } from "../../src/runtime/setup";
import { addLocale, createForm, removeLocale } from "../../src/runtime/settings";

const plain = (data: unknown, status = 200) => Response.json(data, { status });
const ok = (data: unknown) => plain({ success: true, data });
const session = { token: "ama_cs_" + "a".repeat(64), projectId: "p1", url: "https://api.test/v0/projects/p1" };

type Call = { method: string; path: string; body?: any };
function fakeApi(routes: (call: Call) => Response) {
  const calls: Call[] = [];
  const api = new ApiClient(session, {
    fetch: (async (url: string, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const call = { method: init?.method ?? "GET", path: parsed.pathname.replace("/v0/projects/p1/", "").replace("/v0/", "/"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return routes(call);
    }) as never,
  });
  return { api, calls };
}

beforeAll(() => {
  process.env.ATMYAPP_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-setup-"));
});

const repo = { fullName: "gamrot/site", owner: "gamrot", name: "site", installationId: 7, defaultBranch: "main", private: true };

describe("code (§5.5 4a)", () => {
  it("says which GitHub step is missing, and finishes when the repository is listed", async () => {
    const states = [
      { status: "not_authorized", repositories: [] },
      { status: "ok", installations: 0, repositories: [] },
      { status: "ok", installations: 1, repositories: [{ ...repo, fullName: "gamrot/other", name: "other" }] },
      { status: "ok", installations: 1, repositories: [repo] },
    ];
    let index = 0;
    const github = () => ok({ ...states[Math.min(index, states.length - 1)], connectUrl: "https://app/cli/github?repo=gamrot/site" });
    const { api } = fakeApi(() => github());
    await expect(connectGithub(api, { repo: "gamrot/site", wait: false })).rejects.toMatchObject({
      code: "needs_person", exitCode: EXIT.confirmation, details: { reason: "browser", code: "github_authorization_expired", url: "https://app/cli/github?repo=gamrot/site" },
    });
    index = 1;
    await expect(connectGithub(api, { repo: "gamrot/site", wait: false })).rejects.toMatchObject({ details: { code: "github_not_installed" } });
    index = 2;
    await expect(connectGithub(api, { repo: "gamrot/site", wait: false })).rejects.toMatchObject({ details: { code: "github_repo_not_granted" } });
    // An account already connected to GitHub grants a second repository while the CLI waits.
    const result = await connectGithub(api, { repo: "gamrot/site", pause: async () => { index += 1; } });
    expect(result).toMatchObject({ connected: true, repository: { fullName: "gamrot/site" } });
  });

  it("adds a repository once, with the installation GitHub reports", async () => {
    let sources: unknown[] = [];
    const { api, calls } = fakeApi((call) => {
      if (call.path === "/cli-auth/github") return ok({ status: "ok", installations: 1, repositories: [repo], connectUrl: "x" });
      if (call.method === "POST") {
        sources = [{ id: "c1", provider: "github", owner: "gamrot", repo: "site", default_branch: "main", status: "syncing" }];
        return ok({ codeSource: sources[0] });
      }
      return ok({ codeSources: sources });
    });
    expect(await addCodeSource(api, "gamrot/site", {})).toMatchObject({ unchanged: false, codeSource: { id: "c1" } });
    expect(calls.find((call) => call.method === "POST")!.body).toEqual({ provider: "github", owner: "gamrot", repo: "site", default_branch: "main", installation_id: 7 });
    expect(await addCodeSource(api, "gamrot/site", {})).toMatchObject({ unchanged: true });
    await expect(addCodeSource(api, "gamrot/site", { branch: "dev" })).rejects.toMatchObject({ code: "already_exists", exitCode: EXIT.conflict });
  });
});

describe("hosting setup (§5.5 4b)", () => {
  const presets = [{ id: "b1", name: "Main build", code_source_id: "c1", env_overrides: { API_URL: "https://x" }, secret_ids: ["s1"] }];
  const websites = [{ id: "w1", name: "Main", build_preset_id: "b1" }, { id: "w2", name: "Shop", build_preset_id: "b2" }];
  const shop = { id: "b2", name: "Shop build", code_source_id: "c1", env_overrides: {}, secret_ids: ["s1"] };
  const secrets = [{ id: "s1", name: "STRIPE_KEY", is_secret: true, value: "sk_…1234" }];
  function hostingApi(state = { presets: [...presets, shop] }) {
    return fakeApi((call) => {
      if (call.path === "build-presets") return plain({ build_presets: state.presets });
      if (call.path === "deployments") return plain({ deployments: websites });
      if (call.path === "dev-servers") return plain({ devServers: [] });
      if (call.path === "secrets") return plain({ secrets });
      if (call.method === "PUT" && call.path.startsWith("build-presets/")) {
        const id = call.path.split("/")[1];
        state.presets = state.presets.map((preset) => (preset.id === id ? { ...preset, ...call.body } : preset));
        return plain({ build_preset: state.presets.find((preset) => preset.id === id) });
      }
      return plain({ success: true });
    });
  }

  it("needs a preset for a website, and points to website connect", async () => {
    const { api } = fakeApi((call) => (call.path === "build-presets" ? plain({ build_presets: [] }) : plain({ deployments: [] })));
    await expect(createWebsite(api, { name: "Main" })).rejects.toMatchObject({ code: "preset_required", fix: expect.stringContaining("projects website connect") });
  });

  it("detaches a shared secret from one website and leaves the other using it", async () => {
    const { api, calls } = hostingApi();
    expect(await removeEnv(api, "STRIPE_KEY", { website: "Main" })).toEqual({ target: "website Main", name: "STRIPE_KEY", removed: "secret" });
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put).toMatchObject({ path: "build-presets/b1", body: { secret_ids: [] } });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    const listed = await listSecrets(api);
    expect(listed.secrets[0]).toMatchObject({ name: "STRIPE_KEY", attachedTo: ["website Shop"] });
  });

  it("keeps plain values and attached secrets apart", async () => {
    const { api, calls } = hostingApi();
    expect(await setEnv(api, "PUBLIC_URL=https://example.com", { website: "Main" })).toMatchObject({ kind: "plain", unchanged: false });
    expect(calls.at(-1)!.body).toEqual({ env_overrides: { API_URL: "https://x", PUBLIC_URL: "https://example.com" } });
    expect(await setEnv(api, "STRIPE_KEY", { website: "Main", secret: true })).toMatchObject({ kind: "secret", unchanged: true });
    await expect(setEnv(api, "STRIPE_KEY=oops", { website: "Main", secret: true })).rejects.toMatchObject({ exitCode: EXIT.usage });
  });

  it("refuses to delete a secret in use unless --detach-all, and never takes a value from a flag", async () => {
    const { api, calls } = hostingApi();
    await expect(removeSecret(api, "STRIPE_KEY", {})).rejects.toMatchObject({ code: "secret_in_use", exitCode: EXIT.conflict });
    expect(await removeSecret(api, "STRIPE_KEY", { detachAll: true })).toMatchObject({ removed: true, detachedFrom: ["Main build", "Shop build"] });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["secrets/s1"]);
    expect(() => secretValue({})).toThrow(expect.objectContaining({ code: "invalid_options" }));
    process.env.CLI_TEST_SECRET = "value-1";
    expect(secretValue({ fromEnv: "CLI_TEST_SECRET" })).toBe("value-1");
    expect(secretValue({ fromStdin: true, stdin: () => "value-2\n" })).toBe("value-2");
    const created = await setSecret(api, "NEW_KEY", "value-3");
    expect(created).toEqual({ name: "NEW_KEY", created: true, secret: true });
    expect(JSON.stringify(created)).not.toContain("value-3");
  });

  it("refuses a website change that reaches other websites through a shared preset, unless --shared (§12.1 P1-5)", async () => {
    const shared = [{ id: "w1", name: "Main", build_preset_id: "b1" }, { id: "w3", name: "Blog", build_preset_id: "b1" }];
    const { api, calls } = fakeApi((call) => {
      if (call.path === "build-presets") return plain({ build_presets: presets });
      if (call.path === "deployments") return plain({ deployments: shared });
      if (call.path === "secrets") return plain({ secrets });
      return plain({ build_preset: presets[0] });
    });
    for (const change of [() => setEnv(api, "PUBLIC_URL=https://x", { website: "Main" }), () => removeEnv(api, "STRIPE_KEY", { website: "Main" })]) {
      await expect(change()).rejects.toMatchObject({ code: "preset_shared", exitCode: EXIT.conflict, details: { websites: ["Main", "Blog"] } });
    }
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(await setEnv(api, "PUBLIC_URL=https://x", { website: "Main", shared: true })).toMatchObject({ target: "build preset Main build (websites Main, Blog)", unchanged: false });
  });

  it("never writes variables it couldn't read (§12.1 P1-4)", async () => {
    // Without hosting.manage the server leaves the settings out: unknown, not empty.
    const { api, calls } = fakeApi((call) => {
      if (call.path === "dev-servers") return plain({ devServers: [{ id: "v1", name: "Preview", port: 4321 }] });
      if (call.path === "build-presets") return plain({ build_presets: [] });
      if (call.path === "secrets") return plain({ secrets });
      return plain({ success: true });
    });
    await expect(setEnv(api, "A=1", { previewServer: "Preview" })).rejects.toMatchObject({ code: "settings_unavailable", exitCode: EXIT.auth });
    await expect(removeSecret(api, "STRIPE_KEY", { detachAll: true })).rejects.toMatchObject({ code: "settings_unavailable" });
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("gives each secrets set its own operation, reused only to retry a lost answer (§12.1 P1-7)", async () => {
    let failNext = true;
    const { api, calls } = fakeApi((call) => {
      if (call.method === "GET") return plain({ secrets });
      if (failNext) {
        failNext = false;
        return plain({ error: "upstream timeout" }, 502);
      }
      return plain({ secret: { id: "s1" } });
    });
    await expect(setSecret(api, "stripe_key", "value-a")).rejects.toBeTruthy();
    await setSecret(api, "STRIPE_KEY", "value-a"); // the interrupted run, again
    await setSecret(api, "STRIPE_KEY", "value-b");
    await setSecret(api, "STRIPE_KEY", "value-a"); // deliberately back to the first value
    const writes = calls.filter((call) => call.method === "PUT");
    expect(writes.map((call) => call.path)).toEqual(["secrets/s1", "secrets/s1", "secrets/s1", "secrets/s1"]);
    const ids = writes.map((call) => call.body.operationId);
    expect(ids[1]).toBe(ids[0]);
    expect(new Set([ids[1], ids[2], ids[3]]).size).toBe(3);
    // The journal never holds the value.
    const saved = fs.readdirSync(path.join(process.env.ATMYAPP_STATE_DIR!, "operations")).map((name) => fs.readFileSync(path.join(process.env.ATMYAPP_STATE_DIR!, "operations", name), "utf8")).join("");
    expect(saved).not.toContain("value-");
  });

  it("sets up the first website with the repository's suggestions and keeps its request ID for a retry", async () => {
    const bodies: any[] = [];
    let fail = true;
    const { api } = fakeApi((call) => {
      if (call.path === "code-sources") return ok({ codeSources: [{ id: "c1", provider: "github", owner: "gamrot", repo: "site", default_branch: "main", status: "synced" }] });
      if (call.path.endsWith("/website-profile")) {
        return ok({ recommended_index: 0, candidates: [{ root: "", framework: { value: "astro" }, commands: {
          install: { value: "pnpm install" }, build: { value: "pnpm build" }, output: { value: "dist" }, preview: { value: "pnpm dev" }, port: 4321,
        } }] });
      }
      bodies.push(call.body);
      if (fail) {
        fail = false;
        return ok({ status: "failed", steps: [{ id: "build", status: "failed", message: "preset limit" }], website: null });
      }
      return ok({ status: "done", steps: [{ id: "build", status: "done" }], website: { id: "w1" } });
    });
    await expect(connectWebsite(api, { repo: "gamrot/site" })).rejects.toMatchObject({ code: "website_connect_failed" });
    const result = await connectWebsite(api, { repo: "gamrot/site", output: "build" });
    expect(result.status).toBe("done");
    expect(bodies[0]).toMatchObject({
      code_source_id: "c1", branch: "main", framework: "astro", install_command: "pnpm install",
      build: { command: "pnpm build", output_directory: "dist" }, preview: { mode: "managed", command: "pnpm dev", port: 4321 },
    });
    expect(bodies[1].build.output_directory).toBe("build");
    // A changed setting is a new connect; the same settings retried reuse the request.
    expect(bodies[1].request_id).not.toBe(bodies[0].request_id);
  });
});

describe("settings and forms (§5.5 4c, 4d)", () => {
  it("adds a language once and follows a removal's cleanup job", async () => {
    let locales = ["en"];
    const jobs = ["running", "failed"];
    const { api } = fakeApi((call) => {
      if (call.path === "localization") return ok({ defaultLocale: "en", supportedLocales: locales });
      if (call.method === "POST") {
        locales = [...locales, call.body.locale];
        return ok({ defaultLocale: "en", supportedLocales: locales });
      }
      if (call.method === "DELETE") return ok({ id: "job1", locale: "de", status: "pending" });
      return ok({ id: "job1", locale: "de", status: jobs.shift() ?? "failed", error: "storage busy" });
    });
    expect(await addLocale(api, "de")).toMatchObject({ unchanged: false });
    expect(await addLocale(api, "de")).toMatchObject({ unchanged: true });
    await expect(removeLocale(api, "de", { wait: true, pause: async () => undefined })).rejects.toMatchObject({
      code: "locale_cleanup_failed", exitCode: EXIT.error, details: { jobId: "job1" },
    });
  });

  it("creates a form once", async () => {
    let forms: unknown[] = [];
    const { api, calls } = fakeApi((call) => {
      if (call.method === "POST") {
        forms = [{ type: "contact" }];
        return ok({ type: "contact" });
      }
      return ok(forms);
    });
    expect(await createForm(api, "contact", {})).toMatchObject({ unchanged: false });
    expect(await createForm(api, "contact", {})).toMatchObject({ unchanged: true });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});
