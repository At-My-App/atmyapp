import { spawn } from "node:child_process";
import { Command } from "commander";
import { readBrowserLogin } from "../../runtime/credentials";
import { DEFAULT_LOGIN_URL, login, logout, parseScopes } from "../../runtime/login";
import { CLI_ENV, detectProjectIdFromUrl } from "../../runtime/session";
import { CLI_VERSION, readSessionFile, runAction, type CommonOptions } from "../output";

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

type LoginOptions = CommonOptions & { project?: string; scopes?: string; browser: boolean; dryRun?: boolean };

export const loginCommand = () => new Command("login")
  .description("Sign in from the browser with project-specific permissions")
  .option("--project <id>", "Project to authorize")
  .option("--scopes <list>", "Comma-separated permissions (defaults to schema.read,content.read)")
  .option("--url <url>", "Override the AtMyApp API URL")
  .option("--no-browser", "Print the verification link without opening a browser")
  .option("--json", "Print the result as JSON")
  .option("--verbose", "Show more detail")
  .option("--dry-run", "Show the request without starting a login")
  .addHelpText("after", "\nExample: atmyapp login --project my-site --scopes content.read,content.stage")
  .action((options: LoginOptions) => runAction(options, async () => {
    let url = options.url || process.env[CLI_ENV.url];
    if (!url) {
      try { url = readBrowserLogin()?.url || readSessionFile()?.url; }
      catch { /* Login can replace a local connection. */ }
    }
    url ||= DEFAULT_LOGIN_URL;
    return login({
      url,
      projectId: options.project || process.env[CLI_ENV.projectId] || detectProjectIdFromUrl(url),
      scopes: parseScopes(options.scopes, true),
      dryRun: options.dryRun,
    }, {
      cliVersion: CLI_VERSION,
      verify: (verificationUrl, userCode) => {
        console.error("Open " + verificationUrl);
        console.error("Match code " + userCode.slice(0, 4) + "-" + userCode.slice(4) + " in your browser.");
        if (options.browser) openBrowser(verificationUrl);
      },
    });
  }, (result) => console.log(result.dryRun
    ? "Would request " + result.scopes.join(", ") + " for " + (result.projectId ?? "a project you choose in your browser") + "."
    : "Signed in to " + result.projectId + ". Session expires " + result.expiresAt + ".")));

export const logoutCommand = () => new Command("logout")
  .description("Revoke the browser login saved on this computer")
  .option("--dry-run", "Check for a saved login without revoking it")
  .option("--json", "Print the result as JSON")
  .addHelpText("after", "\nExample: atmyapp logout --json")
  .action((options: CommonOptions & { dryRun?: boolean }) => runAction(options,
    () => logout({ cliVersion: CLI_VERSION, dryRun: options.dryRun }),
    (result) => console.log(result.dryRun ? "Dry run complete." : result.loggedOut ? "Signed out." : "No browser login is saved."),
  ));
