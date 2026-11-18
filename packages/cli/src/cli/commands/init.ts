import { Command, Option } from "commander";
import { Logger } from "../logger";
import {
  DEFAULT_CANONICAL_SCHEMA_FILENAME,
  DEFAULT_CANONICAL_SCHEMA_TEMPLATE,
  type CanonicalSchemaTemplateName,
  initializeCanonicalSchema,
} from "../utils/canonical-schema";
import { resolveSession } from "../utils/http";
import { ensureStoreIgnored } from "../../runtime/store";

interface InitCommandOptions {
  path?: string;
  template?: CanonicalSchemaTemplateName;
  force?: boolean;
  verbose?: boolean;
  token?: string;
  url?: string;
  projectId?: string;
}

function supportsClientTemplate(template: CanonicalSchemaTemplateName): boolean {
  return template === "minimal" || template === "blog";
}

/**
 * Websites need a content API key. A CLI key may not create one (keys are
 * created by a person in the dashboard), so `init` says where to get it.
 */
function printApiKeyHint(
  logger: Logger,
  options: InitCommandOptions,
  template: CanonicalSchemaTemplateName,
): void {
  if (!supportsClientTemplate(template)) {
    return;
  }

  let contentApiUrl: string | null = null;
  try {
    const session = resolveSession({
      token: options.token,
      url: options.url,
      projectId: options.projectId,
    });
    contentApiUrl = getContentApiUrl(session.url, session.projectId);
  } catch {
    contentApiUrl = null;
  }

  logger.info(
    "Your website reads content with an API key. Create one in Settings → API keys, then add these lines to your env file:",
  );
  console.log(
    `ATMYAPP_API_URL=${contentApiUrl ?? "<Project API URL from Settings → API keys>"}`,
  );
  console.log("ATMYAPP_API_KEY=<API key from Settings → API keys>");
}

/**
 * Websites read content from the edge host, while the CLI talks to the core
 * API host. Returns null for hosts without a known edge counterpart.
 */
export function getContentApiUrl(cliUrl: string, projectId: string): string | null {
  const edgeOrigins: Record<string, string> = {
    "api.atmyapp.com": "https://edge.atmyapp.com",
    "staging-api.atmyapp.com": "https://staging-edge.atmyapp.com",
  };
  let host: string;
  try {
    host = new URL(cliUrl).host;
  } catch {
    return null;
  }
  const origin = edgeOrigins[host];
  return origin ? `${origin}/v0/projects/${encodeURIComponent(projectId)}` : null;
}

export function initCommand(): Command {
  return new Command("init")
    .description("Create starter AtMyApp schema and client files")
    .addOption(
      new Option("--template <template>", "Template name")
        .choices(["empty", "minimal", "blog"])
        .default(DEFAULT_CANONICAL_SCHEMA_TEMPLATE),
    )
    .option(
      "--path <path>",
      "Schema file path",
      DEFAULT_CANONICAL_SCHEMA_FILENAME,
    )
    .option("--force", "Overwrite generated files if they already exist", false)
    .option("-t, --token <token>", "Authentication token override")
    .option("-u, --url <url>", "Project URL override")
    .option("-p, --project-id <id>", "Project identifier override")
    .option("--verbose", "Enable verbose logging", false)
    .action(async (options: InitCommandOptions) => {
      const logger = new Logger(Boolean(options.verbose));

      try {
        const result = await initializeCanonicalSchema(logger, {
          filePath: options.path,
          template: options.template,
          force: Boolean(options.force),
        });

        logger.info(`Schema ready at ${result.schemaPath}.`);
        if (result.clientPath) {
          logger.info(`Client ready at ${result.clientPath}.`);
        }

        printApiKeyHint(logger, options, result.template);
        ensureStoreIgnored();

        logger.info("Next step: run `atmyapp migrate --dry-run --verbose`.");
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        logger.error(`Init failed: ${message}`, error);
        process.exit(1);
      }
    });
}
