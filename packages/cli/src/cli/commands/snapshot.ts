import { Command, Option } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ApiClient } from "../../runtime/api";
import { CliError, EXIT } from "../../runtime/errors";
import { replaceWithArchive, snapshotDestination } from "../../runtime/snapshotFiles";
import type { Logger } from "../logger";
import { connect, runAction, withCommonOptions, type CommonOptions } from "../output";

type SnapshotCommandOptions = CommonOptions & {
  branch?: string;
  forceSync?: boolean;
  output?: string;
  force?: boolean;
  /** Hidden one-version aliases for the old -t/-u/-p flags. */
  t?: string;
  u?: string;
  p?: string;
};

interface SnapshotResponse {
  success: boolean;
  data?: {
    success: boolean;
    projectId: string;
    branch: string;
    downloadUrl: string;
    stats: {
      collectionsProcessed: number;
      entriesIncluded: number;
      blobsIncluded: number;
      filesIncluded: number;
      totalSizeBytes: number;
      filesSkippedTooLarge: number;
      failedItems: number;
    };
    duration: number;
    expiresAt: string;
  };
  error?: string;
}

interface LatestSnapshotResponse {
  success: boolean;
  data?: {
    id: string;
    projectId: string;
    branch: string;
    status: string;
    downloadUrl: string;
    downloadKey: string;
    expiresAt: string;
    isExpired: boolean;
    stats: {
      collectionsProcessed: number;
      entriesIncluded: number;
      blobsIncluded: number;
      totalSizeBytes: number;
    };
    durationMs: number;
    createdAt: string;
    completedAt: string;
  };
  error?: string;
}

const DEFAULT_OUTPUT_PATH = ".ama/local";
/**
 * The work-container API URL for snapshot operations, on the same host as the
 * session's project URL (`…/v0/work-container/projects/<id>/<endpoint>`).
 */
export function getSnapshotApiUrl(sessionUrl: string, projectId: string, endpoint: string): string {
  const parsed = new URL(sessionUrl.replace(/\/+$/, ""));
  const segments = parsed.pathname.split("/").filter(Boolean);
  const projectIndex = segments.indexOf("projects");
  const base = projectIndex === -1 ? segments : segments.slice(0, projectIndex);
  const prefix = base[base.length - 1] === "v0" ? base : [...base, "v0"];
  parsed.pathname = `/${[...prefix, "work-container", "projects", encodeURIComponent(projectId), endpoint].join("/")}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function failure(response: Response, what: string): Promise<CliError> {
  const text = await response.text().catch(() => "");
  let message = text;
  try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
  const status = response.status;
  return new CliError(status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "snapshot_failed",
    `Could not ${what}: ${message || `status ${status}`}`, {
      status,
      exitCode: status === 401 || status === 403 ? EXIT.auth : EXIT.error,
      fix: status === 403 ? "Snapshots need a key with the snapshot scope." : undefined,
    });
}

/** Create a new snapshot. */
async function createSnapshot(api: ApiClient, options: SnapshotCommandOptions, logger: Logger): Promise<NonNullable<SnapshotResponse["data"]>> {
  const { session } = api;
  const url = getSnapshotApiUrl(session.url, session.projectId, "snapshot");
  logger.info(`Creating snapshot for project ${session.projectId}...`);
  logger.verbose_log(`POST ${url}`);
  const response = await api.send("POST", url, { branch: options.branch ?? "main", forceFullSync: options.forceSync ?? false });
  if (!response.ok) throw await failure(response, "create the snapshot");
  const result = (await response.json()) as SnapshotResponse;
  if (!result.success || !result.data) throw new CliError("snapshot_failed", result.error ?? "Failed to create the snapshot.");
  return result.data;
}

/** The latest snapshot, if any. */
async function getLatestSnapshot(api: ApiClient, options: SnapshotCommandOptions, logger: Logger): Promise<LatestSnapshotResponse["data"] | null> {
  const { session } = api;
  const url = `${getSnapshotApiUrl(session.url, session.projectId, "latest-snapshot")}?branch=${encodeURIComponent(options.branch ?? "main")}`;
  logger.verbose_log(`GET ${url}`);
  const response = await api.send("GET", url);
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response, "read the latest snapshot");
  return ((await response.json()) as LatestSnapshotResponse).data ?? null;
}

/** Downloads the ZIP to `outputPath`. */
async function downloadSnapshotFile(downloadUrl: string, token: string, outputPath: string, logger: Logger): Promise<void> {
  logger.info("Downloading snapshot...");
  logger.verbose_log(`GET ${downloadUrl}`);
  const response = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw await failure(response, "download the snapshot");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}

/** Format bytes to human readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/** Standard connection options plus the old short flags, hidden for one minor version. */
function snapshotOptions(command: Command): Command {
  return withCommonOptions(command)
    .addOption(new Option("-t <token>", "Same as --token").hideHelp())
    .addOption(new Option("-u <url>", "Same as --url").hideHelp())
    .addOption(new Option("-p <id>", "Same as --project").hideHelp())
    .option("-b, --branch <branch>", "Branch name", "main");
}

function withAliases(options: SnapshotCommandOptions): SnapshotCommandOptions {
  return { ...options, token: options.token ?? options.t, url: options.url ?? options.u, project: options.project ?? options.p };
}

export function snapshotCommand(): Command {
  const command = new Command("snapshot")
    .description("Manage storage snapshots for local fallback (.ama/local)")
    .addHelpText(
      "after",
      "\n'atmyapp content pull' keeps a newer local copy in .ama/content: it updates only what changed, includes translations, and is read by the SDK's local and with-fallback modes."
    );

  command.addCommand(snapshotOptions(new Command("create"))
    .description("Create a new storage snapshot (may take a few minutes)")
    .option("--force-sync", "Force full sync instead of incremental")
    .addHelpText("after", "\nExample: atmyapp snapshot create --json")
    .action((raw: SnapshotCommandOptions) => {
      const options = withAliases(raw);
      return runAction(options, ({ logger }) => createSnapshot(connect(options).api, options, logger), (data, { logger }) => {
        logger.success("Snapshot created.");
        logger.info(`  Project: ${data.projectId}`);
        logger.info(`  Branch: ${data.branch}`);
        logger.info(`  Collections: ${data.stats.collectionsProcessed}`);
        logger.info(`  Entries: ${data.stats.entriesIncluded}`);
        logger.info(`  Blobs: ${data.stats.blobsIncluded}`);
        logger.info(`  Files: ${data.stats.filesIncluded}`);
        logger.info(`  Size: ${formatBytes(data.stats.totalSizeBytes)}`);
        logger.info(`  Duration: ${data.duration}ms`);
        logger.info(`  Download URL expires: ${data.expiresAt}`);
        logger.info("");
        logger.info("To download this snapshot, run:");
        logger.info("  atmyapp snapshot download");
      });
    }));

  command.addCommand(snapshotOptions(new Command("download"))
    .description("Download the latest snapshot to local storage")
    .option("-o, --output <path>", "Output directory", DEFAULT_OUTPUT_PATH)
    .option("--force", "Replace a folder that holds files no snapshot created")
    .addHelpText("after", "\nExample: atmyapp snapshot download --json")
    .action((raw: SnapshotCommandOptions) => {
      const options = withAliases(raw);
      return runAction(options, async ({ logger }) => {
        // Refuse an unsafe destination before downloading anything.
        const outputDir = snapshotDestination(options.output, { force: options.force });
        const { api, session } = connect(options);
        logger.info("Checking for latest snapshot...");
        const latest = await getLatestSnapshot(api, options, logger);
        let downloadUrl: string;
        let reused = false;
        if (latest && !latest.isExpired) {
          logger.info(`Found existing snapshot from: ${latest.createdAt}`);
          downloadUrl = latest.downloadUrl;
          reused = true;
        } else {
          logger.info(latest?.isExpired ? "Latest snapshot has expired, creating a new one..." : "No existing snapshot found, creating a new one...");
          const created = await createSnapshot(api, options, logger);
          downloadUrl = created.downloadUrl;
          logger.info(`Snapshot created (${formatBytes(created.stats.totalSizeBytes)})`);
        }
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-snapshot-"));
        const zipPath = path.join(workDir, "snapshot.zip");
        try {
          await downloadSnapshotFile(downloadUrl, session.token, zipPath, logger);
          logger.info("Extracting snapshot...");
          // The previous snapshot is replaced only once the new one is extracted.
          replaceWithArchive(zipPath, outputDir);
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
        return { outputDir, reused, branch: options.branch ?? "main" };
      }, (result, { logger }) => {
        logger.success(`Snapshot extracted to: ${result.outputDir}`);
        logger.info("");
        logger.info("Your local storage is now ready. Configure your client with:");
        logger.info('  clientMode: "local"');
        logger.info("  or");
        logger.info('  clientMode: "with-fallback"');
      });
    }));

  return command;
}
