import chalk from "chalk";
import { Command } from "commander";
import { headCommit } from "../../runtime/pull";
import { fetchRemoteSchema } from "../../runtime/schema";
import { ContentStore } from "../../runtime/store";
import { EXIT, toCliError } from "../../runtime/errors";
import { Logger } from "../logger";
import { connect, runAction, withCommonOptions, type CommonOptions } from "../output";
import { findCanonicalSchemaFile, loadCanonicalSchemaFile } from "../utils/canonical-schema";

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
  details?: Record<string, unknown>;
}

interface IntegrationVerification {
  status: "passed" | "failed" | "pending" | "unknown" | "unsupported";
  code: string;
  publicReachable: boolean | null;
  checkedAt: string;
}

/** The dashboard's wording for each website check result (ama-shared verificationMessages). */
const VERIFICATION_MESSAGES: Record<string, string> = {
  verified: "The available connection checks passed.",
  issues_found: "Some website connection checks need attention.",
  unavailable: "Verification is unavailable. Enable the AtMyApp diagnostics route on this website.",
  starting: "The preview is still starting. Check again shortly.",
  unreachable: "The website could not be reached.",
  invalid_report: "The website did not return a valid connection report.",
  project_mismatch: "The website is connected to a different project.",
  target_unavailable: "There is no website available to check yet.",
  unsupported_version: "This report format is not supported yet.",
  code_mismatch: "The website reports a different code version than the selected build.",
  release_mismatch: "The public website is serving a different release than expected.",
};

export function doctorCommand(): Command {
  return withCommonOptions(new Command("doctor"))
    .description("Check the connection, the schema, the website integration and the local copy")
    .option("--no-website", "Skip the website connection check")
    .action((options: CommonOptions & { website?: boolean }) =>
      runAction(
        options,
        async () => {
          const checks: DoctorCheck[] = [];
          const add = (check: DoctorCheck) => checks.push(check);
          let connection: ReturnType<typeof connect>;
          try {
            connection = connect(options);
            const verified = await connection.api.verifyKey<{ keyName: string; effectiveScopes?: string[]; scopes: string[]; stoppedReason?: string | null }>();
            const scopes = verified.effectiveScopes ?? verified.scopes;
            add({
              name: "connection",
              status: verified.stoppedReason ? "warn" : "ok",
              message: `Connected with key '${verified.keyName}' (${scopes.join(", ") || "no scopes"}).`,
              ...(verified.stoppedReason ? { fix: verified.stoppedReason } : {}),
              details: { scopes },
            });
          } catch (raw) {
            const error = toCliError(raw);
            add({ name: "connection", status: "fail", message: error.message, fix: error.fix });
            process.exitCode = error.exitCode;
            return { healthy: false, checks };
          }
          const { api } = connection;

          let remoteNames: string[] | null = null;
          try {
            const schema = await fetchRemoteSchema(api);
            remoteNames = Object.keys(schema.document.definitions);
            add({ name: "remote-schema", status: "ok", message: `The project has a schema with ${remoteNames.length} definitions.` });
          } catch (raw) {
            const error = toCliError(raw);
            add({ name: "remote-schema", status: "fail", message: error.message, fix: error.fix });
          }

          const silent = new Logger(false, { silent: true });
          const schemaFile = await findCanonicalSchemaFile(silent).catch(() => null);
          if (!schemaFile) {
            add({ name: "local-schema", status: "warn", message: "No atmyapp.schema.ts in this folder.", fix: "Run 'atmyapp init' or open the website's folder." });
          } else if (remoteNames) {
            try {
              const local = await loadCanonicalSchemaFile(schemaFile, silent);
              const localNames = Object.keys(local.definitions ?? {});
              const onlyLocal = localNames.filter((name) => !remoteNames!.includes(name));
              const onlyRemote = remoteNames.filter((name) => !localNames.includes(name));
              add(
                onlyLocal.length || onlyRemote.length
                  ? {
                      name: "local-schema",
                      status: "warn",
                      message: "The local schema and the project's schema have different definitions.",
                      fix: "Run 'atmyapp migrate --dry-run' to review, then 'atmyapp migrate'.",
                      details: { onlyLocal, onlyRemote },
                    }
                  : { name: "local-schema", status: "ok", message: "The local schema has the same definitions as the project." },
              );
            } catch (raw) {
              add({ name: "local-schema", status: "fail", message: `The local schema did not load: ${toCliError(raw).message}` });
            }
          }

          if (options.website === false) {
            add({ name: "website", status: "skipped", message: "Skipped (--no-website)." });
          } else {
            try {
              const result = await api.json<IntegrationVerification>("POST", "integration-check", { body: { kind: "website" } });
              const status: CheckStatus = result?.status === "passed" ? "ok" : result?.status === "failed" ? "fail" : "warn";
              add({
                name: "website",
                status,
                message: VERIFICATION_MESSAGES[result?.code ?? ""] ?? `Website check: ${result?.code ?? "unknown"}.`,
                details: { code: result?.code, publicReachable: result?.publicReachable ?? null },
                ...(status !== "ok" ? { fix: "See https://docs.atmyapp.com/guides/diagnostics/" } : {}),
              });
            } catch (raw) {
              const error = toCliError(raw);
              add({ name: "website", status: "warn", message: `The website check did not run: ${error.message}`, fix: error.fix });
            }
          }

          const manifest = (() => {
            try {
              return new ContentStore().readManifest();
            } catch {
              return null;
            }
          })();
          if (!manifest) {
            add({ name: "local-copy", status: "skipped", message: "No local content copy.", fix: "Run 'atmyapp content pull' to work offline." });
          } else {
            const head = await headCommit(api).catch(() => null);
            add(
              head && manifest.baseCommit !== head
                ? { name: "local-copy", status: "warn", message: "The local content copy is older than the project.", fix: "Run 'atmyapp content pull'." }
                : { name: "local-copy", status: "ok", message: `The local content copy is current (pulled ${manifest.pulledAt}).` },
            );
          }

          const healthy = !checks.some((check) => check.status === "fail");
          // A failed check fails the command, with --json too.
          if (!healthy) process.exitCode = EXIT.error;
          return { healthy, checks };
        },
        (result) => {
          const icon: Record<CheckStatus, string> = { ok: chalk.green("✓"), warn: chalk.yellow("!"), fail: chalk.red("✗"), skipped: chalk.gray("-") };
          for (const check of result.checks) {
            console.log(`${icon[check.status]} ${chalk.bold(check.name)}  ${check.message}`);
            if (check.fix) console.log(chalk.gray(`    ${check.fix}`));
          }
        },
      ),
    );
}
