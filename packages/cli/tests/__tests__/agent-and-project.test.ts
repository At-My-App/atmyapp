import { Command } from "commander";
import { detectAgent } from "../../src/runtime/agent";
import { ApiClient } from "../../src/runtime/api";
import { requestedProject, withCommonOptions } from "../../src/cli/output";

test("labels Claude Code and honours an explicit ATMYAPP_AGENT", () => {
  expect(detectAgent({ CLAUDECODE: "1" })).toBe("Claude Code");
  expect(detectAgent({})).toBeUndefined();
  expect(detectAgent({ ATMYAPP_AGENT: "My CI bot", CLAUDECODE: "1" })).toBe("My CI bot");
  expect(detectAgent({ ATMYAPP_AGENT: "x\nInjected: header" })).toBe("xInjected header");
  expect(detectAgent({ ATMYAPP_AGENT: "a".repeat(200) })).toHaveLength(60);
});

test("sends the agent label with every request", async () => {
  const seen: Array<Record<string, string>> = [];
  const api = new ApiClient({ token: "ama_pk_" + "x".repeat(32), projectId: "p1", url: "https://api.test/v0/projects/p1" }, {
    agent: "Claude Code",
    fetch: async (_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      return Response.json({ success: true, data: [] });
    },
  });
  await api.json("GET", "domains");
  expect(seen[0]["X-AtMyApp-Agent"]).toBe("Claude Code");
});

test("--project is the documented option; --project-id still works", () => {
  const parse = (...args: string[]) => withCommonOptions(new Command("x")).exitOverride().parse(args, { from: "user" }).opts();
  expect(requestedProject(parse("--project", "p2"))).toBe("p2");
  expect(requestedProject(parse("--project-id", "p3"))).toBe("p3");
  expect(requestedProject(parse())).toBeUndefined();
  const help = withCommonOptions(new Command("x")).helpInformation();
  expect(help).toContain("--project <id>");
  expect(help).not.toContain("--project-id");
});

test("snapshot and migrate take the standard connection options; old short flags stay hidden", () => {
  const { snapshotCommand } = require("../../src/cli/commands/snapshot");
  const { migrateCommand, migrateStatusCommand } = require("../../src/cli/commands/migrate");
  const create = (snapshotCommand() as Command).commands.find((command) => command.name() === "create")!;
  const help = create.helpInformation();
  expect(help).toContain("--project <id>");
  expect(help).toContain("--json");
  expect(help).not.toMatch(/-t <token>|-u <url>|-p <id>/);
  const parsed = create.exitOverride().parseOptions(["-t", "tok", "-u", "https://api.test", "-p", "p9"]);
  expect(parsed.unknown).toEqual([]);
  expect(create.opts()).toMatchObject({ t: "tok", u: "https://api.test", p: "p9" });
  for (const command of [migrateCommand(), migrateStatusCommand()] as Command[]) {
    const text = command.helpInformation();
    expect(text).toContain("--project <id>");
    expect(text).toContain("--token <key>");
  }
});

test("migrate never switches to a browser login for another project", async () => {
  jest.resetModules();
  jest.doMock("../../src/runtime/credentials", () => ({
    ...jest.requireActual("../../src/runtime/credentials"),
    readBrowserLogin: () => ({ token: "ama_cs_login", url: "https://api.test/v0/projects/other", projectId: "other" }),
  }));
  const { resolveCredentials } = require("../../src/runtime/session");
  const { readBrowserLogin } = require("../../src/runtime/credentials");
  // Same inputs migrate passes: the session file's project pins the login out.
  const session = resolveCredentials({
    flags: { projectId: "p1" },
    env: {},
    loginSession: readBrowserLogin,
    sessionFile: { url: "https://api.test/v0/projects/p1", token: "ama_pk_file" },
  });
  expect(session).toMatchObject({ token: "ama_pk_file", projectId: "p1" });
  jest.dontMock("../../src/runtime/credentials");
});
