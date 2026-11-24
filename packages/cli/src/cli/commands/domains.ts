import chalk from "chalk";
import { Command, Option } from "commander";
import {
  addDomain,
  checkDomain,
  editDomain,
  listDomains,
  recordsAsText,
  removeDomain,
  showDomain,
  type DomainResult,
} from "../../runtime/domains";
import { waitTimeout } from "../../runtime/duration";
import { connect, runAction, table, withCommonOptions, type CommonOptions } from "../output";
import { confirm } from "./draftOptions";

type WriteOptions = CommonOptions & { dryRun?: boolean; yes?: boolean };

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

const PHASE_LABEL: Record<string, string> = {
  removing: "Removing",
  records: "Add DNS records",
  certificate: "Issuing HTTPS certificate",
  website: "No website showing",
  live: "Live",
  problem: "Needs attention",
};

/** The human view of one domain: where it stands, the records, issues and next steps. */
function printDomain({ domain, setup }: DomainResult, options: { debug?: boolean } = {}) {
  const phase = PHASE_LABEL[setup.phase] ?? setup.phase;
  const color = setup.phase === "live" ? chalk.green : setup.phase === "problem" ? chalk.yellow : chalk.cyan;
  console.log(`${chalk.bold(domain.hostname)}  ${color(phase)}`);
  console.log(setup.summary);
  const website = domain.assignment?.deploymentName
    ? `${domain.assignment.deploymentName}${domain.assignment.routeStatus === "disabled" ? " (turned off)" : ""}`
    : "none";
  console.log(chalk.gray(`Website: ${website} · last check ${ago(domain.lastCheckedAt)}`));
  if (setup.phase !== "live" && setup.phase !== "removing") {
    console.log("\n" + chalk.bold("DNS records (all required)"));
    console.log(table(setup.records.map((record) => ({ ...record, status: record.status })), ["type", "host", "value", "status"]));
    if (setup.moreRecordsComing) console.log(chalk.gray("More certificate records appear within a minute."));
  }
  if (setup.issues.length) {
    console.log("\n" + chalk.bold("Issues"));
    for (const issue of setup.issues) {
      console.log(chalk.yellow("! ") + issue.message);
      if (issue.fix) console.log(chalk.gray("  " + issue.fix));
    }
  }
  if (setup.nextSteps.length) {
    console.log("\n" + chalk.bold("Next"));
    setup.nextSteps.forEach((step, index) => console.log(`${index + 1}. ${step}`));
  }
  if (options.debug) {
    console.log("\n" + chalk.bold("Debug"));
    const rows = Object.entries({ id: domain.id, status: domain.status, nextCheckAt: domain.nextCheckAt, ...domain.debug })
      .map(([key, value]) => ({ key, value: value === null || value === undefined ? "" : String(value) }));
    console.log(table(rows, ["key", "value"]));
    if (domain.diagnosis) {
      console.log(table(
        [
          { step: "records", ...domain.diagnosis.steps.records },
          { step: "certificate", ...domain.diagnosis.steps.certificate },
        ],
        ["step", "state", "since"],
      ));
      for (const record of domain.diagnosis.records.filter((item) => item.current?.length))
        console.log(chalk.gray(`${record.type} ${record.name} currently answers ${record.current!.join(", ")}`));
    }
  }
}

function onOff(value: string): boolean {
  if (/^(on|true|yes)$/i.test(value)) return true;
  if (/^(off|false|no)$/i.test(value)) return false;
  throw new Error("Use on or off.");
}

export function domainsCommand(): Command {
  return new Command("domains")
    .description("Connect custom domains to hosted websites and fix their setup")
    .addHelpText(
      "after",
      "\nReading needs a key with hosting.read; add, edit, check and rm need hosting.deploy.\nEvery JSON result includes `setup`: the phase, the DNS records to add, issues with fixes, and next steps.",
    )
    .addCommand(withCommonOptions(new Command("ls"))
      .description("List the project's domains and their state")
      .addHelpText("after", "\nExample: atmyapp domains ls --json")
      .action((opts: CommonOptions) => runAction(opts, () => listDomains(connect(opts).api), (result) =>
        console.log(table(result.domains.map((domain) => ({
          ...domain,
          website: domain.deploymentName ?? "",
          issues: domain.removalPending ? "removing" : domain.issues.join(", "),
          checked: ago(domain.lastCheckedAt),
        })), ["hostname", "status", "website", "issues", "checked"])))))
    .addCommand(withCommonOptions(new Command("show"))
      .description("Show a domain's setup: DNS records, certificate, website, issues and next steps")
      .argument("<domain>", "Hostname (www.example.com) or domain ID")
      .option("--debug", "Also show the raw check state, for troubleshooting")
      .option("--records-text", "Print only the DNS records as plain text, to paste into an email or a DNS form")
      .addHelpText("after", "\nExample: atmyapp domains show www.example.com --debug")
      .action((ref: string, opts: CommonOptions & { debug?: boolean; recordsText?: boolean }) => runAction(opts,
        () => showDomain(connect(opts).api, ref),
        (result) => opts.recordsText
          ? console.log(recordsAsText(result.domain.hostname, result.setup.records))
          : printDomain(result, { debug: opts.debug }))))
    .addCommand(withCommonOptions(new Command("add"))
      .description("Connect a domain to a website and get the DNS records to add")
      .argument("<hostname>", "A subdomain you own, such as www.example.com")
      .option("--deployment <name-or-id>", "Website to show (default: the project's only website)")
      .option("--dry-run", "Check the hostname and website without adding anything")
      .addHelpText(
        "after",
        "\nSafe to run twice: an already connected domain is reported with unchanged: true.\nAdd every record from the result at your DNS provider, then run 'atmyapp domains check <hostname> --wait'.\nBare domains (example.com) can't be hosted; add www.example.com and redirect the bare domain to it.\n\nExample: atmyapp domains add www.example.com --json",
      )
      .action((hostname: string, opts: WriteOptions & { deployment?: string }) => runAction(opts,
        () => addDomain(connect(opts).api, hostname, { deployment: opts.deployment, dryRun: opts.dryRun }),
        (result) => {
          if (result.dryRun) {
            console.log(result.unchanged
              ? `${result.hostname} is already connected; nothing to add.`
              : `Would add ${result.hostname}${result.deployment ? ` showing ${result.deployment.name}` : " without a website"}.`);
            return;
          }
          console.log(result.unchanged
            ? chalk.gray(`${result.domain.hostname} is already connected; nothing changed.`) + "\n"
            : chalk.green(`Added ${result.domain.hostname}.`) + "\n");
          printDomain(result);
        })))
    .addCommand(withCommonOptions(new Command("edit"))
      .description("Change which website a domain shows and how it serves it")
      .argument("<domain>", "Hostname or domain ID")
      .option("--deployment <name-or-id>", "Show this website")
      .option("--unassign", "Show no website (the domain stays connected)")
      .option("--enable", "Turn serving back on")
      .option("--disable", "Stop serving the website on this domain (the domain stays connected)")
      .option("--pin <releaseId>", "Always serve this release instead of the live one")
      .option("--unpin", "Serve the live release again")
      .addOption(new Option("--spa-fallback <on|off>", "Serve index.html for unknown paths (single-page apps)").argParser(onOff))
      .option("--not-found-page <path>", "Page for missing paths, such as /404.html")
      .option("--dry-run", "Show the change without applying it")
      .addHelpText("after", "\nExample: atmyapp domains edit www.example.com --deployment production")
      .action((ref: string, opts: WriteOptions & {
        deployment?: string; unassign?: boolean; enable?: boolean; disable?: boolean;
        pin?: string; unpin?: boolean; spaFallback?: boolean; notFoundPage?: string;
      }) => runAction(opts,
        () => editDomain(connect(opts).api, ref, {
          deployment: opts.deployment, unassign: opts.unassign, enable: opts.enable, disable: opts.disable,
          pin: opts.pin, unpin: opts.unpin, spaFallback: opts.spaFallback, notFoundPage: opts.notFoundPage,
        }, opts.dryRun),
        (result) => {
          if (result.dryRun) {
            console.log(`Would change ${result.hostname}: ${JSON.stringify(result.changes)}`);
            return;
          }
          console.log(chalk.green(`Updated ${result.domain.hostname}.`) + "\n");
          printDomain(result);
        })))
    .addCommand(withCommonOptions(new Command("check"))
      .description("Check DNS now and ask for the HTTPS certificate again")
      .argument("<domain>", "Hostname or domain ID")
      .option("--wait", "Follow the setup until it is live or needs you")
      .option("--timeout <duration>", "Longest wait with --wait: 5s to 1h (default 20m)")
      .addHelpText("after", "\nWith --wait, exits 0 when the domain is live, 6 (needs_person) when it needs a DNS change, and 8 when the certificate is still being issued at the timeout.\n\nExample: atmyapp domains check www.example.com --wait")
      .action((ref: string, opts: CommonOptions & { wait?: boolean; timeout?: string }) => runAction(opts,
        ({ json }) => checkDomain(connect(opts).api, ref, {
          wait: opts.wait,
          timeoutMs: waitTimeout("domain", opts.timeout),
          onProgress: json || !opts.wait ? undefined : (setup) => console.error(chalk.gray(`… ${setup.summary}`)),
        }),
        (result) => printDomain(result))))
    .addCommand(withCommonOptions(new Command("rm"))
      .description("Disconnect a domain and delete its certificate")
      .argument("<domain>", "Hostname or domain ID")
      .option("--yes", "Don't ask for confirmation")
      .option("--if-exists", "Succeed without changes when the domain isn't connected")
      .option("--dry-run", "Show which domain would be removed")
      .addHelpText("after", "\nVisitors to the domain stop reaching the website right away. Remove the DNS records afterwards.\n\nExample: atmyapp domains rm www.example.com --yes")
      .action((ref: string, opts: WriteOptions & { ifExists?: boolean }) => runAction(opts,
        async () => {
          await confirm(opts as Parameters<typeof confirm>[0], `Disconnect ${ref}? Visitors stop reaching the website on it.`);
          return removeDomain(connect(opts).api, ref, opts.dryRun, { ifExists: opts.ifExists });
        },
        (result) => console.log(!result.id
          ? `${result.hostname} isn't connected; nothing to remove.`
          : result.dryRun
            ? `Would remove ${result.hostname}.`
            : `Removing ${result.hostname}. It's disconnected within a minute; you can then delete its DNS records.`))));
}
