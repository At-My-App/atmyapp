import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { CliError } from "../../runtime/errors";
import { waitTimeout } from "../../runtime/duration";
import { hostingDeploy, hostingLogs, hostingPromote, hostingReleases, hostingStatus } from "../../runtime/hosting";
import { connect, printValue, runAction, table, withCommonOptions, type CommonOptions } from "../output";
import { listPreviewBuilds, listShareLinks, openPreviewBuild, revokeShareLink, sharePreview } from "../../runtime/previewServers";

type HostingOptions = CommonOptions & { deployment?: string; dryRun?: boolean };

export function hostingCommand(): Command {
  const releases = new Command("releases").description("Browse website releases")
    .addCommand(withCommonOptions(new Command("ls"))
      .description("List website releases")
      .option("--deployment <id>", "Restrict to this deployment")
      .addHelpText("after", "\nExample: atmyapp hosting releases ls --json")
      .action((opts: HostingOptions) => runAction(opts, () => hostingReleases(connect(opts).api, opts.deployment),
        (result) => console.log(table(result.releases, ["id", "deployment_id", "status", "branch", "commit_sha", "created_at"])))));

  type SiteOptions = CommonOptions & { website?: string };
  const previewLinks = new Command("links").description("Share links to previews")
    .addCommand(withCommonOptions(new Command("ls"))
      .description("List a website's share links")
      .option("--website <name>", "Which website (default: the only one)")
      .action((opts: SiteOptions) => runAction(opts, () => listShareLinks(connect(opts).api, opts),
        (result) => console.log(table(result.links, ["id", "label", "status", "expiresAt", "createdBy"])))))
    .addCommand(withCommonOptions(new Command("revoke"))
      .description("Stop a share link working")
      .argument("<linkId>", "Link ID from 'hosting previews links ls'")
      .action((id: string, opts: CommonOptions) => runAction(opts, () => revokeShareLink(connect(opts).api, id),
        () => console.log("Revoked."))));

  const previews = new Command("previews").description("Preview builds of a website and links to share them")
    .addCommand(previewLinks)
    .addCommand(withCommonOptions(new Command("ls"))
      .description("The preview branch and one-time preview builds")
      .option("--website <name>", "Which website (default: the only one)")
      .action((opts: SiteOptions) => runAction(opts, () => listPreviewBuilds(connect(opts).api, opts), (result) => printValue(result.previews))))
    .addCommand(withCommonOptions(new Command("share"))
      .description("A link anyone can open to a finished build (the live one unless --release)")
      .requiredOption("--label <text>", "Who or what the link is for")
      .option("--expires <duration>", "1d, 7d or 30d", "7d")
      .option("--release <releaseId>", "A ready build, including preview builds")
      .option("--website <name>", "Which website (default: the only one)")
      .addHelpText("after", "\nNeeds a personal login or token: project keys can't share.\n\nExample: atmyapp hosting previews share --label \"Client review\" --expires 7d")
      .action((opts: SiteOptions & { label: string; expires?: string; release?: string }) => runAction(opts,
        () => sharePreview(connect(opts).api, opts), (result) => console.log(result.link.url))))
    .addCommand(withCommonOptions(new Command("open"))
      .description("Your own link to the preview branch or a preview build (signed in as you)")
      .option("--build <releaseId>", "A one-time preview build instead of the preview branch")
      .option("--website <name>", "Which website (default: the only one)")
      .addHelpText("after", "\nNeeds a personal login or token: the link opens as you.")
      .action((opts: SiteOptions & { build?: string }) => runAction(opts, () => openPreviewBuild(connect(opts).api, opts),
        (result) => console.log(result.url))));

  return new Command("hosting").description("Check, build, and promote website releases")
    .addCommand(releases)
    .addCommand(previews)
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
      .option("--timeout <duration>", "Longest wait with --wait: 5s to 1h (default 15m)")
      .option("--dry-run", "Show which deployment would be built")
      .option("--no-promote", "Build only: don't make it live when the build succeeds (then 'hosting promote')")
      .addHelpText("after", "\nOn a website that promotes builds automatically, a deploy makes the build live; with a login set to ask before promoting, it asks first. --no-promote builds without asking and leaves the release for 'hosting promote'.\n\nExample: atmyapp hosting deploy --wait --timeout 15m")
      .action((opts: HostingOptions & { timeout?: string; wait?: boolean; promote?: boolean }) => runAction(opts, async ({ json }) => {
        try {
          return await hostingDeploy(connect(opts).api, {
            deploymentId: opts.deployment, dryRun: opts.dryRun, wait: opts.wait, promote: opts.promote,
            timeoutMs: waitTimeout("deploy", opts.timeout),
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
