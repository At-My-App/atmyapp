#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init";
import { migrateCommand, migrateStatusCommand } from "./commands/migrate";
import { useCommand } from "./commands/use";
import { uploadCommand } from "./commands/upload";
import { generateCommand } from "./commands/generate";
import { snapshotCommand } from "./commands/snapshot";
import { createCommand } from "./commands/create";
import { submissionsCommand } from "./commands/submissions";
import { whoamiCommand } from "./commands/whoami";
import { doctorCommand } from "./commands/doctor";
import { contentCommand } from "./commands/content";
import { entriesCommand } from "./commands/entries";
import { schemaCommand } from "./commands/schema";
import { assetsCommand, filesCommand } from "./commands/assets";
import { localesCommand } from "./commands/locales";
import { helpCommand } from "./commands/help";
import { spaceCommand } from "./commands/space";
import { membersCommand, stageCommand } from "./commands/stage";
import { loginCommand, logoutCommand } from "./commands/login";
import { hostingCommand } from "./commands/hosting";
import { domainsCommand } from "./commands/domains";
import { keysCommand } from "./commands/keys";
import { orgsCommand, projectsCommand } from "./commands/projects";
import { statusCommand } from "./commands/status";
import { analyticsCommand, linksCommand } from "./commands/analytics";
import { previewCommand } from "./commands/preview";
import {
  addHostingSetup, addLocaleSetup, addTeamCommands, invitationsCommand, addPreviewSetup, addProjectWebsite, codeCommand, gitCommand, collectionsCommand, envCommand, formsCommand,
  secretsCommand, settingsCommand,
} from "./commands/setup";
import { applyCommand, exportCommand, planCommand } from "./commands/desired";
import { CLI_VERSION, withApprovalOptions } from "./output";

const program = new Command()
  .name("atmyapp")
  .description("AtMyApp CLI Tool")
  .version(CLI_VERSION)
  .helpCommand(false);

program.addCommand(initCommand());
program.addCommand(createCommand());
program.addCommand(useCommand());
program.addCommand(loginCommand());
program.addCommand(logoutCommand());
program.addCommand(whoamiCommand());
program.addCommand(addProjectWebsite(projectsCommand()));
program.addCommand(codeCommand());
program.addCommand(gitCommand(), { hidden: true });
program.addCommand(orgsCommand());
program.addCommand(statusCommand());
program.addCommand(doctorCommand());
program.addCommand(schemaCommand());
program.addCommand(contentCommand());
program.addCommand(entriesCommand());
program.addCommand(spaceCommand());
program.addCommand(stageCommand());
program.addCommand(addHostingSetup(hostingCommand()));
program.addCommand(envCommand());
program.addCommand(secretsCommand());
program.addCommand(addPreviewSetup(previewCommand()));
program.addCommand(domainsCommand());
program.addCommand(keysCommand());
program.addCommand(addTeamCommands(membersCommand()));
program.addCommand(invitationsCommand());
program.addCommand(assetsCommand());
program.addCommand(filesCommand());
program.addCommand(addLocaleSetup(localesCommand()));
program.addCommand(settingsCommand());
program.addCommand(collectionsCommand());
program.addCommand(exportCommand());
program.addCommand(planCommand());
program.addCommand(applyCommand());
program.addCommand(migrateCommand());
program.addCommand(migrateStatusCommand());
program.addCommand(uploadCommand());
program.addCommand(generateCommand());
program.addCommand(snapshotCommand());
program.addCommand(submissionsCommand());
program.addCommand(formsCommand());
program.addCommand(analyticsCommand());
program.addCommand(linksCommand());
program.addCommand(helpCommand(program));
withApprovalOptions(program);

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
