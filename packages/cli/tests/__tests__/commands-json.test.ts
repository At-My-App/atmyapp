import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { contentCommand } from "../../src/cli/commands/content";
import { helpCommand } from "../../src/cli/commands/help";
import { useCommand } from "../../src/cli/commands/use";
import { whoamiCommand } from "../../src/cli/commands/whoami";
import { EXIT } from "../../src/runtime/errors";
import { CLI_VERSION } from "../../src/cli/output";
import { outputSchemaFor } from "../../src/runtime/schemas/help";
import { run } from "../helpers/run-command";

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
    expect(outputSchemaFor("whoami")!.parse(output)).toEqual(output);
  });

  it.each(["whoami", "use"])("%s reports the server's minimum CLI version", async (name) => {
    process.env.ATMYAPP_CLI_URL = "https://api.test/v0/projects/p1";
    process.env.ATMYAPP_CLI_KEY = "ama_pk_x";
    globalThis.fetch = jest.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get("X-AtMyApp-CLI-Version")).toBe(CLI_VERSION);
      return Response.json({ success: false, code: "cli_upgrade_required", minVersion: "1.2.3" }, { status: 426 });
    });
    const output = await run(name === "whoami" ? whoamiCommand() : useCommand(), ["--json"]);
    expect(outputSchemaFor(name)!.parse(output)).toEqual(output);
    expect(output).toMatchObject({
      ok: false,
      error: { code: "upgrade_required", fix: "npm install --save-dev @atmyapp/cli@latest", status: 426, details: { minVersion: "1.2.3" } },
    });
    expect(process.exitCode).toBe(EXIT.error);
  });

  it("prints { ok: false, error } with the error's exit code", async () => {
    const output = await run(contentCommand(), ["get", "not-a-ref", "--json"]);
    expect(output).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid_ref", fix: expect.any(String) }) });
    expect(outputSchemaFor("content get")!.parse(output)).toEqual(output);
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
    expect(outputSchemaFor("help")!.parse(output)).toEqual(output);
    expect(output.data.outputSchema).toMatchObject({ oneOf: expect.any(Array) });
  });
});
