import chalk from "chalk";
import { Command } from "commander";
import { CliError, EXIT } from "../../runtime/errors";
import { parseRef } from "../../runtime/refs";
import { fetchRemoteSchema, type RemoteSchema } from "../../runtime/schema";
import type { SchemaShowResult } from "../../runtime/schemas/commands";
import { connect, printValue, runAction, table, withCommonOptions, type CommonOptions } from "../output";

function definitionName(schema: RemoteSchema, input: string): string {
  const ref = input.includes(":") ? parseRef(input) : { kind: "doc" as const, name: input };
  if (ref.kind === "coll" || ref.kind === "entry") return ref.name;
  if (ref.kind === "doc") {
    const document = schema.resolveDocument(ref.name);
    if (document) return document.name;
    if (schema.definition(ref.name)) return ref.name;
  }
  if (ref.kind === "file") {
    const owner = schema.definitionForPath(ref.name);
    if (owner) return owner.name;
  }
  throw new CliError("unknown_definition", `The project's schema has no definition for '${input}'.`, {
    exitCode: EXIT.usage,
    fix: "Run 'atmyapp schema show' to list the definitions.",
  });
}

export function schemaCommand(): Command {
  const show = withCommonOptions(new Command("show"))
    .description("Show the project's published schema, or one definition")
    .argument("[ref]", "A definition: doc:<name>, coll:<name>, file:<path> or a definition name")
    .option("--for-editing", "One row per field: type, required, limits, localize, description", false)
    .option("--raw", "The stored schema document as is", false)
    .action((input: string | undefined, options: CommonOptions & { forEditing?: boolean; raw?: boolean }) =>
      runAction(
        options,
        async (): Promise<SchemaShowResult> => {
          const { api } = connect(options);
          const schema = await fetchRemoteSchema(api);
          if (!input) {
            return options.raw
              ? { schemaHash: schema.hash, schema: schema.raw }
              : { schemaHash: schema.hash, localization: schema.localizationEnabled, definitions: schema.summaries() };
          }
          const name = definitionName(schema, input);
          const definition = schema.definition(name)!;
          return {
            schemaHash: schema.hash,
            name,
            kind: definition.kind,
            path: schema.storagePath(name),
            description: definition.description ?? null,
            ...(options.forEditing ? { fields: schema.fieldRows(name) } : { definition }),
          };
        },
        (result) => {
          if ("definitions" in result) {
            console.log(table(result.definitions, ["name", "kind", "path", "description"]));
            if (result.localization) console.log(chalk.gray("\nLocalization is enabled; fields marked localize can be translated."));
            return;
          }
          if ("schema" in result) return printValue(result.schema);
          console.log(`${chalk.bold(result.name)} (${result.kind})${result.path ? `  ${result.path}` : ""}`);
          if (result.description) console.log(chalk.gray(result.description));
          if ("fields" in result) {
            console.log(
              table(
                result.fields.map((row) => ({
                  ...row,
                  required: row.required ? "yes" : "",
                  localize: row.localize ? "yes" : "",
                  limits: Object.entries(row.limits)
                    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                    .join(" "),
                })),
                ["pointer", "type", "required", "localize", "limits", "description"],
              ),
            );
          } else printValue(result.definition);
        },
      ),
    );
  return new Command("schema").description("Read the project's published schema").addCommand(show);
}
