import { Command } from "commander";
import { randomUUID } from "crypto";
import type { MigrationOperation } from "@atmyapp/structure";
import {
  getMigrateConfig,
  Logger,
  MigrateOptions,
  buildClearRequestFromOptions,
  findCanonicalSchemaFile,
  loadCanonicalSchemaFile,
  logMigrationConflictGuidance,
  logMigrationPlan,
  mergeClearRequests,
  ensureAmaDirectory,
  planNeedsConfirmation,
  readMigrationRecord,
  readOperationsFile,
  saveMigrationRecord,
  saveOutputToFile,
  suggestedClearFromPlan,
  uploadDefinitions,
} from "../utils";
import {
  applyRemoteMigration,
  getRemoteMigrationStatus,
  planRemoteMigration,
  reconcileRemoteMigration,
  runCanonicalMigrate,
  type MigrationTarget,
  type RemoteMigrationPlan,
  type UploadStructureClearRequest,
} from "../../runtime";
import type { OutputDefinition } from "../types/migrate";

type MigrateCommandOptions = MigrateOptions & {
  clearCollection?: string[];
  clearContent?: string[];
  clearColumn?: string[];
  dangerouslyResolveAllConflicts?: boolean;
  operations?: string;
  branch?: string;
  yes?: boolean;
  json?: boolean;
};

class MigrationExit extends Error {
  constructor(
    message: string,
    readonly result?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
    });
  });
}

async function compileSchema(logger: Logger, config: Record<string, unknown>) {
  const canonicalSchemaFile = await findCanonicalSchemaFile(logger);
  if (!canonicalSchemaFile) {
    throw new Error(
      "No canonical schema file found. Add atmyapp.schema.ts, atmyapp.schema.mts, atmyapp.schema.js, atmyapp.schema.mjs, atmyapp.schema.json, or one of the legacy ama.schema.* names to your project root.",
    );
  }
  const schema = await loadCanonicalSchemaFile(canonicalSchemaFile, logger);
  const { output } = await runCanonicalMigrate({
    schema,
    config,
    dryRun: true,
    upload: false,
  });
  return output;
}

function migrationTarget(
  config: Record<string, unknown>,
  branch?: string,
): MigrationTarget {
  if (typeof config.url !== "string" || !config.url)
    throw new Error("Base URL not provided in session. Please run 'use' command first.");
  return {
    url: config.url,
    token: typeof config.token === "string" ? config.token : undefined,
    branch,
  };
}

/**
 * Plan against the target environment, confirm, then apply exactly that plan
 * under a fresh operation ID. Returns the machine-readable result.
 */
async function runPlannedMigration(input: {
  target: MigrationTarget;
  output: OutputDefinition;
  operations: MigrationOperation[];
  clear?: UploadStructureClearRequest;
  options: MigrateCommandOptions;
  logger: Logger;
}): Promise<Record<string, unknown> | "legacy"> {
  const { target, output, operations, options, logger } = input;
  let clear = input.clear;
  let planned = await planRemoteMigration(target, { output, operations, clear });
  if (!planned.ok && planned.status === 404) return "legacy";
  if (!planned.ok) throw new MigrationExit(`Could not plan the migration: ${planned.error}`);
  let plan: RemoteMigrationPlan = planned.data.plan;

  const destructiveOnly =
    plan.blocks.length > 0 &&
    plan.blocks.every((block) => block.code === "destructive-change");
  if (destructiveOnly && options.dangerouslyResolveAllConflicts) {
    logger.warn(
      "Dangerous conflict shortcut enabled. Planning again with clears for every destructive conflict in this plan.",
    );
    clear = mergeClearRequests(clear, suggestedClearFromPlan(plan));
    planned = await planRemoteMigration(target, { output, operations, clear });
    if (!planned.ok) throw new MigrationExit(`Could not plan the migration: ${planned.error}`);
    plan = planned.data.plan;
  }

  if (!options.json) logMigrationPlan(plan, logger);
  if (plan.unchanged) return { status: "unchanged", plan };
  if (plan.blocks.length) {
    if (!options.json && plan.destructive.issues.length)
      logMigrationConflictGuidance(
        {
          code: "DESTRUCTIVE_STRUCTURE_CHANGE_REQUIRES_CLEAR",
          branch: plan.branch,
          issues: plan.destructive.issues,
          suggestedClear: suggestedClearFromPlan(plan),
        },
        logger,
        options,
        clear,
      );
    throw new MigrationExit("The migration is blocked. Nothing was changed.", {
      status: "blocked",
      plan,
    });
  }

  if (planNeedsConfirmation(plan) && !options.yes) {
    if (!process.stdin.isTTY || options.json)
      throw new MigrationExit(
        "This plan changes stored content. Review it and run again with --yes to apply it.",
        { status: "confirmation-required", plan },
      );
    if (!(await askYesNo("Apply this migration? (y/N) ")))
      throw new MigrationExit("Migration cancelled. Nothing was changed.", {
        status: "cancelled",
        plan,
      });
  }

  // Reaching this point means the plan, including its warnings, was approved.
  const operationId = `cli-${randomUUID()}`;
  saveMigrationRecord({
    formatVersion: 1,
    operationId,
    planDigest: plan.digest,
    url: target.url,
    branch: target.branch,
    output,
    operations,
    clear,
    acceptWarnings: true,
    startedAt: new Date().toISOString(),
  });
  const applied = await applyRemoteMigration(target, {
    output,
    operations,
    clear,
    planDigest: plan.digest,
    operationId,
    acceptWarnings: true,
  });
  if (!applied.ok) {
    if (applied.uncertain)
      throw new MigrationExit(
        `The server did not confirm the migration (${applied.error}). It may have been applied. Check with: atmyapp migrate-status ${operationId}`,
        { status: "unknown", operationId, plan },
      );
    if (applied.code === "WARNINGS_NOT_ACCEPTED")
      throw new MigrationExit(
        "The server requires the plan's content warnings to be approved. Nothing was written. Run the migration again and confirm the plan.",
        { status: "failed", operationId },
      );
    if (applied.code === "PLAN_STALE")
      throw new MigrationExit(
        "Content or schema changed after this plan was made. Nothing was written. Run the migration again to review a fresh plan.",
        { status: "stale", operationId },
      );
    throw new MigrationExit(`Migration failed: ${applied.error}`, {
      status: "failed",
      operationId,
    });
  }
  if (applied.data.reconcileNeeded)
    logger.warn(
      `The migration is committed, but follow-up work did not finish. Run: atmyapp migrate-status ${operationId} --reconcile`,
    );
  return { status: "applied", operationId, plan, result: applied.data };
}

export function migrateCommand(): Command {
  return new Command("migrate")
    .description(
      "Plan the schema change against the target environment's content, then apply it",
    )
    .option(
      "--dry-run",
      "Compile the schema locally without contacting the server",
      false,
    )
    .option(
      "--operations <file>",
      "JSON file with explicit content operations (renameField, backfillField)",
    )
    .option("--branch <name>", "Target environment branch (default: main)")
    .option("-y, --yes", "Apply a plan that changes stored content without asking", false)
    .option("--json", "Print the plan and result as JSON", false)
    .option(
      "--clear-collection <name>",
      "Clear all entries from a collection before removing it",
      collectValues,
      [] as string[],
    )
    .option(
      "--clear-content <name>",
      "Clear a structured content file before removing it",
      collectValues,
      [] as string[],
    )
    .option(
      "--clear-column <collection.column>",
      "Confirm hiding a removed column; its stored values are retained",
      collectValues,
      [] as string[],
    )
    .option(
      "--dangerously-resolve-all-conflicts",
      "Plan again with clears for every destructive conflict in the current plan",
      false,
    )
    .option("--verbose", "Enable verbose logging", false)
    .action(async (options: MigrateCommandOptions) => {
      const startTime = Date.now();
      // With --json, stdout carries exactly one JSON document; logs go to stderr.
      const logger = new Logger(options.verbose, { stderr: options.json });

      try {
        logger.verbose_log(`Options: ${JSON.stringify(options)}`);

        if (
          options.dryRun &&
          ((options.clearCollection?.length ?? 0) > 0 ||
            (options.clearContent?.length ?? 0) > 0 ||
            (options.clearColumn?.length ?? 0) > 0 ||
            options.dangerouslyResolveAllConflicts)
        ) {
          throw new Error(
            "Conflict resolution flags cannot be used with --dry-run because they require a real upload.",
          );
        }

        const config = getMigrateConfig(process.cwd(), {
          allowMissingSession: options.dryRun,
        });
        ensureAmaDirectory(logger);
        const output = await compileSchema(logger, config as Record<string, unknown>);
        logger.success(
          `Loaded ${Object.keys(output.definitions).length} definitions from canonical schema.`,
        );
        saveOutputToFile(output, logger);
        const operations = options.operations
          ? readOperationsFile(options.operations)
          : [];

        if (options.dryRun) {
          logger.info(
            "Dry run: the schema compiled locally. Run without --dry-run to plan against the target environment's content.",
          );
          return;
        }

        const requestedClear = buildClearRequestFromOptions(options);
        const target = migrationTarget(config as Record<string, unknown>, options.branch);
        const result = await runPlannedMigration({
          target,
          output,
          operations,
          clear: requestedClear,
          options,
          logger,
        });

        if (result === "legacy") {
          if (operations.length)
            throw new Error(
              "This server does not support migration plans, so --operations cannot be applied. Update the server first.",
            );
          logger.warn(
            "This server does not support migration plans. Uploading the schema directly.",
          );
          await runLegacyUpload(output, config, logger, requestedClear, options);
          if (options.json) printJson({ status: "applied", legacy: true });
        } else if (options.json) {
          printJson(result);
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.success(`Migration completed in ${totalTime}s.`);
      } catch (error: unknown) {
        if (error instanceof MigrationExit) {
          if (options.json)
            printJson(error.result ?? { status: "failed", error: error.message });
          logger.error(error.message);
          process.exit(1);
        }
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const message =
          error instanceof Error ? error.message : "Unknown error";
        if (options.json) printJson({ status: "error", error: message });
        logger.error(`Fatal error after ${totalTime}s: ${message}`, error);
        process.exit(1);
      }
    });
}

async function runLegacyUpload(
  output: OutputDefinition,
  config: ReturnType<typeof getMigrateConfig>,
  logger: Logger,
  requestedClear: UploadStructureClearRequest | undefined,
  options: MigrateCommandOptions,
) {
  let uploadResult = await uploadDefinitions(output, config, logger, requestedClear);
  if (
    !uploadResult.success &&
    uploadResult.conflict &&
    options.dangerouslyResolveAllConflicts
  ) {
    logger.warn(
      "Dangerous conflict shortcut enabled. Retrying once with the server's suggested clear payload for this exact conflict.",
    );
    uploadResult = await uploadDefinitions(
      output,
      config,
      logger,
      mergeClearRequests(requestedClear, uploadResult.conflict.suggestedClear),
    );
  }
  if (!uploadResult.success) {
    if (uploadResult.conflict)
      logMigrationConflictGuidance(
        uploadResult.conflict,
        logger,
        options,
        requestedClear,
      );
    throw new MigrationExit(
      uploadResult.conflict
        ? "Migration was blocked on the server, but definitions were generated and saved locally."
        : "Upload failed, but definitions were generated successfully.",
    );
  }
}

export function migrateStatusCommand(): Command {
  return new Command("migrate-status")
    .description(
      "Check whether a migration was applied, and finish its follow-up work",
    )
    .argument("[operationId]", "Operation ID (default: the last migration started here)")
    .option("--branch <name>", "Target environment branch (default: main)")
    .option(
      "--reconcile",
      "Re-run follow-up work for a committed migration, using the schema and operations it was applied with",
      false,
    )
    .option(
      "--operations <file>",
      "Operations file, only for a migration started elsewhere (without a local record)",
    )
    .option("--json", "Print the result as JSON", false)
    .option("--verbose", "Enable verbose logging", false)
    .action(
      async (
        operationIdArgument: string | undefined,
        options: {
          branch?: string;
          reconcile?: boolean;
          operations?: string;
          json?: boolean;
          verbose?: boolean;
        },
      ) => {
        const logger = new Logger(Boolean(options.verbose), {
          stderr: options.json,
        });
        try {
          const record = readMigrationRecord(operationIdArgument);
          const operationId = operationIdArgument ?? record?.operationId;
          if (!operationId)
            throw new Error("No operation ID given and no migration was started from this directory.");
          const config = getMigrateConfig(process.cwd());
          const target = migrationTarget(
            config as Record<string, unknown>,
            options.branch ?? record?.branch,
          );
          // A record names where its migration went; never ask another project.
          if (record && record.url !== target.url)
            throw new Error(
              `Migration ${operationId} was sent to ${record.url}, but this session uses ${target.url}. Switch back with 'atmyapp use' first.`,
            );
          if (record && (record.branch ?? "main") !== (target.branch ?? "main"))
            throw new Error(
              `Migration ${operationId} was applied to branch "${record.branch ?? "main"}", not "${target.branch ?? "main"}".`,
            );
          const where = `${target.url} (${target.branch ?? "main"})`;
          const status = await getRemoteMigrationStatus(target, operationId);
          if (!status.ok) throw new Error(`Could not read the migration status: ${status.error}`);

          if (status.data.status === "not-found") {
            if (options.json) printJson(status.data);
            logger.warn(
              `Migration ${operationId} was not applied to ${where}. Nothing was changed; run the migration again.`,
            );
            return;
          }
          logger.success(
            `Migration ${operationId} is committed (${status.data.commitSha?.slice(0, 12)}).`,
          );
          if (!options.reconcile) {
            if (options.json) printJson(status.data);
            return;
          }

          if (!record)
            logger.warn(
              "No local record of this migration. Using the current schema files; the server checks that they match what was applied.",
            );
          const request = record
            ? { output: record.output, operations: record.operations, clear: record.clear }
            : {
                output: await compileSchema(logger, config as Record<string, unknown>),
                operations: options.operations ? readOperationsFile(options.operations) : [],
              };
          const reconciled = await reconcileRemoteMigration(target, operationId, request);
          if (!reconciled.ok) throw new Error(`Reconciliation failed: ${reconciled.error}`);
          if (options.json) printJson(reconciled.data);
          if (reconciled.data.reconcileNeeded) {
            logger.error("Some follow-up work still failed. Try again later.");
            process.exit(1);
            return;
          }
          logger.success("Follow-up work is complete.");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (options.json) printJson({ status: "error", error: message });
          logger.error(message);
          process.exit(1);
        }
      },
    );
}

/** The only stdout output in --json mode. */
function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function collectValues(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
