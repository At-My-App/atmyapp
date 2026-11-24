import { ApiClient } from "../../src/runtime/api";
import {
  addDomain,
  checkDomain,
  domainSetup,
  editDomain,
  normalizeHostname,
  removeDomain,
  showDomain,
  type DomainDetail,
} from "../../src/runtime/domains";

const plain = (data: unknown, status = 200) => Response.json(data, { status });
const ok = (data: unknown) => plain({ success: true, data });
const session = { token: "ama_pk_" + "x".repeat(32), projectId: "p1", url: "https://api.test/v0/projects/p1" };
const since = "2026-11-23T12:00:00.000Z";

const summary = {
  id: "d1", hostname: "www.horacy.ai", status: "ssl_pending", deploymentId: "dep1", deploymentName: "Horacy AI",
  routeStatus: "active", removalPending: false, issues: [], lastCheckedAt: since, createdAt: since,
};
function detail(overrides: Partial<DomainDetail> = {}): DomainDetail {
  return {
    ...summary,
    dnsTarget: "customers.atmyapp.com",
    nextCheckAt: null,
    assignment: {
      deploymentId: "dep1", deploymentName: "Horacy AI", routeStatus: "active", servingMode: "astro_static",
      pinnedReleaseId: null, spaFallback: false, indexFallback: true, fallback404Path: "/404.html",
      release: { id: "rel1", status: "ready" },
    },
    diagnosis: {
      checkedAt: since,
      records: [
        { type: "CNAME", purpose: "routing", name: "www.horacy.ai", host: "www", value: "customers.atmyapp.com", status: "found" },
        { type: "TXT", purpose: "certificate", name: "_acme-challenge.www.horacy.ai", host: "_acme-challenge.www", value: "a", status: "missing" },
        { type: "TXT", purpose: "certificate", name: "_acme-challenge.www.horacy.ai", host: "_acme-challenge.www", value: "b", status: "missing" },
      ],
      certificateRecordsPending: false,
      steps: { records: { state: "action", since }, certificate: { state: "waiting", since } },
      certificate: {},
      issues: [],
    },
    debug: {},
    ...overrides,
  };
}

type Call = { method: string; path: string; body?: unknown };
function fakeApi(routes: (call: Call) => Response) {
  const calls: Call[] = [];
  const api = new ApiClient(session, {
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname.replace("/v0/projects/p1/", "");
      const call = { method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return routes(call);
    },
  });
  return { api, calls };
}

test("normalizes what people paste as a hostname", () => {
  expect(normalizeHostname(" https://WWW.Example.com/about ")).toBe("www.example.com");
  expect(normalizeHostname("shop.example.co.uk.")).toBe("shop.example.co.uk");
  expect(() => normalizeHostname("not a domain")).toThrow(/valid domain/);
});

test("explains each phase with the records and what to do next", () => {
  const records = domainSetup(detail());
  expect(records).toMatchObject({ phase: "records", summary: expect.stringContaining("2 of 3") });
  expect(records.nextSteps.join(" ")).toContain("atmyapp domains check www.horacy.ai --wait");
  expect(records.nextSteps.at(-1)).toContain("make horacy.ai open the site too");

  const stuck = domainSetup(detail({
    diagnosis: {
      ...detail().diagnosis!,
      steps: { records: { state: "done", since }, certificate: { state: "problem", since } },
      issues: [{ code: "cname_proxied", values: ["104.16.1.1"] }, { code: "provider_error", message: "upstream" }],
    },
  }));
  expect(stuck.phase).toBe("problem");
  expect(stuck.issues).toEqual([
    expect.objectContaining({ code: "cname_proxied", fix: expect.stringContaining("DNS only") }),
    expect.objectContaining({ code: "provider_error" }),
  ]);

  const live = domainSetup(detail({ status: "active" }));
  expect(live).toMatchObject({ phase: "live", summary: "Live at https://www.horacy.ai (Horacy AI)." });

  const unassigned = domainSetup(detail({ status: "active", assignment: null }));
  expect(unassigned.phase).toBe("website");
  expect(unassigned.nextSteps[0]).toContain("--deployment");

  expect(domainSetup(detail({ removalPending: true })).phase).toBe("removing");
});

test("shows a domain found by hostname or ID", async () => {
  const { api, calls } = fakeApi(({ path }) => (path === "domains" ? ok([summary]) : ok(detail())));
  await expect(showDomain(api, "https://www.horacy.ai")).resolves.toMatchObject({ domain: { id: "d1" }, setup: { phase: "records" } });
  await expect(showDomain(api, "d1")).resolves.toMatchObject({ domain: { hostname: "www.horacy.ai" } });
  expect(calls.filter((call) => call.path === "domains/d1")).toHaveLength(2);
  await expect(showDomain(api, "blog.horacy.ai")).rejects.toMatchObject({
    code: "domain_not_found", details: { domains: ["www.horacy.ai"] },
  });
});

test("adds a domain to the only website, or asks which one", async () => {
  const one = fakeApi(({ method, path }) => {
    if (path === "deployments") return plain({ deployments: [{ id: "dep1", name: "Horacy AI" }] });
    if (method === "GET" && path === "domains") return ok([]);
    if (method === "POST" && path === "domains") return ok(detail());
    throw new Error("unexpected " + path);
  });
  await expect(addDomain(one.api, "WWW.horacy.ai")).resolves.toMatchObject({ dryRun: false, unchanged: false, setup: { phase: "records" } });
  expect(one.calls.at(-1)).toEqual({ method: "POST", path: "domains", body: { hostname: "www.horacy.ai", deploymentId: "dep1" } });

  const two = fakeApi(({ path }) => path === "domains" ? ok([])
    : plain({ deployments: [{ id: "dep1", name: "Main" }, { id: "dep2", name: "Blog" }] }));
  await expect(addDomain(two.api, "www.horacy.ai")).rejects.toMatchObject({ code: "deployment_required" });
  await expect(addDomain(two.api, "www.horacy.ai", { deployment: "blog", dryRun: true }))
    .resolves.toEqual({ dryRun: true, unchanged: false, hostname: "www.horacy.ai", deployment: { id: "dep2", name: "Blog" } });
});

test("adding a domain twice is safe; adding it for another website is a conflict", async () => {
  const deployments = () => plain({ deployments: [{ id: "dep1", name: "Horacy AI" }, { id: "dep2", name: "Blog" }] });
  const existing = fakeApi(({ method, path }) => {
    if (path === "deployments") return deployments();
    if (method === "GET" && path === "domains") return ok([summary]);
    if (method === "GET" && path === "domains/d1") return ok(detail());
    throw new Error("unexpected " + method + " " + path);
  });
  // Already connected to dep1: no --deployment needed, nothing is created.
  await expect(addDomain(existing.api, "www.horacy.ai")).resolves.toMatchObject({ dryRun: false, unchanged: true, domain: { id: "d1" } });
  await expect(addDomain(existing.api, "www.horacy.ai", { deployment: "Horacy AI" })).resolves.toMatchObject({ unchanged: true });
  expect(existing.calls.some((call) => call.method === "POST")).toBe(false);
  await expect(addDomain(existing.api, "www.horacy.ai", { deployment: "blog" })).rejects.toMatchObject({
    code: "already_exists", exitCode: 5,
    details: { differences: { deployment: { current: "dep1", wanted: "dep2" } } },
    fix: expect.stringContaining("atmyapp domains edit www.horacy.ai"),
  });
  await expect(addDomain(existing.api, "www.horacy.ai", { deployment: "blog", dryRun: true })).rejects.toMatchObject({ code: "already_exists" });
  await expect(addDomain(existing.api, "www.horacy.ai", { dryRun: true })).resolves.toMatchObject({ dryRun: true, unchanged: true });
});

test("edits only what was asked and refuses empty or contradictory edits", async () => {
  const { api, calls } = fakeApi(({ method, path }) => {
    if (path === "domains") return ok([summary]);
    if (method === "PUT") return ok(detail({ routeStatus: "disabled" }));
    throw new Error("unexpected " + path);
  });
  await expect(editDomain(api, "www.horacy.ai", { disable: true, spaFallback: true })).resolves.toMatchObject({ dryRun: false });
  expect(calls.at(-1)).toEqual({ method: "PUT", path: "domains/d1", body: { routeStatus: "disabled", spaFallback: true } });
  await expect(editDomain(api, "www.horacy.ai", {})).rejects.toMatchObject({ code: "nothing_to_change" });
  await expect(editDomain(api, "www.horacy.ai", { enable: true, disable: true })).rejects.toMatchObject({ code: "invalid_options" });
  await expect(editDomain(api, "www.horacy.ai", { notFoundPage: "404.html" })).rejects.toMatchObject({ code: "invalid_options" });
});

test("check --wait follows the setup until it needs nobody", async () => {
  let reads = 0;
  const phases = [detail(), detail({ status: "ssl_pending", diagnosis: { ...detail().diagnosis!, steps: { records: { state: "done", since }, certificate: { state: "waiting", since } } } }), detail({ status: "active" })];
  const { api, calls } = fakeApi(({ method, path }) => {
    if (path === "domains") return ok([summary]);
    if (method === "POST") return ok(phases[0]);
    return ok(phases[Math.min(++reads, 2)]);
  });
  const seen: string[] = [];
  const result = await checkDomain(api, "www.horacy.ai", { wait: true, sleep: async () => undefined, onProgress: (setup) => seen.push(setup.phase) });
  expect(result.setup.phase).toBe("live");
  expect(seen).toEqual(["records", "certificate", "live"]);
  expect(calls.filter((call) => call.method === "POST")).toEqual([{ method: "POST", path: "domains/d1/verify", body: {} }]);

  let clock = 0;
  const stuck = fakeApi(({ path }) => (path === "domains" ? ok([summary]) : ok(detail())));
  await expect(checkDomain(stuck.api, "d1", {
    wait: true, timeoutMs: 60_000, now: () => clock, sleep: async (ms) => { clock += ms; },
  })).rejects.toMatchObject({
    code: "needs_person", exitCode: 6,
    details: { reason: "dns", phase: "records", resume: "atmyapp domains check www.horacy.ai --wait" },
  });

  const issuing = fakeApi(({ path }) => (path === "domains" ? ok([summary]) : ok(detail({
    diagnosis: { ...detail().diagnosis!, steps: { records: { state: "done", since }, certificate: { state: "waiting", since } } },
  }))));
  clock = 0;
  await expect(checkDomain(issuing.api, "d1", {
    wait: true, timeoutMs: 60_000, now: () => clock, sleep: async (ms) => { clock += ms; },
  })).rejects.toMatchObject({ code: "domain_timeout", exitCode: 8, details: { state: "certificate" } });

  const stuckProblem = fakeApi(({ path }) => (path === "domains" ? ok([summary]) : ok(detail({
    diagnosis: {
      ...detail().diagnosis!,
      steps: { records: { state: "done", since }, certificate: { state: "problem", since } },
      issues: [{ code: "cname_proxied", values: ["104.16.1.1"] }],
    },
  }))));
  await expect(checkDomain(stuckProblem.api, "d1", { wait: true, sleep: async () => undefined }))
    .rejects.toMatchObject({ code: "needs_person", details: { reason: "dns", phase: "problem" } });
});

test("removes a domain, or only reports it on a dry run", async () => {
  const { api, calls } = fakeApi(({ path, method }) => (path === "domains" ? ok([summary]) : method === "DELETE" ? ok({ deletionPending: true }) : plain({}, 500)));
  await expect(removeDomain(api, "www.horacy.ai", true)).resolves.toMatchObject({ dryRun: true, hostname: "www.horacy.ai" });
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  await expect(removeDomain(api, "www.horacy.ai")).resolves.toMatchObject({ dryRun: false, removalPending: true, removed: true });
  expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "domains/d1" });
  await expect(removeDomain(api, "blog.horacy.ai")).rejects.toMatchObject({ code: "domain_not_found" });
  await expect(removeDomain(api, "blog.horacy.ai", false, { ifExists: true }))
    .resolves.toEqual({ id: null, hostname: "blog.horacy.ai", dryRun: false, removalPending: false, removed: false });
});

test("removing a domain that's already being removed sends nothing", async () => {
  const { api, calls } = fakeApi(({ path }) => (path === "domains" ? ok([{ ...summary, removalPending: true }]) : plain({}, 500)));
  await expect(removeDomain(api, "www.horacy.ai")).resolves.toMatchObject({ removed: true, removalPending: true });
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
});
