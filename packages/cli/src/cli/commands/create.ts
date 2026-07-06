import { Command, Option } from "commander";
import {
  createProject,
  type PackageManagerName,
  type ProjectTemplateName,
} from "../create/create-project";
import { Logger } from "../logger";

interface CreateCommandOptions {
  template?: ProjectTemplateName;
  packageManager?: PackageManagerName;
  install?: boolean;
  git?: boolean;
  force?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

export function createCommand(name = "create"): Command {
  return new Command(name)
    .description("Create a new AtMyApp project")
    .argument("[project-name]", "Project name or directory")
    .addOption(
      new Option("--template <template>", "Template name")
        .choices(["astro-tailwind"])
        .default(undefined),
    )
    .addOption(
      new Option("--pm <package-manager>", "Package manager")
        .choices(["pnpm", "npm", "yarn", "bun"])
        .default(undefined),
    )
    .option("--install", "Install dependencies after creating files")
    .option("--no-install", "Skip dependency installation")
    .option("--git", "Initialize a git repository")
    .option("--no-git", "Skip git initialization")
    .option("--force", "Create project in a non-empty directory", false)
    .option("-y, --yes", "Use defaults for all prompts", false)
    .option("--verbose", "Enable verbose logging", false)
    .action(async (projectName: string | undefined, options: CreateCommandOptions) => {
      const logger = new Logger(Boolean(options.verbose));

      try {
        await createProject({
          projectName,
          template: options.template,
          packageManager: options.packageManager,
          install: options.install,
          git: options.git,
          force: Boolean(options.force),
          yes: Boolean(options.yes),
          verbose: Boolean(options.verbose),
          logger,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error(`Create failed: ${message}`, error);
        process.exit(1);
      }
    });
}
