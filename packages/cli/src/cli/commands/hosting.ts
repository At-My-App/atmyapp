import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { CliError } from "../../runtime/errors";
import { hostingDeploy, hostingLogs, hostingPromote, hostingReleases, hostingStatus, parseDeployTimeout } from "../../runtime/hosting";
import { connect, runAction, table, withCommonOptions, type CommonOptions } from "../output";

type HostingOptions = CommonOptions & { deployment?: string; dryRun?: boolean };

export function hostingCommand(): Command {
  const releases = new Command("releases").description("Browse website releases")
    .addCommand(withCommonOptions(new Command("ls"))
      .description("List website releases")
      .option("--deployment <id>", "Restrict to this deployment")
      .addHelpText("after", "\nExample: atmyapp hosting releases ls --json")
      .action((opts: HostingOptions) => runAction(opts, () => hostingReleases(connect(opts).api, opts.deployment),
        (result) => console.log(table(result.releases, ["id", "deployment_id", "status", "branch", "commit_sha", "created_at"])))));

  return new Command("hosting").description("Check, build, and promote website releases")
    .addCommand(releases)
    .addCommand(withCommonOptions(new Command("status"))
      .description("Show deployments, active releases, build presets, domains, and publication status")
      .option("--content-commit <sha>", "Track a specific published content commit")
      .addHelpText("after", "\nExample: atmyapp hosting status --json")
      .action((opts: CommonOptions & { contentCommit?: string }) => runAction(opts,
        () => hostingStatus(connect(opts).api, opts.contentCommit), (result) => {
          const stateByDeployment = new Map(result.publication.websites.map((site) => [site.deploymentId, site.state]));
          const rows = result.deployments.map((deployment) => ({
            name: deployment.name, id: deployment.id, release: deployment.active_release_id,
            preset: deployment.buildPreset?.name ?? deployment.build_preset_id, publication: stateByDeployment.get(deployment.id),
          }));
          console.log(table(rows, ["name", "id", "release", "preset", "publication"]));
          console.log("Domains\n" + table(result.domains, ["hostname", "status", "deploymentId"]));
          if (result.publication.contentCommit) console.log("Content commit " + result.publication.contentCommit);
        })))
    .addCommand(withCommonOptions(new Command("deploy"))
      .description("Start a website build using its configured preset")
      .option("--deployment <id>", "Choose a deployment when the project has multiple websites")
      .option("--wait", "Wait until the build finishes")
      .option("--timeout <duration>", "Maximum wait, for example 12m (default 16m)")
      .option("--dry-run", "Show which deployment would be built")
      .addHelpText("after", "\nExample: atmyapp hosting deploy --wait --timeout 15m")
      .action((opts: HostingOptions & { timeout?: string; wait?: boolean }) => runAction(opts, async ({ json }) => {
        try {
          return await hostingDeploy(connect(opts).api, {
            deploymentId: opts.deployment, dryRun: opts.dryRun, wait: opts.wait,
            timeoutMs: opts.timeout === undefined ? undefined : parseDeployTimeout(opts.timeout),
            onRelease: opts.wait && !json ? (id) => console.error("Started release " + id + ".") : undefined,
          });
        } catch (error) {
          if (!json && error instanceof CliError && error.code === "build_failed" && Array.isArray(error.details?.logs)) {
            for (const line of error.details.logs) console.error(stripVTControlCharacters(String(line)));
          }
          throw error;
        }
      }, (result) => console.log(result.dryRun ? "Would build " + result.deployment.name + "."
        : "Release " + result.release.id + " · " + result.release.status))))
    .addCommand(withCommonOptions(new Command("logs"), { ndjson: true })
      .description("Read a release’s build logs. With --json, output is NDJSON.")
      .argument("<releaseId>", "Release ID from hosting releases ls")
      .option("--deployment <id>", "Look up the release in this deployment")
      .option("--follow", "Poll until the build finishes")
      .addHelpText("after", "\nExample: atmyapp hosting logs <releaseId> --follow --json")
      .action((id: string, opts: HostingOptions & { follow?: boolean }) => runAction(opts,
        ({ json }) => hostingLogs(connect(opts).api, id, {
          deploymentId: opts.deployment, follow: opts.follow,
          emit: (record) => {
            if (json) process.stdout.write(JSON.stringify(record) + "\n");
            else if (record.type === "log") console.log(stripVTControlCharacters(record.line));
            else if (record.type === "status") console.error("Release " + record.status + ".");
            else console.error("Build log restarted.");
          },
        }), () => undefined, { ndjson: true })))
    .addCommand(withCommonOptions(new Command("promote"))
      .description("Make a ready release live")
      .argument("<releaseId>", "Release ID from hosting releases ls")
      .option("--deployment <id>", "Look up the release in this deployment")
      .option("--dry-run", "Check the target release without making it live")
      .addHelpText("after", "\nExample: atmyapp hosting promote <releaseId> --dry-run")
      .action((id: string, opts: HostingOptions) => runAction(opts,
        () => hostingPromote(connect(opts).api, id, { deploymentId: opts.deployment, dryRun: opts.dryRun }),
        (result) => console.log(result.dryRun ? "Would promote " + result.release.id + "."
          : "Promoted " + result.promotedRelease.id + "."))));
}
