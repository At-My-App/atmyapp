import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { contentCommand } from "../../src/cli/commands/content";
import { helpCommand } from "../../src/cli/commands/help";
import { useCommand } from "../../src/cli/commands/use";
import { whoamiCommand } from "../../src/cli/commands/whoami";
import { EXIT } from "../../src/runtime/errors";

/** Runs one command and returns its single JSON document from stdout. */
async function run(command: Command, args: string[]): Promise<any> {
  let out = "";
  const write = jest.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    command.exitOverride();
    await command.parseAsync(["node", command.name(), ...args]);
  } finally {
    write.mockRestore();
    error.mockRestore();
  }
  return out ? JSON.parse(out) : null;
}

describe("--json output and exit codes", () => {
  const env = { ...process.env };
  let cwd: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cmd-"));
    process.chdir(cwd);
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    process.env = { ...env };
    process.exitCode = undefined;
    (globalThis as any).fetch = undefined;
  });

  it("whoami reads ATMYAPP_CLI_* and prints { ok, data }", async () => {
    process.env.ATMYAPP_CLI_URL = "https://api.test/v0/projects/p1";
    process.env.ATMYAPP_CLI_KEY = "ama_pk_x";
    const calls: string[] = [];
    (globalThis as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return new Response(
        JSON.stringify({
          success: true,
          data: { valid: true, projectId: "p1", keyName: "CI", scopes: ["snapshot"], keyHint: "ama_pk_…x", effectiveScopes: ["schema.read", "content.read", "snapshot"], stoppedReason: null },
        }),
        { status: 200 },
      );
    });
    const output = await run(whoamiCommand(), ["--json"]);
    expect(calls).toEqual(["https://api.test/v0/cli-keys/auth/verify Bearer ama_pk_x"]);
    expect(output).toEqual({
      ok: true,
      data: expect.objectContaining({
        projectId: "p1",
        key: expect.objectContaining({ name: "CI", hint: "ama_pk_…x", effectiveScopes: ["schema.read", "content.read", "snapshot"] }),
        sources: { token: "env", url: "env", projectId: "url" },
      }),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("prints { ok: false, error } with the error's exit code", async () => {
    const output = await run(contentCommand(), ["get", "not-a-ref", "--json"]);
    expect(output).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid_ref", fix: expect.any(String) }) });
    expect(process.exitCode).toBe(EXIT.usage);
  });

  it("names the missing connection as an auth error", async () => {
    delete process.env.ATMYAPP_CLI_URL;
    delete process.env.ATMYAPP_CLI_KEY;
    const output = await run(contentCommand(), ["ls", "--json"]);
    expect(output.error).toMatchObject({ code: "not_connected" });
    expect(process.exitCode).toBe(EXIT.auth);
  });

  it("use never waits for input without a terminal", async () => {
    delete process.env.ATMYAPP_CLI_URL;
    delete process.env.ATMYAPP_CLI_KEY;
    const isTTY = process.stdin.isTTY;
    (process.stdin as any).isTTY = false;
    try {
      const output = await run(useCommand(), ["--json"]);
      expect(output.error).toMatchObject({ code: "needs_confirmation", fix: expect.stringContaining("--url") });
      expect(process.exitCode).toBe(EXIT.confirmation);
    } finally {
      (process.stdin as any).isTTY = isTTY;
    }
  });

  it("help --json describes commands, options and exit codes", async () => {
    const program = new Command("atmyapp").addCommand(contentCommand());
    program.addCommand(helpCommand(program));
    const output = await run(program, ["help", "content", "get", "--json"]);
    expect(output.ok).toBe(true);
    expect(output.data).toMatchObject({ name: "get", path: "atmyapp content get", exitCodes: EXIT });
    expect(output.data.arguments[0]).toMatchObject({ name: "ref", required: true });
    expect(output.data.options.map((option: any) => option.flags)).toEqual(
      expect.arrayContaining(["--locale <locale>", "--view <view>", "--pointer <pointer>", "--json", "--local"]),
    );
    expect(output.data.options.find((option: any) => option.flags === "--view <view>").choices).toEqual(["stored", "delivered", "overlay", "effective"]);
  });
});
