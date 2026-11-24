import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiClient } from "../../src/runtime/api";
import { readBrowserLogin } from "../../src/runtime/credentials";
import { EXIT } from "../../src/runtime/errors";
import { hostingDeploy, hostingLogs, hostingPromote, hostingReleases, hostingStatus } from "../../src/runtime/hosting";
import { createKey, listKeys, revokeKey } from "../../src/runtime/keys";
import { login, logout } from "../../src/runtime/login";
import { nativeCredential } from "../../src/runtime/nativeCredentials";
import { stageCommit } from "../../src/runtime/publish";
import { resolveCredentials } from "../../src/runtime/session";
import { readSpace, writeSpace } from "../../src/runtime/spaces";
import { draftFixture, draftProject } from "../helpers/named-drafts";

jest.mock("../../src/runtime/nativeCredentials", () => ({ nativeCredential: jest.fn() }));

const plain = (data: unknown, status = 200) => Response.json(data, { status });
const ok = (data: unknown) => plain({ success: true, data });
const token = "ama_cs_" + "a".repeat(64);
const projectToken = "ama_pk_" + "x".repeat(32);
const session = { token, projectId: draftProject, url: "https://api.test/v0/projects/" + draftProject };
const expire = new Date(Date.now() + 45_000).toISOString();
const site = { id: "deployment-1", name: "Site", build_preset_id: "preset-1", active_release_id: "live" };
const release = { id: "new", deployment_id: site.id, status: "pending" };
let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-c5-test-"));
  jest.mocked(nativeCredential).mockReturnValue(null);
});
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

function fixtureWithDraft() {
  const { work, store } = draftFixture(cwd);
  const space = readSpace(store, work.name);
  space.session = { sessionId: "ns_223e4567-e89b-12d3-a456-426614174000", createdAt: new Date().toISOString() };
  writeSpace(store, space);
  return work;
}

it("keeps publishing read-only for dry-run and returns the scope error before any commit", async () => {
  const work = fixtureWithDraft();
  const fetch = jest.fn(async (url: string) => url.endsWith("/inspect")
    ? ok({ ready: true, headSha: "head", sessionRevision: 1, conflictCount: 0, problems: [] })
    : plain({ error: "Scope required", code: "project_key_scope", scopes: ["content.publish"] }, 403));
  const api = new ApiClient(session, { fetch: fetch as any });
  await expect(stageCommit(api, work, { message: "Check", dryRun: true })).resolves.toMatchObject({ dryRun: true });
  expect(fetch.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual(["inspect"]);
  expect(fs.existsSync(path.join(work.store.spaceDir(work.name), ".publish.json"))).toBe(false);
  await expect(stageCommit(api, work, { message: "Publish" })).rejects.toMatchObject({ code: "missing_scope", exitCode: EXIT.auth });
});

it("requires TTY and confirmation for exact warnings, and resumes with the same receipt identity", async () => {
  const work = fixtureWithDraft();
  let messageLost = false;
  const requests: Array<{ operationId: string; warningConsentToken?: string }> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (!body.warningConsentToken && !messageLost) return plain({ code: "publication-warnings", data: {
      problems: [{ type: "warning", consentToken: "warning-1", issues: [{ code: "empty", message: "A title is missing" }] }],
    } }, 409);
    if (!messageLost) {
      expect(body.warningConsentToken).toBe("warning-1");
      messageLost = true;
      throw new Error("connection interrupted after commit");
    }
    return ok({ committed: true, remainingItemCount: 0, receipt: { operationId: body.operationId, commitSha: "verified-head", projected: false } });
  };
  const api = new ApiClient(session, { fetch });
  const confirmWarnings = jest.fn(async () => true);
  await expect(stageCommit(api, work, { message: "Publish", acceptWarnings: true, terminal: false, confirmWarnings }))
    .rejects.toMatchObject({ code: "needs_confirmation", exitCode: 6 });
  expect(confirmWarnings).not.toHaveBeenCalled();
  expect(requests.map((body) => body.warningConsentToken)).toEqual([undefined]);
  const options = { message: "Publish", acceptWarnings: true, terminal: true, confirmWarnings };
  await expect(stageCommit(api, work, options)).rejects.toMatchObject({ code: "network" });
  expect(confirmWarnings).toHaveBeenCalledWith([{ code: "empty", message: "A title is missing" }]);
  await expect(stageCommit(api, work, options)).resolves.toMatchObject({ commitSha: "verified-head", projection: "pending" });
  expect(confirmWarnings).toHaveBeenCalledTimes(1);
  expect(new Set(requests.map((body) => body.operationId)).size).toBe(1);
});

it("loads hosting status, polls releases and emits each log line once", async () => {
  let logPolls = 0, releasePolls = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const endpoint = new URL(String(url)).pathname.split("/" + draftProject + "/").at(-1);
    if (endpoint === "deployments") return plain({ deployments: [site] });
    if (endpoint === "domains") return ok([{ id: "domain", hostname: "www.example.org", status: "active" }]);
    if (endpoint === "deployments/publication-status") return plain({ contentCommit: "content-head", websites: [] });
    if (endpoint === "build-presets/preset-1") return plain({ build_preset: { id: "preset-1", name: "Astro" } });
    if (endpoint === "deployments/deployment-1/releases") return init?.method === "POST"
      ? plain({ release }, 202) : plain({ releases: [release] });
    if (endpoint === "deployments/deployment-1/releases/live") return plain({ release: { ...release, id: "live", status: "ready" } });
    if (endpoint === "deployments/deployment-1/releases/new") return plain({ release: { ...release, status: ++releasePolls < 2 ? "running" : "ready" } });
    if (endpoint === "deployments/deployment-1/releases/new/promote")
      return plain({ deployment: site, promotedRelease: { id: "new", status: "ready" }, propagation: { status: "pending" } });
    if (endpoint === "deployments/deployment-1/releases/new/logs") return plain(++logPolls === 1
      ? { releaseId: "new", status: "running", logs: "start\npart" }
      : { releaseId: "new", status: "ready", logs: "start\npartial\nend" });
    throw new Error("Unexpected test endpoint " + endpoint);
  };
  const api = new ApiClient(session, { fetch });
  const noDelay = async () => undefined;
  await expect(hostingStatus(api)).resolves.toMatchObject({ deployments: [{ activeRelease: { id: "live" }, buildPreset: { name: "Astro" } }], domains: [{ hostname: "www.example.org" }] });
  await expect(hostingDeploy(api, { wait: true, pause: noDelay })).resolves.toMatchObject({ release: { status: "ready" } });
  await expect(hostingReleases(api)).resolves.toMatchObject({ releases: [release] });
  await expect(hostingPromote(api, "new")).resolves.toMatchObject({ promotedRelease: { id: "new" } });
  const records: unknown[] = [];
  await hostingLogs(api, "new", { follow: true, pause: noDelay, emit: (record) => records.push(record) });
  expect(records).toEqual([
    { type: "log", releaseId: "new", line: "start" }, { type: "status", releaseId: "new", status: "running" },
    { type: "log", releaseId: "new", line: "partial" }, { type: "log", releaseId: "new", line: "end" }, { type: "status", releaseId: "new", status: "ready" },
  ]);
});

it("separates build failure with log tail from timeout after a release was admitted", async () => {
  const failed = { ...release, status: "failed" };
  const testApi = (initial: typeof release) => new ApiClient(session, { fetch: async (url) => {
    if (String(url).endsWith("/logs")) return plain({ status: "failed", releaseId: "new", logs: "start\nend\n" });
    if (String(url).endsWith("/releases")) return plain({ release: initial });
    return plain({ deployments: [site] });
  } });
  await expect(hostingDeploy(testApi(failed))).rejects.toMatchObject({ code: "build_failed", exitCode: 1, details: { logs: ["start", "end"] } });
  await expect(hostingDeploy(testApi(release), { wait: true, timeoutMs: 0 })).rejects.toMatchObject({
    code: "deploy_timeout", exitCode: 8, details: { releaseId: "new", status: "pending", state: "pending", resume: "atmyapp hosting logs new --follow" },
  });
});

it("exchanges device login without ambient auth, stores fallback privately and revokes it at logout", async () => {
  let polls = 0;
  const file = path.join(cwd, "credentials.json");
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url).endsWith("/session")) {
      expect(headers.get("authorization")).toBe("Bearer " + token);
      expect(init?.method).toBe("DELETE");
      return ok({ revoked: true });
    }
    expect(headers.has("authorization")).toBe(false);
    expect(init?.redirect).toBe("error");
    if (String(url).endsWith("/device")) {
      // Newer CLIs say they understand multi-project logins (E34).
      expect(JSON.parse(String(init?.body))).toMatchObject({ protocol: 2, scopes: ["content.read"] });
      return ok({
      deviceCode: "b".repeat(64), userCode: "ABCDEFGH", verificationUrl: "https://dash.test/cli/authorize?code=ABCDEFGH", interval: 5, expiresIn: 600,
      });
    }
    expect(JSON.parse(String(init?.body))).toEqual({ deviceCode: "b".repeat(64) });
    return ok(++polls === 1 ? { status: "pending" } : { token, projectId: draftProject, expiresAt: expire });
  };
  const verify = jest.fn();
  const result = await login({ url: session.url, scopes: ["content.read"] }, { file, fetch, pause: async () => undefined, verify });
  expect(result).toEqual({
    dryRun: false, projectId: draftProject, projectLimit: { kind: "projects", ids: [draftProject] },
    expiresAt: expire, storage: "file", url: session.url,
  });
  expect(verify).toHaveBeenCalledWith("https://dash.test/cli/authorize?code=ABCDEFGH", "ABCDEFGH");
  expect(readBrowserLogin({ file })).toMatchObject(session);
  if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  await expect(logout({ file, fetch })).resolves.toMatchObject({ loggedOut: true });
  expect(fs.existsSync(file)).toBe(false);
});

it("resolves browser login before the local link without sending it to another project or API", () => {
  const file = { ...session, token: projectToken };
  expect(resolveCredentials({ loginSession: session, sessionFile: file }).sources.token).toBe("login");
  expect(() => resolveCredentials({ loginSession: session, flags: { url: "https://foreign.test/v0/projects/" + draftProject } })).toThrow();
  expect(() => resolveCredentials({ loginSession: session, flags: { projectId: "other" } })).toThrow();
  expect(resolveCredentials({ loginSession: session, env: { ATMYAPP_CLI_KEY: projectToken } }).token).toBe(projectToken);
});

it("keeps project keys out of output, preserves env entries, and requires a login for mutations", async () => {
  const file = path.join(cwd, ".env.local");
  fs.writeFileSync(file, "OTHER=value\nATMYAPP_CLI_KEY=old\n");
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (init?.method === "DELETE") return ok({ deleted: true });
    const record = { id: "key-id", name: "CI", key_hint: "ama_pk_…xxxx", scopes: ["content.read"] };
    if (init?.method === "POST") return ok({ ...record, secret: projectToken });
    return ok(String(url).endsWith("/api-keys") ? [{ id: "pk-ama-example", name: "Website" }] : [record]);
  };
  const api = new ApiClient(session, { fetch });
  const options = { name: "CI", scopes: ["content.read"], envFile: file };
  await expect(createKey(new ApiClient({ ...session, token: projectToken }, { fetch }), options)).rejects.toMatchObject({ code: "login_required" });
  await expect(createKey(api, { ...options, dryRun: true })).resolves.toMatchObject({ dryRun: true });
  expect(fs.readFileSync(file, "utf8")).toBe("OTHER=value\nATMYAPP_CLI_KEY=old\n");
  expect(await createKey(api, options)).toEqual({ dryRun: false, hint: "ama_pk_…xxxx", envFile: file });
  expect(fs.readFileSync(file, "utf8")).toBe("OTHER=value\nATMYAPP_CLI_KEY=" + projectToken + "\n");
  await expect(listKeys(api)).resolves.toMatchObject({ projectKeys: [{ key_hint: "ama_pk_…xxxx" }], contentApiKeys: [{ id: "pk-ama-example" }] });
  await expect(revokeKey(api, "key-id")).resolves.toMatchObject({ revoked: true });
});
