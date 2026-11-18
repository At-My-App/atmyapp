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
import { assetsCommand } from "./commands/assets";
import { localesCommand } from "./commands/locales";
import { helpCommand } from "./commands/help";
import { CLI_VERSION } from "./output";

const program = new Command()
  .name("atmyapp")
  .description("AtMyApp CLI Tool")
  .version(CLI_VERSION)
  .helpCommand(false);

program.addCommand(initCommand());
program.addCommand(createCommand());
program.addCommand(useCommand());
program.addCommand(whoamiCommand());
program.addCommand(doctorCommand());
program.addCommand(schemaCommand());
program.addCommand(contentCommand());
program.addCommand(entriesCommand());
program.addCommand(assetsCommand());
program.addCommand(localesCommand());
program.addCommand(migrateCommand());
program.addCommand(migrateStatusCommand());
program.addCommand(uploadCommand());
program.addCommand(generateCommand());
program.addCommand(snapshotCommand());
program.addCommand(submissionsCommand());
program.addCommand(helpCommand(program));

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
