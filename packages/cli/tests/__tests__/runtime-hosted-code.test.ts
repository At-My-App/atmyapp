import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitCredential, parseCredentialInput, pushedBranches } from "../../src/runtime/hostedCode";

describe("git credential helper for code stored in AtMyApp", () => {
  let config: string;
  const previous = { ...process.env };

  beforeEach(() => {
    config = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-git-"));
    process.env.XDG_CONFIG_HOME = config;
    process.env.ATMYAPP_GIT_PROJECT = "project-1";
    process.env.ATMYAPP_GIT_CODE_SOURCE = "source-1";
  });
  afterEach(() => {
    process.env = { ...previous };
    fs.rmSync(config, { recursive: true, force: true });
  });

  const input = "protocol=https\nhost=acct.artifacts.cloudflare.net\npath=git/code/p-1-abc.git\n\n";

  it("parses git's key=value input", () => {
    expect(parseCredentialInput(input)).toEqual({ protocol: "https", host: "acct.artifacts.cloudflare.net", path: "git/code/p-1-abc.git" });
  });

  it("stays silent for other hosts so git asks its other helpers", async () => {
    const api = { json: jest.fn() };
    const out = await gitCredential("get", "protocol=https\nhost=github.com\n", () => api as any, { cwd: config });
    expect(out).toBe("");
    expect(api.json).not.toHaveBeenCalled();
  });

  it("asks the server once, then answers from the cache until near expiry", async () => {
    const expires = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const api = { json: jest.fn(async () => ({ username: "x", password: "secret", expires_at: expires, scope: "write" })) };
    const first = await gitCredential("get", input, () => api as any, { cwd: config });
    expect(first).toContain("username=x\npassword=secret\n");
    expect(first).toMatch(/password_expiry_utc=\d+/);
    expect(api.json).toHaveBeenCalledWith("POST", "code-sources/source-1/git-credential", expect.objectContaining({ body: { host: "acct.artifacts.cloudflare.net", path: "git/code/p-1-abc.git" } }));
    await gitCredential("get", input, () => api as any, { cwd: config });
    expect(api.json).toHaveBeenCalledTimes(1);
    const cache = path.join(config, "atmyapp", "git-credentials.json");
    expect(fs.statSync(cache).mode & 0o077).toBe(0);
    await gitCredential("erase", input, () => api as any, { cwd: config });
    await gitCredential("get", input, () => api as any, { cwd: config });
    expect(api.json).toHaveBeenCalledTimes(2);
  });
});

it("tracks the destination and commit of each updated branch", () => {
  const sha = "a".repeat(40);
  const resolve = jest.fn(() => sha);
  const updates = pushedBranches([
    "*\tHEAD:refs/heads/release\t[new branch]",
    `+\trefs/heads/main:refs/heads/live\t123...${sha} (forced update)`,
    "=\trefs/heads/main:refs/heads/main\t[up to date]",
    "-\t:refs/heads/old\t[deleted]",
    "*\trefs/tags/v1:refs/tags/v1\t[new tag]",
  ].join("\n"), resolve);
  expect(updates).toEqual([{ branch: "release", sha }, { branch: "live", sha }]);
  expect(resolve.mock.calls).toEqual([["HEAD"]]);
});
