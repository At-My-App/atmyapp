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

// Resolves from both src/cli and dist/cli to the package root.
const { version } = require("../../package.json") as { version: string };

const program = new Command()
  .name("atmyapp")
  .description("AtMyApp CLI Tool")
  .version(version);

program.addCommand(initCommand());
program.addCommand(createCommand());
program.addCommand(useCommand());
program.addCommand(migrateCommand());
program.addCommand(migrateStatusCommand());
program.addCommand(uploadCommand());
program.addCommand(generateCommand());
program.addCommand(snapshotCommand());
program.addCommand(submissionsCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
