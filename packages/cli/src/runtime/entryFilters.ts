import type { FieldDefinition } from "@atmyapp/structure";
import { CliError, EXIT } from "./errors";

const operators = {
  "=": "eq",
  "!=": "neq",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
  "~": "contains",
} as const;

type FilterOperator = (typeof operators)[keyof typeof operators];
const systemColumns = new Set(["id", "created", "updated"]);
const expression = /^([A-Za-z_][A-Za-z0-9_-]*)\s*(<=|>=|!=|=|<|>|~)([\s\S]*)$/;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function invalidFilter(message: string): CliError {
  return new CliError("invalid_filter", message, { exitCode: EXIT.usage });
}

function filterValue(name: string, field: FieldDefinition | undefined, operator: FilterOperator, input: string): string {
  if (field && !["scalar", "enum", "slug", "order"].includes(field.kind)) {
    throw invalidFilter("Field '" + name + "' cannot be filtered with --where. Use a top-level scalar field.");
  }
  const value = input.trim();
  const textEnum = field?.kind === "enum" && field.values.some((item) => typeof item === "string");
  const numberField = field?.kind === "order" || (field?.kind === "scalar" && field.scalar === "number");
  const booleanField = field?.kind === "scalar" && field.scalar === "boolean";
  const numberEnum = field?.kind === "enum" && !field.values.includes(input) && field.values.some((item) => typeof item === "number");
  const booleanEnum = field?.kind === "enum" && !field.values.includes(input) && field.values.some((item) => typeof item === "boolean");

  if (operator === "contains") {
    if (numberField || booleanField || (field?.kind === "enum" && !textEnum) || !input) {
      throw invalidFilter("The ~ operator needs a text field and a nonempty search value.");
    }
    return input;
  }

  const number = Number(value);
  const numeric = decimal.test(value) && Number.isFinite(number);
  if (numberField || (numberEnum && numeric)) {
    if (!numeric) throw invalidFilter("Field '" + name + "' needs a number.");
    return String(number);
  }

  if (booleanField || (booleanEnum && /^(true|false)$/i.test(value))) {
    if (!/^(true|false)$/i.test(value) || (operator !== "eq" && operator !== "neq")) {
      throw invalidFilter("Field '" + name + "' needs =true, =false, !=true or !=false.");
    }
    return value.toLowerCase();
  }

  // The ESS parser decodes JSON strings, preserving values such as "001".
  return JSON.stringify(input);
}

export function entryFilterQuery(
  where: readonly string[],
  fields: Record<string, FieldDefinition>,
): Record<string, string[]> {
  const query = new Map<string, string[]>();
  for (const term of where) {
    const match = expression.exec(term.trimStart());
    if (!match) throw invalidFilter("Use --where '<field><operator><value>', for example --where 'price>=20'.");
    const [, name, comparison, value] = match;
    const system = systemColumns.has(name);
    if (!system && !Object.prototype.hasOwnProperty.call(fields, name)) {
      throw new CliError("unknown_filter_field", "No filterable field '" + name + "' in this collection.", {
        exitCode: EXIT.usage,
        fix: "Run 'atmyapp schema show coll:<collection> --for-editing' to see the fields.",
      });
    }
    const operator = operators[comparison as keyof typeof operators];
    const param = name + "." + operator;
    const values = query.get(param) ?? [];
    values.push(filterValue(name, system ? undefined : fields[name], operator, value));
    query.set(param, values);
  }
  return Object.fromEntries(query);
}
