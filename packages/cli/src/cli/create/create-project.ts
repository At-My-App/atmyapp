import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Logger } from "../logger";

export type ProjectTemplateName = "astro-tailwind";
export type PackageManagerName = "pnpm" | "npm" | "yarn" | "bun";

export interface CreateProjectOptions {
  cwd?: string;
  projectName?: string;
  template?: ProjectTemplateName;
  packageManager?: PackageManagerName;
  install?: boolean;
  git?: boolean;
  force?: boolean;
  yes?: boolean;
  verbose?: boolean;
  logger?: Logger;
}

interface TemplateDefinition {
  name: ProjectTemplateName;
  label: string;
  description: string;
}

interface ResolvedProject {
  displayName: string;
  packageName: string;
  targetDir: string;
}

const TEMPLATES: TemplateDefinition[] = [
  {
    name: "astro-tailwind",
    label: "Astro + Tailwind + AtMyApp",
    description: "Static Astro site with Tailwind CSS and an AtMyApp schema.",
  },
];

const PACKAGE_MANAGERS: PackageManagerName[] = ["pnpm", "npm", "yarn", "bun"];

export async function createProject(
  options: CreateProjectOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? new Logger(Boolean(options.verbose));
  const projectName =
    options.projectName ??
    (await askText("Project name", {
      defaultValue: "my-atmyapp-site",
      yes: options.yes,
    }));

  const template =
    options.template ??
    (await askSelect<ProjectTemplateName>(
      "Select template",
      TEMPLATES.map((templateDefinition) => ({
        value: templateDefinition.name,
        label: templateDefinition.label,
        description: templateDefinition.description,
      })),
      TEMPLATES[0].name,
      options.yes,
    ));

  const packageManager =
    options.packageManager ??
    (await askSelect<PackageManagerName>(
      "Package manager",
      PACKAGE_MANAGERS.map((value) => ({ value, label: value })),
      detectPackageManager(),
      options.yes,
    ));

  const install =
    options.install ??
    (await askConfirm("Install dependencies now?", true, options.yes));
  const git =
    options.git ??
    (await askConfirm("Initialize git repository?", false, options.yes));

  assertTemplate(template);
  assertPackageManager(packageManager);

  const project = resolveProject(cwd, projectName);
  await ensureTargetDirectory(project.targetDir, Boolean(options.force));

  const packageRoot = findPackageRoot(__dirname);
  const packageInfo = readPackageInfo(packageRoot);
  const templateDir = path.join(packageRoot, "templates", template);
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Template "${template}" was not found in ${templateDir}.`);
  }

  logger.info(`Creating ${project.displayName} in ${project.targetDir}.`);
  await copyTemplate(templateDir, project.targetDir, {
    __PROJECT_DISPLAY_NAME__: project.displayName,
    __PROJECT_PACKAGE_NAME__: project.packageName,
    __PACKAGE_MANAGER_RUN__: getPackageManagerRunCommand(packageManager),
    __ATMYAPP_CLI_VERSION__: `^${packageInfo.version}`,
  });

  if (install) {
    logger.info(`Installing dependencies with ${packageManager}.`);
    await runCommand(packageManager, getInstallArgs(packageManager), project.targetDir);
  }

  if (git) {
    logger.info("Initializing git repository.");
    await runCommand("git", ["init"], project.targetDir);
  }

  logger.success(`Created ${project.displayName}.`);
  printNextSteps(project.targetDir, cwd, packageManager, install);
}

function assertTemplate(template: string): asserts template is ProjectTemplateName {
  if (!TEMPLATES.some((templateDefinition) => templateDefinition.name === template)) {
    throw new Error(
      `Unknown template "${template}". Available templates: ${TEMPLATES.map((item) => item.name).join(", ")}.`,
    );
  }
}

function assertPackageManager(
  packageManager: string,
): asserts packageManager is PackageManagerName {
  if (!PACKAGE_MANAGERS.includes(packageManager as PackageManagerName)) {
    throw new Error(
      `Unknown package manager "${packageManager}". Available package managers: ${PACKAGE_MANAGERS.join(", ")}.`,
    );
  }
}

function resolveProject(cwd: string, rawProjectName: string): ResolvedProject {
  const trimmed = rawProjectName.trim();
  if (!trimmed) {
    throw new Error("Project name cannot be empty.");
  }

  const targetInput =
    trimmed === "."
      ? "."
      : /[\\/]/.test(trimmed)
        ? trimmed
        : toKebabCase(trimmed);
  const targetDir = path.resolve(cwd, targetInput);
  const directoryName =
    trimmed === "." ? path.basename(targetDir) : path.basename(targetDir);
  const displayName = toDisplayName(directoryName);
  const packageName = toPackageName(directoryName);

  if (!packageName) {
    throw new Error(`Project name "${rawProjectName}" cannot be used as a package name.`);
  }

  return {
    displayName,
    packageName,
    targetDir,
  };
}

async function ensureTargetDirectory(targetDir: string, force: boolean): Promise<void> {
  if (!fs.existsSync(targetDir)) {
    await fs.promises.mkdir(targetDir, { recursive: true });
    return;
  }

  const entries = await fs.promises.readdir(targetDir);
  if (entries.length > 0 && !force) {
    throw new Error(
      `Directory ${targetDir} is not empty. Choose another name or pass --force.`,
    );
  }
}

async function copyTemplate(
  sourceDir: string,
  targetDir: string,
  replacements: Record<string, string>,
): Promise<void> {
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const outputName = renderTemplateName(entry.name, replacements);
    const targetPath = path.join(targetDir, outputName);

    if (entry.isDirectory()) {
      await fs.promises.mkdir(targetPath, { recursive: true });
      await copyTemplate(sourcePath, targetPath, replacements);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const source = await fs.promises.readFile(sourcePath, "utf8");
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, renderTemplate(source, replacements));
  }
}

function renderTemplateName(
  fileName: string,
  replacements: Record<string, string>,
): string {
  const dotFileName = fileName.startsWith("_") ? `.${fileName.slice(1)}` : fileName;
  return renderTemplate(dotFileName, replacements);
}

function renderTemplate(source: string, replacements: Record<string, string>): string {
  let output = source;
  for (const [token, value] of Object.entries(replacements)) {
    output = output.split(token).join(value);
  }
  return output;
}

function findPackageRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate @atmyapp/cli package root.");
    }
    current = parent;
  }
}

function readPackageInfo(packageRoot: string): { version: string } {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const rawPackageJson = fs.readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(rawPackageJson) as { version?: unknown };

  if (typeof packageJson.version !== "string") {
    throw new Error(`Package version was not found in ${packageJsonPath}.`);
  }

  return { version: packageJson.version };
}

function detectPackageManager(): PackageManagerName {
  const userAgent = process.env.npm_config_user_agent ?? "";

  if (userAgent.startsWith("pnpm")) {
    return "pnpm";
  }
  if (userAgent.startsWith("yarn")) {
    return "yarn";
  }
  if (userAgent.startsWith("bun")) {
    return "bun";
  }
  if (userAgent.startsWith("npm")) {
    return "npm";
  }

  return "pnpm";
}

function getInstallArgs(packageManager: PackageManagerName): string[] {
  return packageManager === "yarn" ? [] : ["install"];
}

function getPackageManagerRunCommand(packageManager: PackageManagerName): string {
  switch (packageManager) {
    case "npm":
      return "npm run";
    case "bun":
      return "bun run";
    case "pnpm":
    case "yarn":
      return packageManager;
  }
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" ? `${command}.cmd` : command;
    const child = spawn(executable, args, {
      cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
      }
    });
  });
}

function printNextSteps(
  targetDir: string,
  cwd: string,
  packageManager: PackageManagerName,
  installed: boolean,
): void {
  const relativeDir = path.relative(cwd, targetDir) || ".";
  const run = getPackageManagerRunCommand(packageManager);

  console.log("");
  console.log("Next steps:");
  if (relativeDir !== ".") {
    console.log(`  cd ${relativeDir}`);
  }
  if (!installed) {
    console.log(`  ${packageManager} install`);
  }
  console.log(`  ${run} dev`);
  console.log("");
}

async function askText(
  label: string,
  options: { defaultValue: string; yes?: boolean },
): Promise<string> {
  if (options.yes) {
    return options.defaultValue;
  }

  const answer = await ask(`${label} (${options.defaultValue}): `);
  return answer.trim() || options.defaultValue;
}

async function askConfirm(
  label: string,
  defaultValue: boolean,
  yes?: boolean,
): Promise<boolean> {
  if (yes) {
    return defaultValue;
  }

  const suffix = defaultValue ? "Y/n" : "y/N";
  const answer = (await ask(`${label} [${suffix}]: `)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }

  return answer === "y" || answer === "yes";
}

async function askSelect<T extends string>(
  label: string,
  options: Array<{ value: T; label: string; description?: string }>,
  defaultValue: T,
  yes?: boolean,
): Promise<T> {
  if (yes) {
    return defaultValue;
  }

  console.log(`${label}:`);
  options.forEach((option, index) => {
    const marker = option.value === defaultValue ? " (default)" : "";
    const description = option.description ? ` - ${option.description}` : "";
    console.log(`  ${index + 1}. ${option.label}${marker}${description}`);
  });

  const answer = (await ask("Select option: ")).trim();
  if (!answer) {
    return defaultValue;
  }

  const selectedIndex = Number.parseInt(answer, 10) - 1;
  const selected = options[selectedIndex];
  if (!selected) {
    const byValue = options.find((option) => option.value === answer);
    if (byValue) {
      return byValue.value;
    }

    throw new Error(`Invalid option "${answer}".`);
  }

  return selected.value;
}

function ask(query: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive prompts require a TTY. Pass --yes and options instead.");
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function toKebabCase(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function toPackageName(value: string): string {
  return toKebabCase(value).replace(/^[._]+/, "").replace(/[._]+$/, "");
}

function toDisplayName(value: string): string {
  const normalized = value.replace(/[-_]+/g, " ").trim();
  return normalized
    ? normalized.replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "AtMyApp Site";
}
