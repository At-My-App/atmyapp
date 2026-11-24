import chalk from "chalk";
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { projectApiUrl } from "../../runtime/api";
import { setBrowserLoginProject } from "../../runtime/credentials";
import { CliError, EXIT } from "../../runtime/errors";
import { createProject, findProject, listOrganizations, listProjects, showProject } from "../../runtime/projects";
import { ensureStoreIgnored } from "../../runtime/store";
import { connectAccount, readSessionFile, runAction, table, withCommonOptions, type CommonOptions } from "../output";
import { ignoreSessionFile } from "./use";

/** `atmyapp projects …` and `atmyapp orgs ls` (CliEverywherePlan §5.2 CLI 2–3). */
export function projectsCommand(): Command {
  return new Command("projects")
    .description("List, choose and create projects with your personal login")
    .addHelpText("after", "\nNeeds 'atmyapp login' (or a personal token in ATMYAPP_CLI_KEY). Project keys can't use these.")
    .addCommand(withCommonOptions(new Command("ls"))
      .description("List the projects this login can reach")
      .addHelpText("after", "\nExample: atmyapp projects ls --json")
      .action((opts: CommonOptions) => runAction(opts, () => listProjects(connectAccount(opts).api), (result) =>
        console.log(table(result.projects.map((project) => ({
          ...project, organization: project.organization.name, via: project.via === "partner" ? "as partner" : "",
        })), ["id", "name", "organization", "via"])))))
    .addCommand(withCommonOptions(new Command("show"))
      .description("Show a project and what this login may do in it")
      .argument("[project]", "Project ID or name (default: this folder's project)")
      .action((ref: string | undefined, opts: CommonOptions) => runAction(opts, () => {
        const target = ref ?? opts.project ?? readSessionFile()?.projectId;
        if (!target) throw new CliError("project_required", "Name a project.", { exitCode: EXIT.usage, fix: "atmyapp projects show <id>" });
        return showProject(connectAccount(opts).api, target);
      }, (result) => {
        console.log(`${chalk.bold(result.project.name)} ${chalk.gray(`(${result.project.id})`)}`);
        console.log(`Organisation: ${result.project.organization.name}${result.project.via === "partner" ? " (as partner)" : ""}`);
        console.log(`May: ${result.effectiveScopes.join(", ") || chalk.red("nothing")}`);
      })))
    .addCommand(withCommonOptions(new Command("use"))
      .description("Work on a project in this folder")
      .argument("<project>", "Project ID or name")
      .addHelpText("after", "\nWrites .ama/session.json (project only, never a secret) and remembers it as your login's default.\n\nExample: atmyapp projects use my-site")
      .action((ref: string, opts: CommonOptions) => runAction(opts, async () => {
        const { api, source } = connectAccount(opts);
        const project = await findProject(api, ref);
        const cwd = process.cwd();
        fs.mkdirSync(path.join(cwd, ".ama"), { recursive: true });
        ignoreSessionFile(cwd);
        ensureStoreIgnored(cwd);
        const previous = (() => { try { return readSessionFile(cwd); } catch { return null; } })();
        // A project key belongs to one project: switching drops it from this folder.
        const droppedKey = Boolean(previous?.token && previous.projectId !== project.id);
        const keep = previous?.token && !droppedKey ? { token: previous.token } : {};
        const sessionFile = path.join(cwd, ".ama", "session.json");
        fs.writeFileSync(sessionFile, JSON.stringify({ ...keep, projectId: project.id, url: projectApiUrl(api.session.url, project.id, "") }, null, 2));
        if (source === "login") setBrowserLoginProject(api.session.token, project.id);
        return { projectId: project.id, name: project.name, sessionFile, droppedKey };
      }, (result) => {
        console.log(`Using ${chalk.bold(result.name)} (${result.projectId}) in this folder.`);
        if (result.droppedKey) console.log(chalk.yellow("The project key saved here was for another project and was removed."));
      })))
    .addCommand(withCommonOptions(new Command("create"))
      .description("Create a project; safe to run twice")
      .argument("<name>", "Project name")
      .requiredOption("--org <organisation>", "Organisation ID or name ('atmyapp orgs ls --can-create')")
      .option("--id <projectId>", "Project ID (default: made from the name)")
      .option("--use", "Work on it in this folder afterwards")
      .option("--dry-run", "Check the organisation and name without creating anything")
      .addHelpText("after", "\nRunning it again for the same name and organisation returns the same project with unchanged: true.\n\nExample: atmyapp projects create \"Bella Cafe\" --org bella --use")
      .action((name: string, opts: CommonOptions & { org: string; id?: string; use?: boolean; dryRun?: boolean }) => runAction(opts, async () => {
        const { api, source } = connectAccount(opts);
        const result = await createProject(api, { name, org: opts.org, projectId: opts.id, dryRun: opts.dryRun });
        if (!result.dryRun && opts.use) {
          const cwd = process.cwd();
          fs.mkdirSync(path.join(cwd, ".ama"), { recursive: true });
          ignoreSessionFile(cwd);
          ensureStoreIgnored(cwd);
          fs.writeFileSync(path.join(cwd, ".ama", "session.json"), JSON.stringify({
            projectId: result.project.id, url: projectApiUrl(api.session.url, result.project.id, ""),
          }, null, 2));
          if (source === "login") setBrowserLoginProject(api.session.token, result.project.id);
        }
        return result;
      }, (result) => {
        if (result.dryRun) {
          console.log(result.unchanged ? `'${result.name}' already exists in ${result.organization.name}.` : `Would create '${result.name}' in ${result.organization.name}.`);
          return;
        }
        console.log(result.unchanged
          ? chalk.gray(`${result.project.name} (${result.project.id}) already exists; nothing changed.`)
          : chalk.green(`Created ${result.project.name} (${result.project.id}).`));
      })));
}

export function orgsCommand(): Command {
  return new Command("orgs")
    .description("Organisations your login can reach")
    .addCommand(withCommonOptions(new Command("ls"))
      .description("List organisations")
      .option("--can-create", "Also list where this login may create projects")
      .action((opts: CommonOptions & { canCreate?: boolean }) => runAction(opts,
        () => listOrganizations(connectAccount(opts).api, { canCreate: opts.canCreate }),
        (result) => {
          console.log(table(result.organizations.map((organization) => ({ ...organization, via: organization.via === "partner" ? "as partner" : "" })), ["id", "name", "via"]));
          if (result.canCreateIn) {
            console.log("\nCan create projects in");
            console.log(table(result.canCreateIn.map((destination) => ({
              ...destination, partner: destination.partner?.name ?? "", full: destination.limitReached ? "limit reached" : "",
            })), ["id", "name", "partner", "full"]));
          }
        })));
}
