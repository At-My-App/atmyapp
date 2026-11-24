import chalk from "chalk";
import { Command, Option } from "commander";
import {
  ANALYTICS_RANGES,
  analyticsBreakdown,
  analyticsEvents,
  analyticsOverview,
  analyticsPages,
  analyticsReports,
  analyticsSearch,
  analyticsSettings,
  createLink,
  duplicateLink,
  editLink,
  LINK_PRESETS,
  listLinks,
  PAGE_KINDS,
  removeLink,
  showLink,
  TRAFFIC_DIMENSIONS,
  type AnalyticsResult,
  type RangeOptions,
} from "../../runtime/analytics";
import { connect, printValue, runAction, table, withCommonOptions, type CommonOptions } from "../output";
import { confirm } from "./draftOptions";

type Options = CommonOptions & RangeOptions;

function withRange(command: Command, options: { bots?: boolean } = {}): Command {
  command
    .option("--website <name>", "Which website (default: the only one)")
    .option("--range <range>", `${ANALYTICS_RANGES.join(", ")} (default 7d; custom takes --from and --to)`)
    .option("--from <day>", "First day, such as 2026-11-01")
    .option("--to <day>", "Last day");
  if (options.bots !== false) command.option("--bots", "Include bots and crawlers");
  return command;
}

const UNSUPPORTED =
  "\nFilters combine only as the dashboard offers them: one range per read, and no filtering one breakdown by another.";

/** Rows the read models return are plain objects; print them as a table when they look like one. */
function render(result: AnalyticsResult) {
  console.log(chalk.gray(`${result.website.name} · ${Object.entries(result.query).map(([key, value]) => `${key}=${value}`).join(" ")}`));
  const data = result.data as Record<string, unknown> | null;
  const rows = data && Array.isArray(data.rows) ? data.rows as Array<Record<string, unknown>>
    : data && Array.isArray(data.pages) ? data.pages as Array<Record<string, unknown>>
      : data && Array.isArray(data.reports) ? data.reports as Array<Record<string, unknown>> : null;
  if (rows && rows.length && typeof rows[0] === "object") {
    const columns = Object.keys(rows[0]).filter((key) => typeof rows[0][key] !== "object").slice(0, 6);
    console.log(table(rows, columns));
    return;
  }
  printValue(data);
}

function onOff(value: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error("Use on or off.");
}

export function analyticsCommand(): Command {
  const command = new Command("analytics").description("Website traffic, Google search phrases and custom events");

  command.addCommand(withRange(withCommonOptions(new Command("overview")))
    .description("Visitors, page views and trends")
    .addHelpText("after", `${UNSUPPORTED}\n\nExample: atmyapp analytics overview --range 30d --json`)
    .action((opts: Options) => runAction(opts, () => analyticsOverview(connect(opts).api, opts), render)));

  command.addCommand(withRange(withCommonOptions(new Command("pages")))
    .description("Most viewed pages, or missing pages people tried to open")
    .option("--kind <kind>", `${PAGE_KINDS.join(" or ")} (not_found: pages that don't exist)`, "view")
    .option("--limit <count>", "Rows per page, 1 to 100", "50")
    .option("--offset <count>", "Skip this many rows (next page: --offset 50)", "0")
    .addHelpText("after", `${UNSUPPORTED}\n\nExample: atmyapp analytics pages --kind not_found --json`)
    .action((opts: Options & { kind?: string; limit?: string; offset?: string }) => runAction(opts,
      () => analyticsPages(connect(opts).api, opts), render)));

  command.addCommand(withRange(withCommonOptions(new Command("breakdown")))
    .description("Traffic by one dimension, such as where visitors came from")
    .argument("<dimension>", TRAFFIC_DIMENSIONS.join(", "))
    .option("--detail <value>", "One value in depth (for example a referrer)")
    .option("--limit <count>", "Rows, 1 to 50", "10")
    .addHelpText("after", `${UNSUPPORTED}\n\nExample: atmyapp analytics breakdown referrer --range 30d --json`)
    .action((dimension: string, opts: Options & { detail?: string; limit?: string }) => runAction(opts,
      () => analyticsBreakdown(connect(opts).api, dimension, opts), render)));

  command.addCommand(withCommonOptions(new Command("reports"))
    .description("Weekly reports; with a week, that week's report")
    .argument("[week]", "The Monday the week starts, such as 2026-11-16")
    .option("--website <name>", "Which website (default: the only one)")
    .option("--limit <count>", "How many weeks, 1 to 104", "12")
    .addHelpText("after", "\nExample: atmyapp analytics reports --json")
    .action((week: string | undefined, opts: CommonOptions & { website?: string; limit?: string }) => runAction(opts,
      () => analyticsReports(connect(opts).api, week, opts), render)));

  command.addCommand(withRange(withCommonOptions(new Command("search")), { bots: false })
    .description("Phrases people searched on Google before visiting (\"Found on Google\")")
    .option("--query <phrase>", "One phrase: the pages it led to")
    .option("--page <path>", "One page: the phrases that led to it")
    .addHelpText("after", "\nNeeds \"Found on Google\" turned on ('atmyapp analytics settings --search on').\n\nExample: atmyapp analytics search --page /menu --json")
    .action((opts: Options & { query?: string; page?: string }) => runAction(opts,
      () => analyticsSearch(connect(opts).api, opts), render)));

  command.addCommand(withCommonOptions(new Command("events"))
    .description("A custom or system event over time")
    .argument("<type>", "Event type, as tracked by the website")
    .option("--totals", "One total instead of a time series")
    .option("--last <duration>", "How far back: 1h to 90d (default 24h)")
    .option("--interval <duration>", "Bucket size for the time series, such as 1h (default 10m)")
    .addHelpText("after", "\nExample: atmyapp analytics events signup --last 7d --totals --json")
    .action((type: string, opts: CommonOptions & { totals?: boolean; last?: string; interval?: string }) => runAction(opts,
      () => analyticsEvents(connect(opts).api, type, opts), (result) => printValue(result.data))));

  command.addCommand(withCommonOptions(new Command("settings"))
    .description("Show or change analytics settings: time zone and \"Found on Google\"")
    .option("--website <name>", "Which website (default: the only one)")
    .option("--timezone <zone>", "Time zone for days and reports, such as Europe/Warsaw")
    .addOption(new Option("--search <on|off>", "Turn \"Found on Google\" on or off").argParser(onOff))
    .option("--dry-run", "Show what would change")
    .addHelpText("after", "\nWithout options, shows the current settings. Safe to run twice.\n\nExample: atmyapp analytics settings --timezone Europe/Warsaw --search on")
    .action((opts: CommonOptions & { website?: string; timezone?: string; search?: boolean; dryRun?: boolean }) => runAction(opts,
      () => analyticsSettings(connect(opts).api, opts),
      (result) => {
        console.log(`${result.website.name}: ${result.analytics.level} analytics, time zone ${result.analytics.timezone}`);
        console.log(`Found on Google: ${(result.search as { enabled?: boolean }).enabled ? "on" : "off"}`);
        if (result.changed.length) console.log(chalk.green(`${opts.dryRun ? "Would change" : "Changed"}: ${result.changed.join(", ")}`));
      })));

  return command;
}

type LinkOptions = CommonOptions & { website?: string; code?: string; to?: string; name?: string; preset?: string; domain?: string; dryRun?: boolean };

function linkLine(link: { code: string; label: string; hostname: string; destinationPath: string | null; destinationUrl: string | null }) {
  return `${chalk.bold(link.code)}  ${link.label}  https://${link.hostname}/go/${link.code} → ${link.destinationPath ?? link.destinationUrl}`;
}

export function linksCommand(): Command {
  const command = new Command("links").description("Short links and QR codes that count visits (\"Your links\")");

  command.addCommand(withRange(withCommonOptions(new Command("ls")), { bots: false })
    .description("List links with their visits")
    .addHelpText("after", "\nExample: atmyapp links ls --range 30d --json")
    .action((opts: Options) => runAction(opts, () => listLinks(connect(opts).api, opts), (result) => {
      console.log(table(result.links.map((link) => ({
        code: link.code, name: link.label, preset: link.preset, to: link.destinationPath ?? link.destinationUrl,
        visits: (link as { visits?: number }).visits ?? "", archived: link.archivedAt ? "yes" : "",
      })), ["code", "name", "preset", "to", "visits", "archived"]));
    })));

  command.addCommand(withRange(withCommonOptions(new Command("show")), { bots: false })
    .description("One link and where its visits came from")
    .argument("<code>", "Link code or ID")
    .action((code: string, opts: Options) => runAction(opts, () => showLink(connect(opts).api, code, opts), (result) => {
      console.log(linkLine(result.link));
      printValue(result.detail);
    })));

  command.addCommand(withCommonOptions(new Command("create"))
    .description("Create a link (safe to run twice with the same code)")
    .requiredOption("--name <name>", "What the link is for, such as \"Flyer, autumn\"")
    .requiredOption("--to <destination>", "A page (/menu) or another website (https://…)")
    .requiredOption("--preset <where>", `Where you'll share it: ${LINK_PRESETS.join(", ")}`)
    .option("--code <code>", "The short code in /go/<code> (default: suggested from the name)")
    .option("--domain <hostname>", "Domain to print it with (default: the website's main domain)")
    .option("--website <name>", "Which website (default: the only one)")
    .option("--dry-run", "Show what would be created")
    .addHelpText("after", "\nreviews links go to another website (your review page); maps links go to a page of yours.\nThe code never changes once created: it may be printed.\n\nExample: atmyapp links create --name \"Menu QR\" --to /menu --preset print --code menu")
    .action((opts: LinkOptions) => runAction(opts, () => createLink(connect(opts).api, opts), (result) => {
      if (result.unchanged) console.log(chalk.gray(`${result.link.code} already exists as asked; nothing changed.`));
      else console.log(`${result.dryRun ? "Would create" : chalk.green("Created")} ${linkLine(result.link)}`);
    })));

  command.addCommand(withCommonOptions(new Command("edit"))
    .description("Change a link's name, destination or domain (the code stays)")
    .argument("<code>", "Link code or ID")
    .option("--name <name>", "New name")
    .option("--to <destination>", "New destination: a page or https://…")
    .option("--domain <hostname>", "Domain to print it with")
    .option("--archive", "Hide it from the list (it keeps redirecting)")
    .option("--unarchive", "Show it again")
    .option("--website <name>", "Which website (default: the only one)")
    .option("--dry-run", "Show the change without saving it")
    .action((code: string, opts: LinkOptions & { archive?: boolean; unarchive?: boolean }) => runAction(opts,
      () => editLink(connect(opts).api, code, opts),
      (result) => console.log(result.unchanged ? chalk.gray("Nothing to change.") : `${result.dryRun ? "Would update" : chalk.green("Updated")} ${linkLine(result.link)}`))));

  command.addCommand(withCommonOptions(new Command("duplicate"))
    .description("Copy a link under a new code, to count another place separately")
    .argument("<code>", "Link code or ID")
    .option("--name <name>", "Name of the copy")
    .option("--website <name>", "Which website (default: the only one)")
    .action((code: string, opts: LinkOptions) => runAction(opts,
      () => duplicateLink(connect(opts).api, code, opts),
      (result) => console.log(`${chalk.green("Created")} ${linkLine(result.link)}`))));

  command.addCommand(withCommonOptions(new Command("rm"))
    .description("Delete a link; its short link and QR code stop working")
    .argument("<code>", "Link code or ID")
    .option("--yes", "Don't ask for confirmation")
    .option("--if-exists", "Succeed without changes when there's no such link")
    .option("--website <name>", "Which website (default: the only one)")
    .option("--dry-run", "Show which link would be deleted")
    .addHelpText("after", "\nPrinted QR codes stop working. Consider 'atmyapp links edit <code> --archive' instead.")
    .action((code: string, opts: LinkOptions & { yes?: boolean; ifExists?: boolean }) => runAction(opts, async () => {
      await confirm(opts as Parameters<typeof confirm>[0], `Delete link ${code}? Its short link and printed QR codes stop working.`);
      return removeLink(connect(opts).api, code, opts);
    }, (result) => console.log(result.removed ? `Deleted ${result.code}.` : result.dryRun ? `Would delete ${result.code}.` : `${result.code} doesn't exist; nothing to delete.`))));

  return command;
}
