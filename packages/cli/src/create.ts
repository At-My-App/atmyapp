import { createCommand } from "./cli/commands/create";

export async function runCreateAtMyApp(
  argv = process.argv.slice(2),
): Promise<void> {
  const command = createCommand("create-atmyapp");
  await command.parseAsync(["node", "create-atmyapp", ...argv], {
    from: "node",
  });
}

export { createProject } from "./cli/create/create-project";
export type {
  CreateProjectOptions,
  PackageManagerName,
  ProjectTemplateName,
} from "./cli/create/create-project";
