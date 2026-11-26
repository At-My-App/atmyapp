import chalk from "chalk";
import { Command, Option } from "commander";
import { waitTimeout } from "../../runtime/duration";
import {
  addCodeSource,
  codeSourceName,
  connectGithub,
  listVisibleCodeSources,
  listRepositories,
  removeCodeSource,
  syncCodeSource,
} from "../../runtime/code";
import { cloneHostedCode, createHostedCode, findHostedCode, gitCredential, pushHostedCode, setupGit } from "../../runtime/hostedCode";
import {
  connectWebsite,
  createPreset,
  createPreviewServer,
  createWebsite,
  editPreset,
  editPreviewServer,
  editWebsite,
  listEnv,
  listPresets,
  listSecrets,
  listWebsites,
  removeEnv,
  removeSecret,
  removeWebsite,
  secretValue,
  setEnv,
  setSecret,
  showPreset,
} from "../../runtime/setup";
import {
  addLocale,
  cleanupJobs,
  createForm,
  editCollection,
  editForm,
  formLayout,
  imagePolicy,
  listForms,
  removeForm,
  removeLocale,
  seoSettings,
  setDefaultLocale,
  setImagePolicy,
  verifyCaptcha,
} from "../../runtime/settings";
import { changeRole, inviteMember, removeMember, revokeInvitation, team, teamReach } from "../../runtime/team";
import { connect, printValue, requestedProject, resumeCommand, runAction, table, withCommonOptions, type CommonOptions } from "../output";
import { confirm } from "./draftOptions";

/**
 * Project setup from the CLI (CliEverywherePlan §5.5): code sources,
 * websites, presets, environment variables, secrets, preview servers,
 * languages, settings, collections and forms. Changes that delete things or
 * change access ask for the owner's approval with a personal login.
 */

type Opts = CommonOptions & Record<string, unknown>;
type WaitOpts = Opts & { wait?: boolean; timeout?: string };

function onOff(value: string): boolean {
  if (/^(on|true|yes)$/i.test(value)) return true;
  if (/^(off|false|no)$/i.test(value)) return false;
  throw new Error("Use on or off.");
}

function port(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error("Use a port from 1024 to 65535.");
  return number;
}

const progress = (json: boolean) => (json ? undefined : (status: string) => console.error(chalk.gray(`… ${status}`)));

// --- atmyapp code ---------------------------------------------------------------------

export function codeCommand(): Command {
  const github = withCommonOptions(new Command("github"))
    .description("Connect your GitHub account and give the AtMyApp app access to a repository")
    .option("--repo <owner/repo>", "Finish when this repository is reachable")
    .option("--wait", "Wait for the browser step (default; --no-wait returns at once)")
    .option("--timeout <duration>", "Longest wait: 5s to 30m (default 10m)")
    .addHelpText("after", "\nOne browser step: the command prints a link, then continues when GitHub lists the repository. Exit 6 (needs_person, reason browser) says which is missing: github_authorization_expired, github_not_installed or github_repo_not_granted.\n\nExample: atmyapp code connect github --repo gamrot/site")
    .action((opts: WaitOpts & { repo?: string }) => runAction(opts, ({ json }) => connectGithub(connect(opts).api, {
      repo: opts.repo,
      wait: opts.wait !== false,
      timeoutMs: waitTimeout("github", opts.timeout),
      resume: resumeCommand(),
      onWaiting: json ? undefined : (step) => {
        console.error(chalk.yellow("Browser step: ") + step.message);
        if (typeof step.details?.url === "string") console.error(step.details.url);
        console.error(chalk.gray("Waiting — Ctrl+C to stop; run the command again to continue."));
      },
    }), (result) => console.log(result.repository ? `Connected: ${result.repository.fullName}.` : `Connected: ${result.repositories} repositories reachable.`)));

  return new Command("code").description("Connect code repositories to the project")
    .addCommand(new Command("connect").description("Connect a code provider").addCommand(github))
    .addCommand(withCommonOptions(new Command("repos"))
      .description("Repositories your GitHub account can connect")
      .action((opts: Opts) => runAction(opts, () => listRepositories(connect(opts).api),
        (result) => console.log(table(result.repositories.map((repo) => ({ repository: repo.fullName, branch: repo.defaultBranch, private: repo.private ? "yes" : "" })), ["repository", "branch", "private"])))))
    .addCommand(withCommonOptions(new Command("ls"))
      .description("Code sources of this project")
      .action((opts: Opts) => runAction(opts, () => listVisibleCodeSources(connect(opts).api),
        (result) => console.log(table(result.codeSources.map((source) => ({ id: source.id, repository: codeSourceName(source), stored: source.provider === "atmyapp" ? "AtMyApp" : source.provider === "github" ? "GitHub" : source.provider, branch: source.branch, status: source.status })), ["id", "repository", "stored", "branch", "status"])))))
    // --- Code stored in AtMyApp (HostedCodeSources.md §8) ---
    .addCommand(withCommonOptions(new Command("create"))
      .description("Create a code repository stored in AtMyApp (no GitHub needed)")
      .argument("[name]", "Name used in commands, such as website (default: website)")
      .option("--starter <id>", "Start from a starter instead of an empty repository")
      .action((name: string | undefined, opts: Opts & { starter?: string }) => runAction(opts, () => createHostedCode(connect(opts).api, { name, starter: opts.starter }),
        (result) => {
          console.log(chalk.green(`Created ${result.code.name}.`));
          console.log(`Clone it:  ${result.cloneCommand}`);
          console.log(`Or, in a folder with code:  atmyapp code setup-git ${result.code.name} && git push atmyapp ${result.code.branch}`);
        })))
    .addCommand(withCommonOptions(new Command("clone"))
      .description("Clone code stored in AtMyApp; Git signs in through the CLI")
      .argument("[name]", "Which code (default: the only one)")
      .argument("[directory]", "Folder to clone into (default: the name)")
      .action((name: string | undefined, directory: string | undefined, opts: Opts) => runAction(opts, () => {
        const { api, session } = connect(opts);
        return cloneHostedCode(api, session.projectId, { ref: name, directory });
      }, (result) => {
        console.log(chalk.green(`Cloned ${result.code.name} into ${result.directory}.`));
        if (result.empty) console.log(chalk.gray(`It's empty: add your code, then git push origin ${result.code.branch}.`));
      })))
    .addCommand(withCommonOptions(new Command("setup-git"))
      .description("Add code stored in AtMyApp as a remote of the Git repository in this folder")
      .argument("[name]", "Which code (default: the only one)")
      .option("--remote <name>", "Remote name (default: atmyapp)")
      .action((name: string | undefined, opts: Opts & { remote?: string }) => runAction(opts, () => {
        const { api, session } = connect(opts);
        return setupGit(api, session.projectId, { ref: name, remote: opts.remote });
      }, (result) => console.log(`Remote ${result.remote} → ${result.code.name}. Push with: ${result.pushCommand}`))))
    .addCommand(withCommonOptions(new Command("url"))
      .description("The Git address of code stored in AtMyApp (no password)")
      .argument("[name]", "Which code (default: the only one)")
      .action((name: string | undefined, opts: Opts) => runAction(opts, () => findHostedCode(connect(opts).api, name),
        (result) => console.log(result.remote))))
    .addCommand(withCommonOptions(new Command("push"))
      .description("git push, then show the website build it starts")
      .argument("[git-args...]", "Passed to git push (default: the current branch)")
      .option("--code <name>", "Which code (default: the only one)")
      .option("--remote <name>", "Git remote (default: the one pointing at this code)")
      .action((gitArgs: string[], opts: Opts & { code?: string; remote?: string }) => runAction(opts, () => pushHostedCode(connect(opts).api, {
        ref: opts.code, remote: opts.remote, gitArgs,
      }), (result) => {
        if (!result.updates.length) return console.log("No branch head was updated.");
        console.log(`Pushed ${result.branch}.`);
        for (const release of result.releases) console.log(`Release ${release.id} (${release.status ?? "pending"}). Follow it: atmyapp hosting logs ${release.id}`);
        if (!result.releases.length) console.log("No matching release observed.");
      })))
    .addCommand(withCommonOptions(new Command("add"))
      .description("Connect a repository to this project (safe to run twice)")
      .argument("<owner/repo>", "The repository")
      .option("--branch <name>", "Branch to build (default: the repository's default)")
      .option("--wait", "Wait until the first copy is done")
      .option("--timeout <duration>", "Longest wait with --wait: 5s to 30m (default 5m)")
      .action((ref: string, opts: WaitOpts & { branch?: string }) => runAction(opts, ({ json }) => addCodeSource(connect(opts).api, ref, {
        branch: opts.branch, wait: opts.wait, timeoutMs: waitTimeout("code", opts.timeout), onProgress: progress(json),
      }), (result) => console.log(result.unchanged ? chalk.gray(`${ref} is already connected.`) : chalk.green(`Connected ${ref}.`)))))
    .addCommand(withCommonOptions(new Command("sync"))
      .description("Copy the latest code again")
      .argument("[owner/repo]", "Which code source (default: the only one)")
      .option("--wait", "Wait until the copy is done")
      .option("--timeout <duration>", "Longest wait with --wait (default 5m)")
      .action((ref: string | undefined, opts: WaitOpts) => runAction(opts, ({ json }) => syncCodeSource(connect(opts).api, ref, {
        wait: opts.wait, timeoutMs: waitTimeout("code", opts.timeout), onProgress: progress(json),
      }), (result) => console.log(`${result.codeSource.owner}/${result.codeSource.repo}: ${result.codeSource.status ?? "syncing"}`))))
    .addCommand(withCommonOptions(new Command("rm"))
      .description("Disconnect a repository, or delete code stored in AtMyApp")
      .argument("<owner/repo|name>", "Code source ID, GitHub repository, or the name of code stored in AtMyApp")
      .option("--yes", "Don't ask for confirmation")
      .option("--if-exists", "Succeed when it isn't connected")
      .option("--dry-run", "Show what would be removed")
      .action((ref: string, opts: Opts & { yes?: boolean; ifExists?: boolean; dryRun?: boolean }) => runAction(opts, async () => {
        await confirm(opts as never, ref.includes("/")
          ? `Disconnect ${ref}? Websites built from it stop updating.`
          : `Delete ${ref}? If it's code stored in AtMyApp, the repository and all of its history are deleted and everyone is signed out of Git. Websites built from it stop updating.`);
        return removeCodeSource(connect(opts).api, ref, opts);
      }, (result) => console.log(result.removed ? `Disconnected ${result.repository}.` : result.dryRun ? `Would disconnect ${result.repository}.` : `${result.repository} isn't connected.`))));
}

// --- atmyapp git credential ------------------------------------------------------------

/**
 * Git's credential helper for code stored in AtMyApp (HostedCodeSources.md
 * §6.6). Configured by `code clone` / `code setup-git` for our host only.
 */
export function gitCommand(): Command {
  const credential = new Command("credential")
    .description("Git credential helper (git calls this; you don't need to)")
    .argument("<action>", "get, store or erase")
    .action(async (action: string) => {
      const input = await new Promise<string>((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
      });
      try {
        const output = await gitCredential(action, input, (project) => connect({ project }).api);
        if (output) process.stdout.write(output);
      } catch (error) {
        // Git shows our message, then asks for a password: say what to do instead.
        process.stderr.write(`atmyapp: ${error instanceof Error ? error.message : String(error)}\natmyapp: sign in with 'atmyapp login', then try again.\n`);
      }
    });
  return new Command("git").description("Git integration for code stored in AtMyApp").addCommand(credential);
}

// --- projects website connect ------------------------------------------------------------

export function addProjectWebsite(projects: Command): Command {
  const websiteConnect = withCommonOptions(new Command("connect"))
    .description("Set up the project's first website: build preset, key and preview server")
    .requiredOption("--repo <owner/repo|name>", "The website's repository: GitHub owner/repo (connected first if needed) or the name of code stored in AtMyApp")
    .option("--branch <name>", "Branch to build")
    .option("--root <dir>", "Folder of the website in the repository")
    .option("--framework <name>", "Framework, when detection is wrong")
    .option("--install <command>", "Install command")
    .option("--build <command>", "Build command")
    .option("--output <dir>", "Build output folder")
    .option("--preview-command <command>", "Command that runs the preview server")
    .addOption(new Option("--preview-port <port>", "Port the preview server listens on").argParser(port))
    .option("--preview-url <url>", "Use your own preview server at this address instead")
    .option("--no-preview", "Set up the preview server later")
    .option("--timeout <duration>", "Longest wait for the first code copy (default 5m)")
    .addHelpText("after", "\nSettings the repository suggests are used unless you pass them. Safe to run again after an interruption: it continues where it stopped.\n\nExample: atmyapp projects website connect --repo gamrot/site --wait")
    .action((opts: WaitOpts & Record<string, string | number | boolean | undefined>) => runAction(opts, ({ json }) => connectWebsite(connect(opts).api, {
      repo: opts.repo as string, branch: opts.branch as string | undefined, root: opts.root as string | undefined,
      framework: opts.framework as string | undefined, install: opts.install as string | undefined, build: opts.build as string | undefined,
      output: opts.output as string | undefined, previewCommand: opts.previewCommand as string | undefined,
      previewPort: opts.previewPort as number | undefined, previewUrl: opts.previewUrl as string | undefined,
      preview: opts.preview as boolean | undefined,
      timeoutMs: waitTimeout("code", opts.timeout as string | undefined), onProgress: progress(json),
    }), (result) => {
      console.log(chalk.green(`Website set up from ${result.repository}.`));
      console.log(table(result.steps.map((step) => ({ step: step.id, status: step.status })), ["step", "status"]));
      console.log(chalk.gray("Next: 'atmyapp hosting deploy --wait'."));
    }));
  return projects.addCommand(new Command("website").description("The project's website setup").addCommand(websiteConnect));
}

// --- hosting websites / presets ----------------------------------------------------------

export function addHostingSetup(hosting: Command): Command {
  const websites = new Command("websites").description("Websites of this project")
    .addCommand(withCommonOptions(new Command("ls")).description("List websites")
      .action((opts: Opts) => runAction(opts, () => listWebsites(connect(opts).api),
        (result) => console.log(table(result.websites.map((site) => ({ name: site.name, id: site.id, preset: site.presetId, live: site.activeReleaseId, "auto-promote": site.autoPromote ? "on" : "off" })), ["name", "id", "preset", "live", "auto-promote"])))))
    .addCommand(withCommonOptions(new Command("create")).description("Add a website from an existing build preset (safe to run twice)")
      .argument("<name>", "Website name")
      .option("--preset <name>", "Build preset (default: the only one)")
      .addOption(new Option("--auto-promote <on|off>", "Make successful builds live by themselves (default on)").argParser(onOff))
      .addOption(new Option("--auto-rebuild <on|off>", "Rebuild when content is published (default on)").argParser(onOff))
      .addHelpText("after", "\nA fresh project has no preset: start with 'atmyapp projects website connect'.")
      .action((name: string, opts: Opts & { preset?: string; autoPromote?: boolean; autoRebuild?: boolean }) => runAction(opts,
        () => createWebsite(connect(opts).api, { name, preset: opts.preset, autoPromote: opts.autoPromote, autoRebuild: opts.autoRebuild }),
        (result) => console.log(result.unchanged ? chalk.gray(`${name} already exists.`) : chalk.green(`Created ${name}.`)))))
    .addCommand(withCommonOptions(new Command("edit")).description("Change a website's name, preset or automation")
      .argument("<website>", "Name or ID")
      .option("--name <name>", "New name")
      .option("--preset <name>", "Build preset")
      .addOption(new Option("--auto-promote <on|off>", "Make successful builds live by themselves").argParser(onOff))
      .addOption(new Option("--auto-rebuild <on|off>", "Rebuild when content is published").argParser(onOff))
      .action((ref: string, opts: Opts & { name?: string; preset?: string; autoPromote?: boolean; autoRebuild?: boolean }) => runAction(opts,
        () => editWebsite(connect(opts).api, ref, { name: opts.name, preset: opts.preset, autoPromote: opts.autoPromote, autoRebuild: opts.autoRebuild }),
        (result) => console.log(result.unchanged ? chalk.gray("Nothing to change.") : chalk.green(`Updated ${result.website.name}.`)))))
    .addCommand(withCommonOptions(new Command("rm")).description("Delete a website")
      .argument("<website>", "Name or ID")
      .option("--yes", "Don't ask for confirmation")
      .option("--if-exists", "Succeed when there's no such website")
      .option("--dry-run", "Show what would be deleted")
      .action((ref: string, opts: Opts & { yes?: boolean; ifExists?: boolean; dryRun?: boolean }) => runAction(opts, async () => {
        await confirm(opts as never, `Delete the website ${ref}? Its domains stop showing it.`);
        return removeWebsite(connect(opts).api, ref, opts);
      }, (result) => console.log(result.removed ? `Deleted ${result.name}.` : result.dryRun ? `Would delete ${result.name}.` : `${result.name} doesn't exist.`))));

  const presetOptions = (command: Command) => command
    .option("--branch <name>", "Branch to build")
    .option("--framework <name>", "Framework")
    .option("--install <command>", "Install command")
    .option("--build <command>", "Build command")
    .option("--root <dir>", "Folder of the website in the repository")
    .option("--output <dir>", "Build output folder");
  const presets = new Command("presets").description("Build presets: how a website is built")
    .addCommand(withCommonOptions(new Command("ls")).description("List build presets")
      .action((opts: Opts) => runAction(opts, () => listPresets(connect(opts).api),
        (result) => console.log(table(result.presets.map((preset) => ({ name: preset.name, id: preset.id, branch: preset.branch, build: preset.buildCommand, output: preset.outputDirectory })), ["name", "id", "branch", "build", "output"])))))
    .addCommand(withCommonOptions(new Command("show")).description("One build preset").argument("<preset>", "Name or ID")
      .action((ref: string, opts: Opts) => runAction(opts, () => showPreset(connect(opts).api, ref), (result) => printValue(result.preset))))
    .addCommand(presetOptions(withCommonOptions(new Command("create"))).description("Create a build preset (safe to run twice)")
      .argument("<name>", "Preset name").requiredOption("--repo <owner/repo|name>", "Repository it builds (GitHub owner/repo, or the name of code stored in AtMyApp)")
      .action((name: string, opts: Opts) => runAction(opts, () => createPreset(connect(opts).api, { ...(opts as object), name } as never),
        (result) => console.log(result.unchanged ? chalk.gray(`${name} already exists.`) : chalk.green(`Created ${name}.`)))))
    .addCommand(presetOptions(withCommonOptions(new Command("edit"))).description("Change a build preset").argument("<preset>", "Name or ID")
      .option("--name <name>", "New name")
      .action((ref: string, opts: Opts) => runAction(opts, () => editPreset(connect(opts).api, ref, opts as never),
        (result) => console.log(result.unchanged ? chalk.gray("Nothing to change.") : chalk.green(`Updated ${result.preset.name}.`)))));

  return hosting.addCommand(websites).addCommand(presets);
}

// --- env and secrets ----------------------------------------------------------------------

function withTarget(command: Command): Command {
  return command
    .option("--website <name>", "This website's build (default: the only website)")
    .option("--preview-server <name>", "This preview server instead");
}

type TargetOpts = Opts & { website?: string; previewServer?: string };

export function envCommand(): Command {
  return new Command("env").description("Environment variables of a website or preview server")
    .addHelpText("after", "\nPlain values live on one target. Secrets live once in 'atmyapp secrets' and are attached to each target that needs them.")
    .addCommand(withTarget(withCommonOptions(new Command("ls"))).description("Variables of one target (secret values never show)")
      .action((opts: TargetOpts) => runAction(opts, () => listEnv(connect(opts).api, opts),
        (result) => {
          console.log(chalk.gray(result.target));
          console.log(table(result.variables.map((variable) => ({ name: variable.name, kind: variable.kind, value: variable.value ?? "(secret)" })), ["name", "kind", "value"]));
        })))
    .addCommand(withTarget(withCommonOptions(new Command("set"))).description("Set a plain value (NAME=value), or attach a secret (NAME --secret)")
      .argument("<NAME=value|NAME>", "Variable")
      .option("--secret", "Attach the project secret called NAME (asks for approval)")
      .option("--shared", "The website shares its build preset: change it for every website using it")
      .addHelpText("after", "\nExamples:\n  atmyapp env set PUBLIC_API_URL=https://api.example.com --website Main\n  atmyapp env set STRIPE_KEY --secret --website Main")
      .action((assignment: string, opts: TargetOpts & { secret?: boolean; shared?: boolean }) => runAction(opts, () => setEnv(connect(opts).api, assignment, opts),
        (result) => console.log(result.unchanged ? chalk.gray(`${result.name} is already set on ${result.target}.`) : chalk.green(`${result.kind === "secret" ? "Attached" : "Set"} ${result.name} on ${result.target}.`)))))
    .addCommand(withTarget(withCommonOptions(new Command("rm"))).description("Remove a plain value, or detach a secret from this target only")
      .argument("<NAME>", "Variable")
      .option("--if-exists", "Succeed when it isn't set")
      .option("--shared", "The website shares its build preset: change it for every website using it")
      .action((name: string, opts: TargetOpts & { ifExists?: boolean; shared?: boolean }) => runAction(opts, () => removeEnv(connect(opts).api, name, opts),
        (result) => console.log(result.removed === "nothing" ? `${name} isn't set.` : result.removed === "secret" ? `Detached ${name} from ${result.target}; the secret and its other targets are unchanged.` : `Removed ${name} from ${result.target}.`))));
}

export function secretsCommand(): Command {
  return new Command("secrets").description("Project secrets: values shared by every website or preview server they're attached to")
    .addCommand(withCommonOptions(new Command("ls")).description("Names, hints and where each is attached (never a value)")
      .action((opts: Opts) => runAction(opts, () => listSecrets(connect(opts).api),
        (result) => console.log(table(result.secrets.map((secret) => ({ name: secret.name, kind: secret.secret ? "secret" : "plain", hint: secret.hint, "attached to": secret.attachedTo })), ["name", "kind", "hint", "attached to"])))))
    .addCommand(withCommonOptions(new Command("set")).description("Create or replace a value (asks for approval)")
      .argument("<NAME>", "Secret name, used as the variable name")
      .option("--from-stdin", "Read the value from standard input")
      .option("--from-env <VAR>", "Read the value from this environment variable")
      .option("--plain", "Not secret: the value may be shown back")
      .option("--description <text>", "What it's for")
      .addHelpText("after", "\nValues never go in a flag, so they stay out of your shell history.\n\nExample: printf %s \"$STRIPE_KEY\" | atmyapp secrets set STRIPE_KEY --from-stdin")
      .action((name: string, opts: Opts & { fromStdin?: boolean; fromEnv?: string; plain?: boolean; description?: string }) => runAction(opts,
        () => setSecret(connect(opts).api, name, secretValue(opts), { plain: opts.plain, description: opts.description }),
        (result) => console.log(chalk.green(`${result.created ? "Created" : "Updated"} ${result.name}.`)))))
    .addCommand(withCommonOptions(new Command("rm")).description("Delete a value (refused while targets use it)")
      .argument("<NAME>", "Secret name")
      .option("--detach-all", "Detach it from every target first")
      .option("--yes", "Don't ask for confirmation")
      .option("--if-exists", "Succeed when there's no such secret")
      .action((name: string, opts: Opts & { detachAll?: boolean; yes?: boolean; ifExists?: boolean }) => runAction(opts, async () => {
        await confirm(opts as never, `Delete the secret ${name}?`);
        return removeSecret(connect(opts).api, name, opts);
      }, (result) => console.log(result.removed ? `Deleted ${name}${result.detachedFrom.length ? ` (detached from ${result.detachedFrom.join(", ")})` : ""}.` : `${name} doesn't exist.`))));
}

// --- preview create / edit ------------------------------------------------------------------

export function addPreviewSetup(preview: Command): Command {
  const options = (command: Command) => command
    .option("--branch <name>", "Branch it runs")
    .option("--command <command>", "Command that starts it, such as 'npm run dev'")
    .addOption(new Option("--port <port>", "Port it listens on").argParser(port))
    .option("--install <command>", "Install command")
    .option("--root <dir>", "Folder of the website in the repository");
  return preview
    .addCommand(options(withCommonOptions(new Command("create"))).description("Create a preview server (safe to run twice)")
      .argument("<name>", "Name").requiredOption("--repo <owner/repo|name>", "Repository it runs (GitHub owner/repo, or the name of code stored in AtMyApp)")
      .action((name: string, opts: Opts) => runAction(opts, () => createPreviewServer(connect(opts).api, { ...(opts as object), name } as never),
        (result) => console.log(result.unchanged ? chalk.gray(`${name} already exists.`) : chalk.green(`Created ${name}. Start it with 'atmyapp preview start --wait'.`)))))
    .addCommand(options(withCommonOptions(new Command("edit"))).description("Change a preview server")
      .option("--server <name>", "Which one (default: the only one)")
      .option("--name <name>", "New name")
      .action((opts: Opts & { server?: string }) => runAction(opts, () => editPreviewServer(connect(opts).api, opts.server, opts as never),
        (result) => console.log(result.unchanged ? chalk.gray("Nothing to change.") : chalk.green(`Updated ${result.server.name}. Restart it to apply: 'atmyapp preview restart --wait'.`)))));
}

// --- locales add / rm / default / jobs ------------------------------------------------------

export function addLocaleSetup(locales: Command): Command {
  return locales
    .addCommand(withCommonOptions(new Command("add")).description("Add a language (safe to run twice)").argument("<code>", "Language code, such as de")
      .addHelpText("after", "\nRefused while drafts are open; the error lists them.")
      .action((code: string, opts: Opts) => runAction(opts, () => addLocale(connect(opts).api, code),
        (result) => console.log(result.unchanged ? chalk.gray(`${result.locale} is already a language.`) : chalk.green(`Added ${result.locale}.`)))))
    .addCommand(withCommonOptions(new Command("default")).description("Make a language the default").argument("<code>", "Language code")
      .action((code: string, opts: Opts) => runAction(opts, () => setDefaultLocale(connect(opts).api, code),
        (result) => console.log(result.unchanged ? chalk.gray(`${result.locale} is already the default.`) : chalk.green(`${result.locale} is now the default.`)))))
    .addCommand(withCommonOptions(new Command("rm")).description("Remove a language and clean up its translations").argument("<code>", "Language code")
      .option("--wait", "Wait for the cleanup job")
      .option("--timeout <duration>", "Longest wait with --wait: 5s to 1h (default 10m)")
      .option("--yes", "Don't ask for confirmation")
      .option("--if-exists", "Succeed when it isn't a language")
      .addHelpText("after", "\nA failed cleanup exits 1 with locale_cleanup_failed and the job ID.")
      .action((code: string, opts: WaitOpts & { yes?: boolean; ifExists?: boolean }) => runAction(opts, async ({ json }) => {
        await confirm(opts as never, `Remove ${code}? Its translations are deleted.`);
        return removeLocale(connect(opts).api, code, {
          wait: opts.wait, ifExists: opts.ifExists, timeoutMs: waitTimeout("cleanup", opts.timeout), onProgress: progress(json),
        });
      }, (result) => console.log(!result.removed ? `${result.locale} isn't a language.` : `Removed ${result.locale}. Cleanup ${result.job?.status ?? "started"}${result.job ? ` (job ${result.job.id})` : ""}.`))))
    .addCommand(withCommonOptions(new Command("jobs")).description("Translation cleanup jobs").argument("[jobId]", "One job")
      .option("--wait", "Wait for it to finish")
      .option("--retry", "Run a failed job again")
      .action((jobId: string | undefined, opts: WaitOpts & { retry?: boolean }) => runAction(opts, ({ json }) => cleanupJobs(connect(opts).api, jobId, { wait: opts.wait, retry: opts.retry, onProgress: progress(json) }),
        (result) => console.log(table(result.jobs.map((job) => ({ id: job.id, locale: job.locale, status: job.status })), ["id", "locale", "status"])))));
}

// --- settings, collections, forms -------------------------------------------------------------

export function settingsCommand(): Command {
  const images = new Command("images").description("Image policy: sizes and formats")
    .addCommand(withCommonOptions(new Command("get")).action((opts: Opts) => runAction(opts, () => imagePolicy(connect(opts).api), (result) => printValue(result.imagePolicy))))
    .addCommand(withCommonOptions(new Command("set")).requiredOption("--file <json>", "The policy, as returned by 'get'")
      .action((opts: Opts & { file: string }) => runAction(opts, () => setImagePolicy(connect(opts).api, opts.file), (result) => printValue(result.imagePolicy))));
  const seo = new Command("seo").description("SEO settings (site name, titles, social images)")
    .addHelpText("after", "\nSEO settings are content: change them with 'atmyapp content edit', then 'stage push' and 'stage commit'.")
    .addCommand(withCommonOptions(new Command("get")).action((opts: Opts) => runAction(opts, () => seoSettings(connect(opts).api), (result) => printValue(result.seo))));
  return new Command("settings").description("Project settings").addCommand(images).addCommand(seo);
}

export function collectionsCommand(): Command {
  return new Command("collections").description("Collection settings")
    .addCommand(withCommonOptions(new Command("edit")).description("Change a collection's label, description or editor hints")
      .argument("<name>", "Collection name")
      .option("--label <text>", "Label editors see")
      .option("--description <text>", "Description editors see")
      .option("--hints <file>", "Editor hints as JSON")
      .option("--branch <name>", "Content branch", "main")
      .action((name: string, opts: Opts & { label?: string; description?: string; hints?: string; branch?: string }) => runAction(opts,
        () => editCollection(connect(opts).api, name, opts), () => console.log(chalk.green(`Updated ${name}.`)))));
}

export function formsCommand(): Command {
  const layout = withCommonOptions(new Command("layout")).description("Show or change how a form's messages are laid out")
    .argument("<form>", "Form name")
    .option("--file <json>", "Replace the layout")
    .option("--reset", "Go back to the automatic layout")
    .option("--generate", "Generate one from the form's fields")
    .option("--instructions <text>", "With --generate: what to focus on")
    .action((type: string, opts: Opts & { file?: string; reset?: boolean; generate?: boolean; instructions?: string }) => runAction(opts,
      () => formLayout(connect(opts).api, type, opts), (result) => printValue(result.layout)));
  const captcha = new Command("captcha").description("Captcha keys")
    .addCommand(withCommonOptions(new Command("verify")).description("Check captcha keys before a form uses them")
      .requiredOption("--provider <name>", "turnstile, recaptcha or hcaptcha")
      .requiredOption("--site-key <key>", "The public site key")
      .option("--secret-from-stdin", "Read the secret key from standard input")
      .option("--secret-from-env <VAR>", "Read the secret key from this environment variable")
      .action((opts: Opts & { provider: string; siteKey: string; secretFromStdin?: boolean; secretFromEnv?: string }) => runAction(opts,
        () => verifyCaptcha(connect(opts).api, { provider: opts.provider, siteKey: opts.siteKey, secret: secretValue({ fromStdin: opts.secretFromStdin, fromEnv: opts.secretFromEnv }) }),
        (result) => printValue(result.result))));
  return new Command("forms").description("Website forms (submission types)")
    .addCommand(withCommonOptions(new Command("ls")).description("List forms")
      .action((opts: Opts) => runAction(opts, () => listForms(connect(opts).api),
        (result) => console.log(table(result.forms.map((form) => ({ form: form.type, accepting: form.acceptingResponses ? "yes" : "no", url: form.formUrl })), ["form", "accepting", "url"])))))
    .addCommand(withCommonOptions(new Command("create")).description("Create a form (safe to run twice)").argument("<name>", "Form name, such as contact")
      .addOption(new Option("--accepting <on|off>", "Accept messages (default on)").argParser(onOff))
      .option("--file <json>", "Settings: protection and options")
      .action((type: string, opts: Opts & { accepting?: boolean; file?: string }) => runAction(opts, () => createForm(connect(opts).api, type, opts),
        (result) => console.log(result.unchanged ? chalk.gray(`${type} already exists.`) : chalk.green(`Created ${type}.`)))))
    .addCommand(withCommonOptions(new Command("edit")).description("Change a form").argument("<name>", "Form name")
      .addOption(new Option("--accepting <on|off>", "Accept messages").argParser(onOff))
      .option("--file <json>", "Settings: protection and options")
      .action((type: string, opts: Opts & { accepting?: boolean; file?: string }) => runAction(opts, () => editForm(connect(opts).api, type, opts),
        () => console.log(chalk.green(`Updated ${type}.`)))))
    .addCommand(withCommonOptions(new Command("rm")).description("Delete a form").argument("<name>", "Form name")
      .option("--yes", "Don't ask for confirmation")
      .option("--if-exists", "Succeed when there's no such form")
      .action((type: string, opts: Opts & { yes?: boolean; ifExists?: boolean }) => runAction(opts, async () => {
        await confirm(opts as never, `Delete the form ${type}? Its website form stops accepting messages.`);
        return removeForm(connect(opts).api, type, opts);
      }, (result) => console.log(result.removed ? `Deleted ${type}.` : `${type} doesn't exist.`))))
    .addCommand(layout)
    .addCommand(captcha);
}

// --- members and invitations (team) ------------------------------------------------------

const TEAM_NOTE = "\nThe team belongs to the project's organisation: every change applies to all its projects. Needs a login that reaches the whole organisation, and asks for approval. Owners are changed in the dashboard: anything that makes, demotes or removes an owner exits 6 with the link.";

export function addTeamCommands(members: Command): Command {
  return members
    .addCommand(withCommonOptions(new Command("invite")).description("Invite someone to the project's organisation")
      .argument("<email>", "Their email address")
      .requiredOption("--role <role>", "owner, admin, editor or reviewer")
      .addHelpText("after", TEAM_NOTE)
      .action((email: string, opts: Opts & { role: string }) => runAction(opts, () => inviteMember(connect(opts).api, email, opts.role),
        (result) => console.log(result.unchanged
          ? chalk.gray(`${result.subject} is already invited as ${result.role}.`)
          : chalk.green(`Invited ${result.subject} as ${result.role}. They get access to ${teamReach(result.organization)}.`)))))
    .addCommand(withCommonOptions(new Command("role")).description("Change someone's role")
      .argument("<member>", "Member ID or email").argument("<role>", "owner, admin, editor or reviewer")
      .addHelpText("after", TEAM_NOTE)
      .action((ref: string, roleName: string, opts: Opts) => runAction(opts, () => changeRole(connect(opts).api, ref, roleName),
        (result) => console.log(result.unchanged ? chalk.gray(`${result.subject} is already ${result.role}.`)
          : chalk.green(`${result.subject} is now ${result.role} for ${teamReach(result.organization)}.`)))))
    .addCommand(withCommonOptions(new Command("rm")).description("Remove someone from the organisation")
      .argument("<member>", "Member ID or email")
      .option("--yes", "Don't ask for confirmation")
      .option("--if-exists", "Succeed when they aren't a member")
      .addHelpText("after", TEAM_NOTE)
      .action((ref: string, opts: Opts & { yes?: boolean; ifExists?: boolean }) => runAction(opts, async () => {
        const { api } = connect(opts);
        const current = await team(api);
        await confirm(opts as never, `Remove ${ref}? They lose access to ${teamReach(current.organization)}.`);
        return removeMember(api, ref, opts);
      }, (result) => console.log(result.unchanged ? `${result.subject} isn't a member.` : `Removed ${result.subject}; they lose access to ${teamReach(result.organization)}.`))));
}

export function invitationsCommand(): Command {
  return new Command("invitations").description("Pending invitations to the project's organisation")
    .addCommand(withCommonOptions(new Command("ls")).description("List pending invitations")
      .action((opts: Opts) => runAction(opts, async () => {
        const current = await team(connect(opts).api);
        return { organization: current.organization, invitations: current.invitations };
      }, (result) => console.log(table(result.invitations.map((item) => ({ id: item.id, email: item.email, role: item.role })), ["id", "email", "role"])))))
    .addCommand(withCommonOptions(new Command("revoke")).description("Cancel a pending invitation")
      .argument("<invitation>", "Invitation ID or email")
      .option("--if-exists", "Succeed when there's no such invitation")
      .action((ref: string, opts: Opts & { ifExists?: boolean }) => runAction(opts, () => revokeInvitation(connect(opts).api, ref, opts),
        (result) => console.log(result.unchanged ? `No pending invitation for ${result.subject}.` : `Cancelled the invitation for ${result.subject}.`))));
}
