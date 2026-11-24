import { z } from "zod";
import type { ApiClient, QueryValue } from "./api";
import { parseDuration } from "./duration";
import { diffFields, ensure } from "./ensure";
import { CliError, EXIT } from "./errors";

/**
 * Website analytics, "Found on Google" and "Your links" from the CLI
 * (CliEverywherePlan §5.3). The options mirror the handler inputs in
 * ama-core `deployments/analytics/handlers.ts` (E12: no new backend filters).
 */

export const ANALYTICS_RANGES = ["today", "7d", "30d", "90d", "12m", "custom"] as const;
export const TRAFFIC_DIMENSIONS = ["country", "referrer", "device", "domain", "region", "city", "platform", "crawler", "link"] as const;
export const PAGE_KINDS = ["view", "not_found"] as const;
export const LINK_PRESETS = ["print", "card", "maps", "bio", "post", "email", "reviews", "other"] as const;

const timeout = () => AbortSignal.timeout(30_000);

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

function oneOf<T extends string>(value: string, options: readonly T[], flag: string): T {
  if (!(options as readonly string[]).includes(value)) {
    throw new CliError("invalid_option", `${flag} takes ${options.join(", ")}.`, { exitCode: EXIT.usage });
  }
  return value as T;
}

function bounded(value: string | number | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new CliError("invalid_option", `${flag} takes ${min} to ${max}.`, { exitCode: EXIT.usage });
  }
  return number;
}

// --- Websites ------------------------------------------------------------------

const websiteSchema = z.looseObject({ id: z.string(), name: z.string() });
export type Website = z.infer<typeof websiteSchema>;

export async function listWebsites(api: ApiClient): Promise<Website[]> {
  const raw = await api.json("GET", "deployments", { signal: timeout() });
  return read(z.object({ deployments: z.array(websiteSchema) }), raw, "website list").deployments;
}

/** `--website <name|id>`; the only website when omitted. */
export async function resolveWebsite(api: ApiClient, ref: string | undefined): Promise<Website> {
  const websites = await listWebsites(api);
  const choices = websites.map(({ id, name }) => ({ id, name }));
  if (ref) {
    const wanted = ref.trim().toLowerCase();
    const found = websites.find((site) => site.id === ref.trim()) ?? websites.filter((site) => site.name.toLowerCase() === wanted);
    if (!Array.isArray(found)) return found;
    if (found.length === 1) return found[0];
    throw new CliError(found.length ? "website_ambiguous" : "website_not_found",
      found.length ? `Several websites are called '${ref}'.` : `No website '${ref}' in this project.`, {
        exitCode: EXIT.usage, details: { websites: choices }, fix: "Pass --website with an ID from details.",
      });
  }
  if (websites.length === 1) return websites[0];
  if (!websites.length) {
    throw new CliError("website_required", "This project has no website yet.", { fix: "Set one up first (dashboard: Hosting)." });
  }
  throw new CliError("website_required", "This project has several websites. Choose one with --website.", {
    exitCode: EXIT.usage, details: { websites: choices },
  });
}

function websiteRoute(website: Website, rest: string) {
  return `deployments/${encodeURIComponent(website.id)}/analytics/${rest}`;
}

// --- Analytics -------------------------------------------------------------------

export interface RangeOptions {
  website?: string;
  range?: string;
  from?: string;
  to?: string;
  bots?: boolean;
}

function day(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CliError("invalid_option", `${flag} takes a day such as 2026-11-01.`, { exitCode: EXIT.usage });
  }
  return value;
}

function rangeQuery(options: RangeOptions): Record<string, QueryValue> {
  const from = day(options.from, "--from");
  const to = day(options.to, "--to");
  const range = oneOf(options.range ?? (from || to ? "custom" : "7d"), ANALYTICS_RANGES, "--range");
  if (range === "custom" && (!from || !to)) {
    throw new CliError("invalid_option", "A custom range takes both --from and --to.", { exitCode: EXIT.usage });
  }
  return { range, from, to, bots: options.bots ? "1" : undefined };
}

/** One analytics read, with the website it is for. */
export const analyticsResultSchema = z.object({
  website: z.object({ id: z.string(), name: z.string() }),
  query: z.record(z.string(), z.unknown()),
  data: z.unknown(),
});
export type AnalyticsResult = z.infer<typeof analyticsResultSchema>;

async function analyticsRead(api: ApiClient, options: RangeOptions, route: string, extra: Record<string, QueryValue> = {}, withRange = true): Promise<AnalyticsResult> {
  const website = await resolveWebsite(api, options.website);
  const query = { ...(withRange ? rangeQuery(options) : {}), ...extra };
  const data = await api.json("GET", websiteRoute(website, route), { query, signal: timeout() });
  const shown = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined));
  return { website: { id: website.id, name: website.name }, query: shown, data };
}

export const analyticsOverview = (api: ApiClient, options: RangeOptions) => analyticsRead(api, options, "overview");

export function analyticsPages(api: ApiClient, options: RangeOptions & { kind?: string; limit?: string; offset?: string }) {
  return analyticsRead(api, options, "pages", {
    kind: oneOf(options.kind ?? "view", PAGE_KINDS, "--kind"),
    limit: bounded(options.limit, "--limit", 1, 100),
    offset: bounded(options.offset, "--offset", 0, 10_000),
  });
}

export function analyticsBreakdown(api: ApiClient, dimension: string, options: RangeOptions & { detail?: string; limit?: string }) {
  const name = oneOf(dimension, TRAFFIC_DIMENSIONS, "The dimension");
  if (options.detail !== undefined) {
    if (options.detail.length > 300) throw new CliError("invalid_option", "--detail takes up to 300 characters.", { exitCode: EXIT.usage });
    return analyticsRead(api, options, `dimensions/${name}/detail`, { value: options.detail });
  }
  return analyticsRead(api, options, `dimensions/${name}`, { limit: bounded(options.limit, "--limit", 1, 50) });
}

export function analyticsReports(api: ApiClient, week: string | undefined, options: { website?: string; limit?: string }) {
  if (week !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new CliError("invalid_argument", "The week starts on a day such as 2026-11-16.", { exitCode: EXIT.usage });
    return analyticsRead(api, options, `reports/${week}`, {}, false);
  }
  return analyticsRead(api, options, "reports", { limit: bounded(options.limit, "--limit", 1, 104) }, false);
}

export function analyticsSearch(api: ApiClient, options: RangeOptions & { query?: string; page?: string }) {
  if (options.query !== undefined && options.page !== undefined) {
    throw new CliError("invalid_options", "Pass --query or --page, not both.", { exitCode: EXIT.usage });
  }
  const { bots: _bots, ...range } = options;
  if (options.query !== undefined) {
    const q = options.query.trim();
    if (!q || q.length > 500) throw new CliError("invalid_option", "--query takes 1 to 500 characters.", { exitCode: EXIT.usage });
    return analyticsRead(api, range, "search/query", { q, bots: undefined });
  }
  if (options.page !== undefined) {
    if (!options.page.startsWith("/") || options.page.length > 600) {
      throw new CliError("invalid_option", "--page takes a path such as /menu.", { exitCode: EXIT.usage });
    }
    return analyticsRead(api, range, "search/page", { path: options.page, bots: undefined });
  }
  return analyticsRead(api, range, "search/overview", { bots: undefined });
}

export const eventsResultSchema = z.object({ eventType: z.string(), query: z.record(z.string(), z.unknown()), data: z.unknown() });

/** Custom and system events (`analytics/events/<type>`), over the last `--last` (default 24h). */
export async function analyticsEvents(api: ApiClient, eventType: string, options: { totals?: boolean; last?: string; interval?: string }) {
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(eventType)) {
    throw new CliError("invalid_argument", "Invalid event type.", { exitCode: EXIT.usage });
  }
  const lastSeconds = Math.round(parseDuration(options.last ?? "24h", { min: 60_000, max: 90 * 86_400_000 }, "7d") / 1000);
  const query: Record<string, QueryValue> = { lastSeconds };
  if (!options.totals && options.interval) {
    query.intervalSeconds = Math.round(parseDuration(options.interval, { min: 60_000, max: 7 * 86_400_000 }, "1h") / 1000);
  }
  const data = await api.json("GET", `analytics/events/${encodeURIComponent(eventType)}/${options.totals ? "totals" : "timeseries"}`, { query, signal: timeout() });
  return { eventType, query, data };
}

export const analyticsSettingsSchema = z.object({
  website: z.object({ id: z.string(), name: z.string() }),
  analytics: z.looseObject({ level: z.string(), timezone: z.string() }),
  search: z.looseObject({ canManage: z.boolean().optional() }),
  changed: z.array(z.string()),
});

/** Analytics time zone and "Found on Google" on or off; with no changes, the current settings. */
export async function analyticsSettings(
  api: ApiClient,
  options: { website?: string; timezone?: string; search?: boolean; dryRun?: boolean },
): Promise<z.infer<typeof analyticsSettingsSchema>> {
  const website = await resolveWebsite(api, options.website);
  const [analytics, search] = await Promise.all([
    api.json("GET", websiteRoute(website, "settings"), { signal: timeout() }),
    api.json("GET", websiteRoute(website, "search/settings"), { signal: timeout() }),
  ]);
  let current = read(analyticsSettingsSchema.shape.analytics, analytics, "analytics settings");
  let searchSettings = read(analyticsSettingsSchema.shape.search, search, "search settings");
  const changed: string[] = [];
  if (options.timezone !== undefined && options.timezone !== current.timezone) {
    changed.push("timezone");
    if (!options.dryRun) {
      current = read(analyticsSettingsSchema.shape.analytics, await api.json("PUT", websiteRoute(website, "settings"), {
        body: { timezone: options.timezone }, signal: timeout(),
      }), "analytics settings");
    }
  }
  const searchOn = (searchSettings as { enabled?: unknown }).enabled;
  if (options.search !== undefined && options.search !== searchOn) {
    changed.push("search");
    if (!options.dryRun) {
      searchSettings = read(analyticsSettingsSchema.shape.search, await api.json("PUT", websiteRoute(website, "search/settings"), {
        body: { enabled: options.search }, signal: timeout(),
      }), "search settings");
    }
  }
  return { website: { id: website.id, name: website.name }, analytics: current, search: searchSettings, changed };
}

// --- Your links -----------------------------------------------------------------

const linkSchema = z.looseObject({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  preset: z.string(),
  destinationPath: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  hostname: z.string(),
  archivedAt: z.string().nullable().optional(),
});
export type WebsiteLink = z.infer<typeof linkSchema>;

export const linkListSchema = z.object({
  website: z.object({ id: z.string(), name: z.string() }),
  links: z.array(linkSchema),
  hostnames: z.array(z.unknown()),
  limit: z.number().optional(),
});
export const linkResultSchema = z.object({
  website: z.object({ id: z.string(), name: z.string() }),
  link: linkSchema,
  unchanged: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

async function links(api: ApiClient, website: Website, options: RangeOptions = {}) {
  const raw = await api.json("GET", websiteRoute(website, "links"), { query: rangeQuery(options), signal: timeout() });
  return read(z.looseObject({ links: z.array(linkSchema), hostnames: z.array(z.unknown()), limit: z.number().optional() }), raw, "link list");
}

export async function listLinks(api: ApiClient, options: RangeOptions) {
  const website = await resolveWebsite(api, options.website);
  const result = await links(api, website, options);
  return { website: { id: website.id, name: website.name }, links: result.links, hostnames: result.hostnames, limit: result.limit };
}

async function findLink(api: ApiClient, website: Website, ref: string): Promise<WebsiteLink | null> {
  const { links: all } = await links(api, website);
  const wanted = ref.trim().toLowerCase();
  return all.find((link) => link.id === ref.trim() || link.code === wanted) ?? null;
}

async function requireLink(api: ApiClient, website: Website, ref: string): Promise<WebsiteLink> {
  const link = await findLink(api, website, ref);
  if (link) return link;
  const { links: all } = await links(api, website);
  throw new CliError("link_not_found", `No link '${ref}' on ${website.name}.`, {
    details: { links: all.slice(0, 20).map(({ code, label }) => ({ code, label })) },
    fix: "Run 'atmyapp links ls' to see the links.",
  });
}

export async function showLink(api: ApiClient, ref: string, options: RangeOptions) {
  const website = await resolveWebsite(api, options.website);
  const link = await requireLink(api, website, ref);
  const detail = await api.json("GET", websiteRoute(website, `links/${encodeURIComponent(link.id)}`), { query: rangeQuery(options), signal: timeout() });
  return { website: { id: website.id, name: website.name }, link, detail };
}

/** `--to /menu` (a page of the website) or `--to https://…` (another website). */
function destination(to: string | undefined): { destinationPath?: string | null; destinationUrl?: string | null } {
  if (to === undefined) return {};
  const value = to.trim();
  if (value.startsWith("/")) return { destinationPath: value, destinationUrl: null };
  if (/^https?:\/\//i.test(value)) return { destinationPath: null, destinationUrl: value };
  throw new CliError("invalid_option", "--to takes a page path such as /menu, or a full https:// address.", { exitCode: EXIT.usage });
}

export interface LinkInput {
  website?: string;
  code?: string;
  to?: string;
  name?: string;
  preset?: string;
  domain?: string;
  dryRun?: boolean;
}

/**
 * Creates a link; safe to run twice by code (§4.3.4). Without `--code` the
 * server suggests one from the name.
 */
export async function createLink(api: ApiClient, input: LinkInput): Promise<z.infer<typeof linkResultSchema>> {
  const name = input.name?.trim();
  if (!name) throw new CliError("invalid_option", "Give the link a --name (what people see in the list).", { exitCode: EXIT.usage });
  if (!input.to) throw new CliError("invalid_option", "Say where the link goes with --to /page or --to https://….", { exitCode: EXIT.usage });
  const preset = oneOf(input.preset ?? "", LINK_PRESETS, "--preset (where you'll share it)");
  const target = destination(input.to);
  const website = await resolveWebsite(api, input.website);
  const code = input.code?.trim().toLowerCase() ||
    read(z.object({ code: z.string() }), await api.json("GET", websiteRoute(website, "links/suggest-code"), {
      query: { label: name }, signal: timeout(),
    }), "code suggestion").code;
  const outcome = await ensure({
    kind: "link",
    key: code,
    find: () => findLink(api, website, code),
    differences: (existing) => diffFields(existing, {
      label: name, preset, ...target, ...(input.domain ? { hostname: input.domain.trim().toLowerCase() } : {}),
    }),
    create: async () => {
      if (input.dryRun) return null;
      return api.json("POST", websiteRoute(website, "links"), {
        body: { label: name, preset, code, hostname: input.domain?.trim().toLowerCase() || null, ...target },
        signal: timeout(),
      });
    },
    editCommand: `atmyapp links edit ${code}`,
  });
  const site = { id: website.id, name: website.name };
  if (outcome.unchanged) return { website: site, link: outcome.existing, unchanged: true };
  if (input.dryRun) {
    return {
      website: site, dryRun: true, unchanged: false,
      link: { id: "", code, label: name, preset, destinationPath: target.destinationPath ?? null, destinationUrl: target.destinationUrl ?? null, hostname: input.domain ?? "" },
    };
  }
  return { website: site, link: read(linkSchema, outcome.created, "link"), unchanged: false };
}

export async function editLink(api: ApiClient, ref: string, input: LinkInput & { archive?: boolean; unarchive?: boolean }) {
  const website = await resolveWebsite(api, input.website);
  const link = await requireLink(api, website, ref);
  const body: Record<string, unknown> = {
    ...(input.name !== undefined ? { label: input.name.trim() } : {}),
    ...destination(input.to),
    ...(input.domain !== undefined ? { hostname: input.domain.trim().toLowerCase() } : {}),
    ...(input.archive ? { archived: true } : input.unarchive ? { archived: false } : {}),
  };
  const current = { ...link, archived: Boolean(link.archivedAt) };
  const changes = diffFields(current, body);
  const site = { id: website.id, name: website.name };
  if (!Object.keys(changes).length || input.dryRun) return { website: site, link, unchanged: !Object.keys(changes).length, dryRun: input.dryRun };
  const updated = await api.json("PUT", websiteRoute(website, `links/${encodeURIComponent(link.id)}`), { body, signal: timeout() });
  return { website: site, link: read(linkSchema, updated, "link"), unchanged: false };
}

export async function duplicateLink(api: ApiClient, ref: string, options: { website?: string; name?: string }) {
  const website = await resolveWebsite(api, options.website);
  const link = await requireLink(api, website, ref);
  const copy = await api.json("POST", websiteRoute(website, `links/${encodeURIComponent(link.id)}/duplicate`), {
    body: { label: options.name?.trim() || undefined }, signal: timeout(),
  });
  return { website: { id: website.id, name: website.name }, link: read(linkSchema, copy, "link") };
}

export const linkRemoveSchema = z.object({ code: z.string(), removed: z.boolean(), dryRun: z.boolean() });

export async function removeLink(api: ApiClient, ref: string, options: { website?: string; ifExists?: boolean; dryRun?: boolean }) {
  const website = await resolveWebsite(api, options.website);
  const link = await findLink(api, website, ref);
  if (!link) {
    if (options.ifExists) return { code: ref, removed: false, dryRun: Boolean(options.dryRun) };
    await requireLink(api, website, ref);
  }
  if (options.dryRun) return { code: link!.code, removed: false, dryRun: true };
  await api.json("DELETE", websiteRoute(website, `links/${encodeURIComponent(link!.id)}`), { signal: timeout() });
  return { code: link!.code, removed: true, dryRun: false };
}
