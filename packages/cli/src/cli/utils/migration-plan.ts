import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { MigrationOperation } from "@atmyapp/structure";
import type {
  RemoteMigrationPlan,
  UploadStructureClearRequest,
} from "../../runtime";
import { Logger } from "../logger";
import type { OutputDefinition } from "../types/migrate";

const LAST_MIGRATION_PATH = "./.ama/last-migration.json";
const MIGRATIONS_DIRECTORY = "./.ama/migrations";

/**
 * Reads declared operations, for example:
 * [{ "type": "renameField", "definition": "posts", "from": "title", "to": "headline" }]
 */
export function readOperationsFile(path: string): MigrationOperation[] {
  const absolute = resolve(process.cwd(), path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read operations from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed))
    throw new Error(`${path} must contain a JSON array of operations.`);
  return parsed.map((operation, index) => {
    const value = operation as Record<string, unknown>;
    const strings = (...keys: string[]) =>
      keys.every((key) => typeof value?.[key] === "string" && value[key]);
    if (value?.type === "renameField" && strings("definition", "from", "to"))
      return value as unknown as MigrationOperation;
    if (
      value?.type === "backfillField" &&
      strings("definition", "field") &&
      value.value !== undefined
    )
      return value as unknown as MigrationOperation;
    throw new Error(
      `Operation ${index + 1} in ${path} must be renameField {definition, from, to} or backfillField {definition, field, value}.`,
    );
  });
}

/** Clears that would resolve the plan's destructive blocks, for the explicit shortcut flag. */
export function suggestedClearFromPlan(
  plan: RemoteMigrationPlan,
): UploadStructureClearRequest {
  const columns = new Map<string, Set<string>>();
  const collections = new Set<string>();
  const contentFiles = new Set<string>();
  for (const issue of plan.destructive.issues) {
    if (issue.kind === "collection_removal" && issue.collectionName)
      collections.add(issue.collectionName);
    if (issue.kind === "content_removal" && issue.definitionName)
      contentFiles.add(issue.definitionName);
    if (issue.kind === "column_removal" && issue.collectionName && issue.columnName)
      columns.set(
        issue.collectionName,
        (columns.get(issue.collectionName) ?? new Set()).add(issue.columnName),
      );
  }
  return {
    collections: Array.from(collections).sort(),
    contentFiles: Array.from(contentFiles).sort(),
    columns: Array.from(columns.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([collection, values]) => ({
        collection,
        columns: Array.from(values).sort(),
      })),
  };
}

/** Anything that changes or hides stored content needs an explicit yes. */
export function planNeedsConfirmation(plan: RemoteMigrationPlan): boolean {
  return (
    plan.effects.changedResources.length > 0 ||
    plan.destructive.removedCollections.length > 0 ||
    plan.destructive.removedContentFiles.length > 0 ||
    plan.destructive.retainedColumns.length > 0 ||
    plan.content.introduced.length > 0
  );
}

export function logMigrationPlan(plan: RemoteMigrationPlan, logger: Logger) {
  logger.info(
    `Migration plan for ${plan.branch} at ${plan.baseHeadSha?.slice(0, 12) ?? "an empty project"}:`,
  );
  if (plan.unchanged) {
    logger.info("  No schema or content changes.");
    return;
  }
  for (const action of plan.actions) logger.info(`  - ${action.message}`);
  const changed = plan.effects.changedResources.length;
  if (changed)
    logger.info(
      `  ${changed} stored item${changed === 1 ? "" : "s"} will be rewritten by the declared operations.`,
    );
  for (const sample of plan.effects.samples)
    logger.verbose_log(
      `    ${sample.resource}: ${JSON.stringify(sample.before)} -> ${JSON.stringify(sample.after)}`,
    );
  for (const name of plan.destructive.removedCollections)
    logger.warn(`  Collection "${name}" will be removed with its entries.`);
  for (const name of plan.destructive.removedContentFiles)
    logger.warn(`  Content file "${name}" will be deleted.`);
  for (const group of plan.destructive.retainedColumns)
    logger.info(
      `  Hidden from editors, values kept in storage: ${group.collection}.${group.columns.join(`, ${group.collection}.`)}`,
    );
  for (const issue of plan.content.introduced.filter(
    (entry) => entry.severity === "overridable",
  ))
    logger.warn(
      `  Content warning after this change: ${issue.resource} ${issue.path}: ${issue.message}`,
    );
  const existing = plan.content.preexisting.length;
  if (existing)
    logger.info(
      `  ${existing} content problem${existing === 1 ? "" : "s"} already existed before this change.`,
    );
  for (const block of plan.blocks) logger.error(`  Blocked: ${block.message}`);
}

/**
 * Everything needed to check or finish one migration later, exactly as it was
 * requested: the target, the compiled schema and the operations. Written once
 * per operation and never changed. Holds no credentials.
 */
export interface MigrationRecord {
  formatVersion: 1;
  operationId: string;
  planDigest: string;
  /** Server URL of the project session the migration was sent to. */
  url: string;
  branch?: string;
  output: OutputDefinition;
  operations: MigrationOperation[];
  clear?: UploadStructureClearRequest;
  /** The owner approved the plan's content warnings. */
  acceptWarnings: boolean;
  startedAt: string;
}

const SAFE_OPERATION_ID = /^[A-Za-z0-9_.-]{8,128}$/;
const recordPath = (operationId: string) =>
  join(MIGRATIONS_DIRECTORY, `${operationId}.json`);

/** Written before apply, so a lost response can still be checked and reconciled. */
export function saveMigrationRecord(record: MigrationRecord) {
  if (!SAFE_OPERATION_ID.test(record.operationId))
    throw new Error(`Invalid operation ID: ${record.operationId}`);
  mkdirSync(MIGRATIONS_DIRECTORY, { recursive: true });
  // "wx": a record is immutable; an existing one is never overwritten.
  writeFileSync(recordPath(record.operationId), JSON.stringify(record, null, 2), {
    flag: "wx",
  });
  writeFileSync(
    LAST_MIGRATION_PATH,
    JSON.stringify({ operationId: record.operationId }, null, 2),
  );
}

/** The record of one operation, or of the last one started here when no ID is given. */
export function readMigrationRecord(operationId?: string): MigrationRecord | null {
  let id = operationId;
  if (!id) {
    try {
      id = JSON.parse(readFileSync(LAST_MIGRATION_PATH, "utf8")).operationId;
    } catch {
      return null;
    }
  }
  if (!id || !SAFE_OPERATION_ID.test(id) || !existsSync(recordPath(id)))
    return null;
  try {
    const record = JSON.parse(readFileSync(recordPath(id), "utf8"));
    return record?.formatVersion === 1 && record.operationId === id
      ? (record as MigrationRecord)
      : null;
  } catch {
    return null;
  }
}
