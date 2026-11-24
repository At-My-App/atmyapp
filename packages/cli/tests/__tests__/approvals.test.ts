import { Command } from "commander";
import { ApiClient, replayState } from "../../src/runtime/api";
import { EXIT } from "../../src/runtime/errors";
import { hostingDeploy } from "../../src/runtime/hosting";
import { resumeCommand, withApprovalOptions } from "../../src/cli/output";

const login = { token: "ama_cs_" + "a".repeat(64), projectId: "p1", url: "https://api.test/v0/projects/p1" };
const pending = {
  id: "a1", code: "ABCD-1234", url: "https://app.atmyapp.com/approve/ABCD-1234",
  summary: "Remove www.example.com from Horacy AI.", expiresAt: "2026-11-24T12:15:00Z", pollAfterMs: 1000,
};
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });

/** A server that asks once, then answers polls from `decisions` in order. */
function server(decisions: string[], after: () => Response = () => json({ success: true, data: { removed: true } })) {
  const calls: string[] = [];
  let asked = false;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.startsWith("/v0/cli-approvals/")) {
      return json({ success: true, data: { approval: { ...pending, status: decisions.shift() ?? "pending" } } });
    }
    if (!asked) {
      asked = true;
      return json({ success: false, code: "approval_required", error: pending.summary, approval: pending }, 428);
    }
    return after();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function client(fetch: typeof globalThis.fetch, approval: Record<string, unknown> = {}) {
  const waiting: string[] = [];
  const api = new ApiClient(login, {
    fetch,
    approval: { sleep: async () => undefined, resume: "atmyapp domains rm www.example.com --yes", onWaiting: (item) => waiting.push(item.url), ...approval },
  });
  return { api, waiting };
}

describe("approvals (CliEverywherePlan §4.4.2)", () => {
  beforeEach(() => { replayState.replayed = false; });

  it("prints the link, waits for the decision and sends the same request again", async () => {
    const { fetch, calls } = server(["pending", "approved"]);
    const { api, waiting } = client(fetch);
    await expect(api.json("DELETE", "domains/d7")).resolves.toEqual({ removed: true });
    expect(waiting).toEqual([pending.url]);
    expect(calls).toEqual([
      "DELETE /v0/projects/p1/domains/d7",
      "GET /v0/cli-approvals/a1",
      "GET /v0/cli-approvals/a1",
      "DELETE /v0/projects/p1/domains/d7",
    ]);
  });

  it("stops at once with --no-wait, saying how to continue", async () => {
    const { fetch } = server([]);
    const { api, waiting } = client(fetch, { wait: false });
    await expect(api.json("DELETE", "domains/d7")).rejects.toMatchObject({
      code: "needs_person",
      exitCode: EXIT.confirmation,
      details: { reason: "approval", approvalId: "a1", url: pending.url, resume: "atmyapp domains rm www.example.com --yes" },
    });
    expect(waiting).toEqual([]);
  });

  it("exits 3 when denied and 6 when nobody answered in time", async () => {
    await expect(client(server(["denied"]).fetch).api.json("DELETE", "domains/d7")).rejects.toMatchObject({
      code: "approval_denied", exitCode: EXIT.auth,
    });
    await expect(client(server(["expired"]).fetch).api.json("DELETE", "domains/d7")).rejects.toMatchObject({
      code: "needs_person", details: { reason: "approval" },
    });
    await expect(client(server([]).fetch, { timeoutMs: 0 }).api.json("DELETE", "domains/d7")).rejects.toMatchObject({
      code: "needs_person", exitCode: EXIT.confirmation,
    });
  });

  it("asks once more when what was approved changed", async () => {
    let attempt = 0;
    const stale: string[] = [];
    const { fetch, calls } = server(["approved", "approved"], () => {
      attempt += 1;
      return attempt === 1
        ? json({ success: false, code: "approval_stale", error: "changed", details: { now: "Publish draft (revision 13)" } }, 409)
        : attempt === 2
          ? json({ success: false, code: "approval_required", error: "again", approval: { ...pending, id: "a2" } }, 428)
          : json({ success: true, data: { committed: true } });
    });
    const { api } = client(fetch, { onStale: (message: string) => stale.push(message) });
    await expect(api.json("POST", "staging/commit", { body: {} })).resolves.toEqual({ committed: true });
    expect(stale).toEqual(["What you approved changed. Asking again: Publish draft (revision 13)"]);
    expect(calls.filter((call) => call.startsWith("GET /v0/cli-approvals/a2"))).toHaveLength(1);
  });

  it("reports a replay of a request that already ran", async () => {
    const api = new ApiClient(login, { fetch: (async () => json({ success: true, data: { removed: true } }, 200, { "x-atmyapp-replayed": "1" })) as never });
    await api.json("DELETE", "domains/d7");
    expect(replayState.replayed).toBe(true);
  });

  it("explains a lost key secret and how to replace the key", async () => {
    const api = new ApiClient(login, {
      fetch: (async () => json({ success: false, code: "key_secret_lost", error: "lost", details: { keyId: "k1", name: "CI deploy", keyHint: "ama_pk_…k3f9" } }, 409)) as never,
    });
    await expect(api.json("POST", "project-keys", { body: {} })).rejects.toMatchObject({
      code: "key_secret_lost", exitCode: EXIT.error, fix: expect.stringContaining('keys create --name "CI deploy" --replace'),
    });
  });

  it("builds without promoting with --no-promote (E37)", async () => {
    const bodies: unknown[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return json({ release: { id: "r1", deployment_id: "w1", status: "pending" } }, 202);
      }
      return path.endsWith("/deployments")
        ? json({ deployments: [{ id: "w1", name: "Main", build_preset_id: "b1" }] })
        : json({ deployment: { id: "w1", name: "Main", build_preset_id: "b1" } });
    }) as never;
    await hostingDeploy(new ApiClient(login, { fetch }), { promote: false });
    await hostingDeploy(new ApiClient(login, { fetch }), {});
    expect(bodies).toEqual([
      { operationId: expect.any(String), promote: false },
      { operationId: expect.any(String) },
    ]);
  });

  it("gives each deploy its own operation ID, and an interrupted one the same ID again (§11.1 P1-5)", async () => {
    const ids: string[] = [];
    let lose = false;
    const fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        ids.push(JSON.parse(String(init.body)).operationId);
        if (lose) {
          lose = false;
          throw new TypeError("connection reset");
        }
        return json({ release: { id: `r${ids.length}`, deployment_id: "w1", status: "pending" } }, 202);
      }
      return new URL(url).pathname.endsWith("/deployments")
        ? json({ deployments: [{ id: "w1", name: "Main", build_preset_id: "b1" }] })
        : json({ deployment: { id: "w1", name: "Main", build_preset_id: "b1" } });
    }) as never;
    const api = new ApiClient(login, { fetch });
    await hostingDeploy(api, {});
    await hostingDeploy(api, {});
    expect(ids[0]).not.toBe(ids[1]);
    lose = true;
    await expect(hostingDeploy(api, {})).rejects.toMatchObject({ code: "network" });
    await hostingDeploy(api, {});
    expect(ids[3]).toBe(ids[2]);
  });
});

describe("approval options", () => {
  it("adds --no-wait and --approval-timeout without changing a command's own --wait", () => {
    const deploy = new Command("deploy").option("--json").option("--token <key>").option("--wait");
    const plain = new Command("ls").option("--json").option("--token <key>");
    const root = new Command("atmyapp").addCommand(new Command("hosting").addCommand(deploy)).addCommand(plain);
    withApprovalOptions(root);
    expect(deploy.opts().wait).toBeUndefined();
    deploy.parse(["--no-wait"], { from: "user" });
    expect(deploy.opts().wait).toBe(false);
    expect(plain.options.map((option) => option.long)).toEqual(expect.arrayContaining(["--no-wait", "--approval-timeout"]));
  });

  it("names the command to run again, without --no-wait", () => {
    expect(resumeCommand(["domains", "rm", "www.example.com", "--yes", "--no-wait"])).toBe("atmyapp domains rm www.example.com --yes");
    expect(resumeCommand(["stage", "commit", "-m", "Spring menu"])).toBe("atmyapp stage commit -m 'Spring menu'");
  });

  it("never repeats a credential in the resume command (§11.1 P1-3)", async () => {
    const secret = "ama_pt_" + "b".repeat(64);
    for (const argv of [
      ["domains", "rm", "www.example.com", "--token", secret, "--yes"],
      ["domains", "rm", "www.example.com", `--token=${secret}`, "--yes"],
      ["submissions", "tail", "-t", secret],
    ]) {
      expect(resumeCommand(argv)).not.toContain(secret);
    }
    expect(resumeCommand(["domains", "rm", "x", "--token", secret])).toBe("atmyapp domains rm x");
    // And not in the JSON error a timeout or --no-wait prints.
    const { fetch } = server([]);
    const api = new ApiClient({ ...login, token: secret }, {
      fetch, approval: { wait: false, resume: resumeCommand(["domains", "rm", "www.example.com", "--token", secret, "--yes"]) },
    });
    const error = await api.json("DELETE", "domains/d7").catch((failure) => failure);
    expect(JSON.stringify(error.toJSON())).not.toContain(secret);
    expect(error.message + (error.fix ?? "")).not.toContain(secret);
  });
});
