import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ApiClient } from "../../src/runtime/api";
import { browserLoginSession, readBrowserLogin, setBrowserLoginProject, updateBrowserLoginExpiry } from "../../src/runtime/credentials";
import { login } from "../../src/runtime/login";
import { createProject, creationRequestId, findProject, listProjects } from "../../src/runtime/projects";
import { keyScopes, LOGIN_PRESETS, loginScopes, PERSONAL_SCOPES } from "../../src/runtime/scopes";
import { projectStatus } from "../../src/runtime/status";

const plain = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });
const ok = (data: unknown, headers: Record<string, string> = {}) => plain({ success: true, data }, 200, headers);
const token = "ama_cs_" + "c".repeat(64);
const expire = new Date(Date.now() + 90 * 86_400_000).toISOString();
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-personal-"));
  file = path.join(dir, "credentials.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function wideLogin() {
  let polls = 0;
  const fetch: typeof globalThis.fetch = async (url) => {
    if (String(url).endsWith("/device")) {
      return ok({ deviceCode: "d".repeat(64), userCode: "ABCDEFGH", verificationUrl: "https://dash.test/cli/authorize?code=ABCDEFGH", interval: 5, expiresIn: 600 });
    }
    return ok(++polls === 1 ? { status: "pending" } : { token, projectId: null, expiresAt: expire, projectLimit: { kind: "all" } });
  };
  return login({ url: "https://api.test", scopes: [...LOGIN_PRESETS.everything] }, { file, fetch, pause: async () => undefined, verify: () => undefined });
}

describe("wide browser logins (CliEverywherePlan §4.1)", () => {
  it("saves a login for every project with the API URL, not a project URL", async () => {
    await expect(wideLogin()).resolves.toMatchObject({ dryRun: false, projectId: null, projectLimit: { kind: "all" }, url: "https://api.test" });
    expect(readBrowserLogin({ file })).toMatchObject({ token, projectId: null, url: "https://api.test", projectLimit: { kind: "all" } });
  });

  it("picks the project per command: the one asked for, else the last chosen, else asks", async () => {
    await wideLogin();
    expect(() => browserLoginSession(undefined, { file })).toThrow(expect.objectContaining({ code: "project_required", exitCode: 2 }));
    expect(browserLoginSession("site", { file })).toEqual({ token, projectId: "site", url: "https://api.test/v0/projects/site" });
    expect(setBrowserLoginProject(token, "menu", file)).toBe(true);
    expect(browserLoginSession(undefined, { file })).toMatchObject({ projectId: "menu" });
    expect(browserLoginSession("site", { file })).toMatchObject({ projectId: "site" });
  });

  it("keeps the saved expiry in step with the server's renewals, never moving it back", async () => {
    await wideLogin();
    const later = new Date(Date.parse(expire) + 86_400_000).toISOString();
    expect(updateBrowserLoginExpiry(token, later, file)).toBe(true);
    expect(readBrowserLogin({ file })?.expiresAt).toBe(later);
    expect(updateBrowserLoginExpiry(token, expire, file)).toBe(false);
    expect(updateBrowserLoginExpiry("ama_cs_" + "e".repeat(64), new Date(Date.now() + 400 * 86_400_000).toISOString(), file)).toBe(false);
  });

  it("calls back when a response carries a renewed expiry", async () => {
    const renewed: string[] = [];
    const api = new ApiClient({ token, projectId: "site", url: "https://api.test/v0/projects/site" }, {
      fetch: async () => ok([], { "X-AtMyApp-Credential-Expires": "2027-02-22T00:00:00.000Z" }),
      onCredentialRenewed: (value) => renewed.push(value),
    });
    await api.json("GET", "domains");
    expect(renewed).toEqual(["2027-02-22T00:00:00.000Z"]);
  });
});

describe("presets", () => {
  it("defaults a login to read only and offers everything on request", () => {
    expect(loginScopes({}).preset).toBe("read-only");
    expect(loginScopes({}).scopes.every((scope) => !/stage|publish|push|deploy|manage|triage|create|invite/.test(scope))).toBe(true);
    expect(loginScopes({ preset: "everything" }).scopes).toEqual([...PERSONAL_SCOPES]);
    expect(() => loginScopes({ preset: "everything", scopes: "content.read" })).toThrow(/not both/);
    expect(() => loginScopes({ preset: "admin" })).toThrow(/Choose a login preset/);
  });

  it("gives project keys only key scopes", () => {
    expect(keyScopes({ preset: "ci-deploy" })).toEqual(["schema.push", "content.read", "hosting.deploy", "code.read"]);
    expect(() => keyScopes({ scopes: "account.read" })).toThrow(/Choose scopes/);
    expect(keyScopes({})).toBeUndefined();
  });
});

describe("projects", () => {
  const projects = [
    { id: "site", name: "Site", organization: { id: "bella", name: "Bella" }, via: "member" },
    { id: "menu", name: "Menu", organization: { id: "cafe", name: "Cafe" }, via: "member" },
    { id: "menu-2", name: "Menu", organization: { id: "dino", name: "Dino" }, via: "partner" },
  ];
  type Call = { method: string; path: string; body?: any };
  function account(routes: (call: Call) => Response) {
    const calls: Call[] = [];
    const api = new ApiClient({ token, projectId: "", url: "https://api.test" }, {
      fetch: async (url, init) => {
        const call = { method: init?.method ?? "GET", path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        return routes(call);
      },
    });
    return { api, calls };
  }

  it("finds projects by ID or unique name and lists them when it can't", async () => {
    const { api } = account(() => ok({ projects }));
    await expect(listProjects(api)).resolves.toMatchObject({ projects: expect.arrayContaining([expect.objectContaining({ id: "site" })]) });
    await expect(findProject(api, "site")).resolves.toMatchObject({ id: "site" });
    await expect(findProject(api, "SITE")).resolves.toMatchObject({ id: "site" });
    await expect(findProject(api, "Menu")).rejects.toMatchObject({ code: "project_ambiguous" });
    await expect(findProject(api, "nope")).rejects.toMatchObject({ code: "project_not_found", details: { projects: expect.any(Array) } });
  });

  it("creates once, returns the same project on a rerun, and sends a stable request ID", async () => {
    let created = false;
    const { api, calls } = account(({ method, path }) => {
      if (path.endsWith("/project-creation")) return ok({ destinations: [{ id: "bella", name: "Bella", via: "member", partner: null, limitReached: false }] });
      if (method === "GET") return ok({ projects: created ? [...projects, { id: "new-site", name: "New site", organization: { id: "bella", name: "Bella" }, via: "member" }] : projects });
      created = true;
      return ok({ id: "new-site", name: "New site" });
    });
    await expect(createProject(api, { name: "New site", org: "Bella" })).resolves.toMatchObject({ dryRun: false, unchanged: false, project: { id: "new-site" } });
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({ name: "New site", orgId: "bella", requestId: creationRequestId("bella", "New site") });
    expect(post.body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(createProject(api, { name: "New site", org: "bella" })).resolves.toMatchObject({ unchanged: true, project: { id: "new-site" } });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("explains where it can't create, and hands quota refusals to a person", async () => {
    const none = account(({ path }) => path.endsWith("/project-creation") ? ok({ destinations: [] }) : ok({ projects }));
    await expect(createProject(none.api, { name: "X", org: "bella" })).rejects.toMatchObject({ code: "organization_not_found", exitCode: 2 });

    const full = account(({ method, path }) => {
      if (path.endsWith("/project-creation")) return ok({ destinations: [{ id: "dino", name: "Dino", via: "partner", partner: { id: "acme", name: "Acme" }, limitReached: false }] });
      if (method === "GET") return ok({ projects });
      return plain({ success: false, code: "staff_limit", error: "Acme has reached its 20-website limit. Contact AtMyApp to raise it.", details: { limit: 20 } }, 403);
    });
    await expect(createProject(full.api, { name: "X", org: "dino" })).rejects.toMatchObject({
      code: "needs_person", exitCode: 6, details: { reason: "dashboard", code: "staff_limit", limit: 20 },
    });
  });
});

describe("status", () => {
  it("reports what it can read and marks the rest unavailable", async () => {
    const api = new ApiClient({ token: "ama_pk_" + "x".repeat(32), projectId: "site", url: "https://api.test/v0/projects/site" }, {
      fetch: async (url) => {
        const route = new URL(String(url)).pathname.replace("/v0/projects/site/", "");
        if (route === "deployments") return plain({ deployments: [{ id: "dep1", name: "Main", build_preset_id: "p1", active_release_id: null }] });
        if (route === "deployments/publication-status") return ok({ contentCommit: null, websites: [{ deploymentId: "dep1", state: "pending", liveReleaseId: null }] });
        if (route === "domains") return ok([]);
        if (route.startsWith("build-presets/")) return plain({ build_preset: { id: "p1", name: "Astro" } });
        return plain({ success: false, code: "project_key_scope", scopes: ["content.stage"], error: "This key isn't allowed to stage drafts." }, 403);
      },
    });
    const result = await projectStatus(api);
    expect(result.project).toEqual({ id: "site", credential: "projectKey" });
    expect(result.websites).toMatchObject({ available: true, items: [{ name: "Main", liveReleaseId: null }] });
    expect(result.drafts).toMatchObject({ available: false });
    expect(result.next).toEqual([expect.objectContaining({ command: "atmyapp hosting deploy --deployment dep1 --wait" })]);
  });
});
