import * as fs from "node:fs";
import { z } from "zod";
import type { ApiClient } from "./api";
import { isPersonalCredential } from "./auth";
import { canonicalJson } from "./canonicalJson";
import { githubAccess, listCodeSources, type Repository } from "./code";
import { listDomains } from "./domains";
import { CliError, EXIT } from "./errors";
import { operation } from "./operations";
import { imagePolicy, listForms, localization, waitForCleanup } from "./settings";
import { knownSettings, listPresets, listPreviewServers, listWebsites, secretNames } from "./setup";

/**
 * Desired state for a project (CliEverywherePlan §5.6): `atmyapp.project.json`
 * lists what the project should have; `export` writes it from the project,
 * `plan` shows the differences, `apply` makes them. Nothing is deleted
 * without `--prune`, and a section the file leaves out isn't managed at all.
 * Secret values never live in the file: each listed secret's value comes from
 * the environment variable of the same name.
 */

export const PROJECT_FILE = "atmyapp.project.json";
export const PROJECT_SCHEMA_URL = "https://docs.atmyapp.com/schemas/project.json";

// --- File format ------------------------------------------------------------------------
// Names are made canonical once, here, so creates, dependencies and prune all
// use the same identity (§12.1 P1-6).

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const envMap = z.record(z.string().regex(ENV_NAME), z.string());
/** Secret names are stored upper case: `stripe_key` is STRIPE_KEY. */
const secretName = z.string().trim().regex(ENV_NAME, "Use letters, digits and underscores, starting with a letter").toUpperCase();
const secretList = z.array(secretName);
const repo = z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, "Write it as owner/repo");
const label = z.string().trim().min(1);
/** The preview create route's rule: 1024–65535, and 3000 is reserved. */
const previewPort = z.number().int().min(1024).max(65535).refine((port) => port !== 3000, "Port 3000 is reserved");

const rawProjectFileSchema = z.object({
  $schema: z.string().optional(),
  /** Secrets the project has; values come from the environment at `apply`. A section left out isn't managed. */
  secrets: secretList.optional(),
  presets: z.array(z.object({
    name: label,
    repo,
    branch: z.string().trim().min(1).optional(),
    framework: z.string().optional(),
    install: z.string().optional(),
    build: z.string().min(1),
    root: z.string().optional(),
    output: z.string().optional(),
    env: envMap.default({}),
    secrets: secretList.default([]),
  }).strict()).optional(),
  websites: z.array(z.object({
    name: label,
    preset: label,
    autoPromote: z.boolean().optional(),
    autoRebuild: z.boolean().optional(),
  }).strict()).optional(),
  domains: z.array(z.object({
    hostname: z.string().trim().toLowerCase().min(3).regex(/^[a-z0-9.-]+$/, "A hostname, without https:// or a path"),
    website: label.nullable(),
  }).strict()).optional(),
  locales: z.object({ default: z.string().trim(), supported: z.array(z.string().trim()).min(1) }).strict().optional(),
  imagePolicy: z.record(z.string(), z.unknown()).optional(),
  forms: z.array(z.object({ name: z.string().trim().min(1), accepting: z.boolean().optional() }).strict()).optional(),
  previewServers: z.array(z.object({
    name: label,
    repo,
    /** Default: the repository's default branch. */
    branch: z.string().trim().min(1).optional(),
    command: z.string().min(1),
    port: previewPort,
    env: envMap.default({}),
    secrets: secretList.default([]),
  }).strict()).optional(),
}).strict();

/** Two entries for the same thing would leave one of them unmanaged, or both fighting. */
export const projectFileSchema = rawProjectFileSchema.superRefine((file, context) => {
  const unique = (section: string, keys: string[]) => {
    const seen = new Map<string, number>();
    keys.forEach((key, index) => {
      if (seen.has(key)) context.addIssue({ code: "custom", path: [section, index], message: `Listed twice (also at ${section}.${seen.get(key)})` });
      else seen.set(key, index);
    });
  };
  unique("secrets", file.secrets ?? []);
  unique("presets", (file.presets ?? []).map((item) => item.name.toLowerCase()));
  unique("websites", (file.websites ?? []).map((item) => item.name.toLowerCase()));
  unique("domains", (file.domains ?? []).map((item) => item.hostname));
  unique("forms", (file.forms ?? []).map((item) => item.name));
  unique("previewServers", (file.previewServers ?? []).map((item) => item.name.toLowerCase()));
  if (file.locales) {
    unique("locales", file.locales.supported.map((code) => code.toLowerCase()));
    if (!file.locales.supported.some((code) => code.toLowerCase() === file.locales!.default.toLowerCase())) {
      context.addIssue({ code: "custom", path: ["locales", "default"], message: "The default language must be one of the supported ones" });
    }
  }
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

/** The JSON Schema editors use for completion (published at PROJECT_SCHEMA_URL). */
export function projectJsonSchema(): unknown {
  return z.toJSONSchema(rawProjectFileSchema, { io: "input" });
}

export function readProjectFile(file = PROJECT_FILE): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError("project_file_unreadable", `Couldn't read ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      exitCode: EXIT.usage, fix: "Create it with 'atmyapp export'.",
    });
  }
  return parseProjectFile(raw, file);
}

export function parseProjectFile(raw: unknown, file = PROJECT_FILE): ProjectFile {
  const parsed = projectFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError("project_file_invalid", `${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`, {
      exitCode: EXIT.validation, details: { issues: parsed.error.issues.slice(0, 20) },
    });
  }
  return parsed.data;
}

// --- Current state --------------------------------------------------------------------

type Section = "sources" | "secrets" | "presets" | "websites" | "domains" | "locales" | "imagePolicy" | "forms" | "servers";
const ALL_SECTIONS: Section[] = ["sources", "secrets", "presets", "websites", "domains", "locales", "imagePolicy", "forms", "servers"];

interface Current {
  sources: Array<{ id: string; fullName: string; branch: string | null }>;
  secrets: Array<{ id: string; name: string }>;
  presets: Awaited<ReturnType<typeof listPresets>>["presets"];
  websites: Awaited<ReturnType<typeof listWebsites>>["websites"];
  domains: Awaited<ReturnType<typeof listDomains>>["domains"];
  locales: { default: string; supported: string[] } | null;
  /** The full localization settings, sent back whole when the default changes. */
  localization: Record<string, unknown> | null;
  /** Cleanup jobs, to finish a language removal that failed earlier (§12.2 P2-5). */
  cleanupJobs: Array<{ id: string; locale: string | null; status: string }>;
  imagePolicy: Record<string, unknown> | null;
  forms: Array<{ type: string; acceptingResponses: boolean }>;
  servers: Awaited<ReturnType<typeof listPreviewServers>>;
}

/** What each managed part of the file needs to read (§12.2 P2-2): a forms-only file reads only forms. */
function sectionsFor(file: ProjectFile): Set<Section> {
  const needs = new Set<Section>();
  const add = (...sections: Section[]) => sections.forEach((section) => needs.add(section));
  // Secrets are pruned only when no preset or preview server uses them.
  if (file.secrets) add("secrets", "presets", "servers");
  if (file.presets) add("sources", "secrets", "presets");
  if (file.websites) add("presets", "websites");
  if (file.domains) add("websites", "domains");
  if (file.previewServers) add("sources", "secrets", "servers");
  if (file.locales) add("locales");
  if (file.imagePolicy) add("imagePolicy");
  if (file.forms) add("forms");
  return needs;
}

const loaders: Record<Section, (api: ApiClient) => Promise<Partial<Current>>> = {
  sources: async (api) => ({
    sources: (await listCodeSources(api)).codeSources.map((source) => ({ id: source.id, fullName: `${source.owner}/${source.repo}`, branch: source.branch })),
  }),
  secrets: async (api) => ({ secrets: await secretNames(api) }),
  presets: async (api) => ({ presets: (await listPresets(api)).presets }),
  websites: async (api) => ({ websites: (await listWebsites(api)).websites }),
  domains: async (api) => ({ domains: (await listDomains(api)).domains }),
  locales: async (api) => {
    const [settings, jobs] = await Promise.all([
      localization(api),
      api.json<unknown>("GET", "localization/cleanup-jobs", { signal: AbortSignal.timeout(30_000) }),
    ]);
    const rows = Array.isArray(jobs) ? (jobs as Array<Record<string, unknown>>) : [];
    return {
      locales: { default: settings.defaultLocale, supported: settings.supportedLocales },
      localization: settings as Record<string, unknown>,
      cleanupJobs: rows.filter((job) => typeof job.id === "string" && typeof job.status === "string")
        .map((job) => ({ id: String(job.id), locale: typeof job.locale === "string" ? job.locale : null, status: String(job.status) })),
    };
  },
  imagePolicy: async (api) => {
    const { imagePolicy: policy } = await imagePolicy(api);
    return { imagePolicy: policy && typeof policy === "object" ? (policy as Record<string, unknown>) : null };
  },
  forms: async (api) => ({ forms: (await listForms(api)).forms }),
  servers: async (api) => ({ servers: await listPreviewServers(api) }),
};

const EMPTY: Current = {
  sources: [], secrets: [], presets: [], websites: [], domains: [], locales: null, localization: null, cleanupJobs: [], imagePolicy: null, forms: [], servers: [],
};

/** Reads the sections; a failed read of a managed section fails the plan, never an empty section. */
async function current(api: ApiClient, sections: Set<Section>): Promise<Current> {
  const parts = await Promise.all([...sections].map((section) => loaders[section](api)));
  return Object.assign({ ...EMPTY }, ...parts);
}

const sortedEnv = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));

export const exportIncompleteSchema = z.array(z.object({ section: z.string(), reason: z.string() }));

/**
 * `atmyapp export`: the project as a project file (secret names, never
 * values). A section that couldn't be read is left out of the file (so
 * `apply` doesn't manage it) and listed in `incomplete` (§12.2 P2-2).
 */
export async function exportProject(api: ApiClient): Promise<{ project: ProjectFile; incomplete: z.infer<typeof exportIncompleteSchema> }> {
  const read = await Promise.all(ALL_SECTIONS.map(async (section) => {
    try {
      return { section, data: await loaders[section](api), error: null };
    } catch (error) {
      return { section, data: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const failed = new Map(read.filter((item) => item.error !== null).map((item) => [item.section, item.error as string]));
  const now: Current = Object.assign({ ...EMPTY }, ...read.map((item) => item.data ?? {}));
  const incomplete: Array<{ section: string; reason: string }> = [];
  /** A file section is complete when everything it's built from was read. */
  const usable = (name: string, ...needs: Section[]) => {
    const missing = needs.filter((section) => failed.has(section));
    if (!missing.length) return true;
    incomplete.push({ section: name, reason: `${missing.join(", ")}: ${failed.get(missing[0])}` });
    return false;
  };
  const hidden = (name: string, items: Array<{ name: string; settingsVisible: boolean }>) => {
    const unreadable = items.filter((item) => !item.settingsVisible).map((item) => item.name);
    if (!unreadable.length) return false;
    incomplete.push({ section: name, reason: `This credential can't read the settings of ${unreadable.join(", ")} (needs hosting.manage).` });
    return true;
  };

  const repoOf = (id: string | null) => now.sources.find((source) => source.id === id)?.fullName ?? "";
  const secretOf = (id: string) => now.secrets.find((secret) => secret.id === id)?.name ?? id;
  const optional = (value: string | null) => value ?? undefined;
  const project: ProjectFile = { $schema: PROJECT_SCHEMA_URL };
  if (usable("secrets", "secrets")) project.secrets = now.secrets.map((secret) => secret.name).sort();
  if (usable("presets", "presets", "sources", "secrets") && !hidden("presets", now.presets)) {
    project.presets = now.presets.map((preset) => ({
      name: preset.name, repo: repoOf(preset.codeSourceId), branch: optional(preset.branch), framework: optional(preset.framework),
      install: optional(preset.installCommand), build: preset.buildCommand ?? "", root: optional(preset.rootDirectory) || undefined,
      output: optional(preset.outputDirectory), env: sortedEnv(preset.envOverrides), secrets: preset.secretIds.map(secretOf).sort(),
    }));
  }
  if (usable("websites", "websites", "presets")) {
    project.websites = now.websites.map((site) => ({
      name: site.name, preset: now.presets.find((preset) => preset.id === site.presetId)?.name ?? site.presetId ?? "",
      autoPromote: site.autoPromote, autoRebuild: site.autoRebuildOnContent,
    }));
  }
  if (usable("domains", "domains")) project.domains = now.domains.map((domain) => ({ hostname: domain.hostname, website: domain.deploymentName ?? null }));
  if (usable("locales", "locales") && now.locales) project.locales = now.locales;
  if (usable("imagePolicy", "imagePolicy") && now.imagePolicy) project.imagePolicy = now.imagePolicy;
  if (usable("forms", "forms")) project.forms = now.forms.map((form) => ({ name: form.type, accepting: form.acceptingResponses }));
  if (usable("previewServers", "servers", "sources", "secrets") && !hidden("previewServers", now.servers)) {
    project.previewServers = now.servers.map((server) => ({
      name: server.name, repo: repoOf(server.codeSourceId), branch: optional(server.branch), command: server.startCommand ?? "",
      port: server.port ?? 4321, env: sortedEnv(server.envOverrides), secrets: server.secretIds.map(secretOf).sort(),
    }));
  }
  return { project, incomplete };
}

// --- Plan -------------------------------------------------------------------------------

/** IDs known only once earlier steps ran (a new preset's ID, a new secret's ID). */
export interface Ids {
  sources: Map<string, string>;
  secrets: Map<string, string>;
  presets: Map<string, string>;
  websites: Map<string, string>;
}

export interface Request {
  method: "POST" | "PUT" | "DELETE";
  /** Relative to the project, like the rest of the CLI: `build-presets/b1`. */
  path: string;
  body?: Record<string, unknown>;
}

export type StepResource = "secret" | "code source" | "preset" | "website" | "domain" | "preview server" | "locale" | "image policy" | "form";

export interface Step {
  id: string;
  action: "create" | "update" | "delete";
  resource: StepResource;
  key: string;
  /** What changes, for people: field → [current, wanted]. */
  changes: Record<string, [unknown, unknown]>;
  /** Known now (approved with the plan), or built once earlier steps created what it needs. */
  request: Request | ((ids: Ids) => Request);
  /** Records what a create made, for later steps. */
  created?: (response: unknown, ids: Ids) => void;
  dependsOn: string[];
  /** A deletion: listed always, run only with --prune. */
  prune: boolean;
  /** Follow the locale cleanup job after the request. */
  waitForCleanup?: boolean;
}

export interface Plan {
  steps: Step[];
  /** Deletions --prune would add. */
  pruned: Step[];
  /** Secrets the file lists whose value isn't in the environment (only a problem when they don't exist yet). */
  missingValues: string[];
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const lower = (value: string) => value.toLowerCase();
const noIds = (): Ids => ({ sources: new Map(), secrets: new Map(), presets: new Map(), websites: new Map() });

function idOf(response: unknown, ...keys: string[]): string | null {
  const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
  for (const key of keys) {
    const nested = record(record(response)[key]);
    if (typeof nested.id === "string") return nested.id;
  }
  return typeof record(response).id === "string" ? (record(response).id as string) : null;
}

/** An ID an earlier step created. Its absence is a bug in the order, never a request without it (§12.2 P2-3). */
function created(map: Map<string, string>, key: string, what: string): string {
  const id = map.get(key);
  if (!id) throw new CliError("missing_dependency", `The ${what} this step needs wasn't created earlier in the run.`);
  return id;
}

const invalid = (message: string, fix?: string) => new CliError("project_file_invalid", message, { exitCode: EXIT.validation, fix });

/**
 * The differences between the file and the project, in dependency order:
 * secrets, code sources, presets, websites, domains, preview servers,
 * languages, image policy, forms; then deletions (with --prune). Every
 * reference is checked before anything is planned, so `apply` never starts
 * writes it can't finish.
 */
export async function planProject(api: ApiClient, input: ProjectFile, options: { prune?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Plan> {
  const env = options.env ?? process.env;
  const now = await current(api, sectionsFor(input));
  // A section the file leaves out isn't managed: nothing in it is created or pruned.
  const file = {
    ...input, secrets: input.secrets ?? [], presets: input.presets ?? [], websites: input.websites ?? [],
    domains: input.domains ?? [], forms: input.forms ?? [], previewServers: input.previewServers ?? [],
  };
  const managed = (section: "secrets" | "websites" | "domains" | "forms") => input[section] !== undefined;
  const steps: Step[] = [];
  const pruned: Step[] = [];
  const missingValues: string[] = [];
  const prune = Boolean(options.prune);

  // Variables are written back whole: unknown ones (no hosting.manage) would be erased (§12.1 P1-4).
  now.presets.forEach((preset) => knownSettings(preset, `build preset ${preset.name}`));
  now.servers.forEach((server) => knownSettings(server, `preview server ${server.name}`));

  const findPreset = (name: string) => now.presets.find((preset) => lower(preset.name) === lower(name));
  const findWebsite = (name: string) => now.websites.find((site) => lower(site.name) === lower(name));
  const findSource = (repo: string) => now.sources.find((source) => lower(source.fullName) === lower(repo));
  const findServer = (name: string) => now.servers.find((server) => lower(server.name) === lower(name));
  const findSecret = (name: string) => now.secrets.find((secret) => secret.name === name);
  const secretNameOf = (id: string) => now.secrets.find((secret) => secret.id === id)?.name ?? id;

  // References first (§12.2 P2-3): nothing is written for a file that can't be applied whole.
  for (const site of file.websites) {
    if (!findPreset(site.preset) && !file.presets.some((preset) => lower(preset.name) === lower(site.preset))) {
      throw invalid(`Website ${site.name} uses the preset ${site.preset}, which neither the file nor the project has.`);
    }
  }
  for (const domain of file.domains) {
    if (domain.website && !findWebsite(domain.website) && !file.websites.some((site) => lower(site.name) === lower(domain.website!))) {
      throw invalid(`Domain ${domain.hostname} points to the website ${domain.website}, which neither the file nor the project has.`);
    }
  }
  for (const server of file.previewServers) {
    const existing = findServer(server.name);
    const source = findSource(server.repo);
    if (existing && (!source || existing.codeSourceId !== source.id)) {
      throw invalid(`Preview server ${server.name} is built from another repository; moving a preview server to ${server.repo} isn't supported.`,
        "Give it a new name in the file, or keep its repository.");
    }
  }

  // Secrets: every name listed, or attached to a target in the file.
  const wantedSecrets = [...new Set([...file.secrets, ...file.presets.flatMap((preset) => preset.secrets), ...file.previewServers.flatMap((server) => server.secrets)])];
  for (const name of wantedSecrets) {
    if (findSecret(name)) continue;
    const value = env[name];
    if (value === undefined || value === "") {
      missingValues.push(name);
      continue;
    }
    const op = operation(api.session, "apply.secret.create", [name]);
    steps.push({
      id: `secret:${name}`, action: "create", resource: "secret", key: name, changes: { value: [null, "(from the environment)"] },
      request: { method: "POST", path: "secrets", body: { name, value, is_secret: true, operationId: op.id } },
      created: (response, ids) => { const id = idOf(response, "secret"); if (id) ids.secrets.set(name, id); op.done(); },
      dependsOn: [], prune: false,
    });
  }
  if (missingValues.length) {
    throw new CliError("secret_values_missing", `Set ${missingValues.join(", ")} in the environment: they don't exist in the project yet.`, {
      exitCode: EXIT.usage, details: { secrets: missingValues }, fix: "Values come from environment variables of the same name.",
    });
  }
  const secretId = (ids: Ids, name: string) => findSecret(name)?.id ?? created(ids.secrets, name, `secret ${name}`);
  const secretSteps = (list: string[]) => list.filter((name) => !findSecret(name)).map((name) => `secret:${name}`);

  // Code sources.
  const repos = [...new Set([...file.presets.map((preset) => lower(preset.repo)), ...file.previewServers.map((server) => lower(server.repo))])];
  const missingRepos = repos.filter((item) => !findSource(item));
  const listed = new Map<string, Repository>();
  if (missingRepos.length) {
    const access = await githubAccess(api);
    for (const item of missingRepos) {
      const repository = access.repositories.find((candidate) => lower(candidate.fullName) === item);
      if (!repository) {
        throw new CliError("repository_unreachable", `The AtMyApp app can't reach ${item}.`, {
          exitCode: EXIT.usage, fix: `Run 'atmyapp code connect github --repo ${item}' first.`,
        });
      }
      listed.set(item, repository);
      steps.push({
        id: `code:${item}`, action: "create", resource: "code source", key: item, changes: {},
        request: { method: "POST", path: "code-sources", body: { provider: "github", owner: repository.owner, repo: repository.name, default_branch: repository.defaultBranch ?? "main", installation_id: repository.installationId } },
        created: (response, ids) => { const id = idOf(response, "codeSource"); if (id) ids.sources.set(item, id); },
        dependsOn: [], prune: false,
      });
    }
  }
  const sourceId = (ids: Ids, name: string) => findSource(name)?.id ?? created(ids.sources, lower(name), `code source ${name}`);
  const sourceSteps = (name: string) => (findSource(name) ? [] : [`code:${lower(name)}`]);
  /** The branch a new preset or preview server builds by default (§12.2 P2-4). */
  const defaultBranch = (name: string) => findSource(name)?.branch ?? listed.get(lower(name))?.defaultBranch ?? "main";
  const fixed = (build: (ids: Ids) => Request, deps: string[]) => (deps.length ? build : build(noIds()));

  // Presets: env and secrets are added without --prune, made exact with it.
  for (const preset of file.presets) {
    const existing = findPreset(preset.name);
    const fields = {
      branch: preset.branch, framework: preset.framework, install_command: preset.install, build_command: preset.build,
      root_directory: preset.root, output_directory: preset.output,
    };
    if (!existing) {
      const deps = [...secretSteps(preset.secrets), ...sourceSteps(preset.repo)];
      steps.push({
        id: `preset:${lower(preset.name)}`, action: "create", resource: "preset", key: preset.name, changes: {},
        request: fixed((ids) => ({
          method: "POST", path: "build-presets",
          body: {
            name: preset.name, code_source_id: sourceId(ids, preset.repo), ...stripUndefined({ ...fields, branch: preset.branch ?? defaultBranch(preset.repo) }),
            env_overrides: preset.env, secret_ids: preset.secrets.map((name) => secretId(ids, name)),
          },
        }), deps),
        created: (response, ids) => { const id = idOf(response, "build_preset"); if (id) ids.presets.set(lower(preset.name), id); },
        dependsOn: deps, prune: false,
      });
      continue;
    }
    const changes: Record<string, [unknown, unknown]> = {};
    const body: Record<string, unknown> = {};
    const deps: string[] = [];
    // Moving a preset to another repository is reconciled, not ignored (§12.2 P2-3).
    const source = findSource(preset.repo);
    const repoChanges = !source || existing.codeSourceId !== source.id;
    if (repoChanges) {
      changes.repo = [now.sources.find((item) => item.id === existing.codeSourceId)?.fullName ?? existing.codeSourceId, preset.repo];
      deps.push(...sourceSteps(preset.repo));
    }
    const currentFields: Record<string, unknown> = {
      branch: existing.branch, framework: existing.framework, install_command: existing.installCommand, build_command: existing.buildCommand,
      root_directory: existing.rootDirectory, output_directory: existing.outputDirectory,
    };
    for (const [field, value] of Object.entries(fields)) {
      if (value !== undefined && !same(currentFields[field], value)) {
        changes[field] = [currentFields[field] ?? null, value];
        body[field] = value;
      }
    }
    const envWanted = prune ? preset.env : { ...existing.envOverrides, ...preset.env };
    if (!same(sortedEnv(existing.envOverrides), sortedEnv(envWanted))) {
      changes.env = [sortedEnv(existing.envOverrides), sortedEnv(envWanted)];
      body.env_overrides = envWanted;
    }
    const currentNames = existing.secretIds.map(secretNameOf).sort();
    const wantedNames = [...new Set(prune ? preset.secrets : [...currentNames, ...preset.secrets])].sort();
    const secretsChange = !same(currentNames, wantedNames);
    if (secretsChange) {
      changes.secrets = [currentNames, wantedNames];
      deps.push(...secretSteps(wantedNames));
    }
    if (!Object.keys(changes).length) continue;
    const keep = (name: string) => existing.secretIds.find((id) => secretNameOf(id) === name);
    steps.push({
      id: `preset:${lower(preset.name)}`, action: "update", resource: "preset", key: preset.name, changes,
      request: fixed((ids) => ({
        method: "PUT", path: `build-presets/${existing.id}`,
        body: {
          ...body,
          ...(repoChanges ? { code_source_id: sourceId(ids, preset.repo) } : {}),
          ...(secretsChange ? { secret_ids: wantedNames.map((name) => keep(name) ?? secretId(ids, name)) } : {}),
        },
      }), deps),
      dependsOn: deps, prune: false,
    });
  }
  const presetId = (ids: Ids, name: string) => findPreset(name)?.id ?? created(ids.presets, lower(name), `preset ${name}`);
  const presetSteps = (name: string) => (findPreset(name) ? [] : [`preset:${lower(name)}`]);

  // Websites.
  for (const site of file.websites) {
    const existing = findWebsite(site.name);
    const automation = stripUndefined({ auto_promote_on_release: site.autoPromote, auto_rebuild_on_storage_change: site.autoRebuild });
    const deps = presetSteps(site.preset);
    if (!existing) {
      steps.push({
        id: `website:${lower(site.name)}`, action: "create", resource: "website", key: site.name, changes: {},
        request: fixed((ids) => ({ method: "POST", path: "deployments", body: { name: site.name, build_preset_id: presetId(ids, site.preset), ...automation } }), deps),
        created: (response, ids) => { const id = idOf(response, "deployment"); if (id) ids.websites.set(lower(site.name), id); },
        dependsOn: deps, prune: false,
      });
      continue;
    }
    const changes: Record<string, [unknown, unknown]> = {};
    const body: Record<string, unknown> = {};
    // A new preset in the file is linked once it exists (§12.2 P2-3).
    const presetChanges = deps.length > 0 || existing.presetId !== findPreset(site.preset)?.id;
    if (presetChanges) changes.preset = [now.presets.find((preset) => preset.id === existing.presetId)?.name ?? existing.presetId, site.preset];
    if (site.autoPromote !== undefined && site.autoPromote !== existing.autoPromote) {
      changes.autoPromote = [existing.autoPromote, site.autoPromote];
      body.auto_promote_on_release = site.autoPromote;
    }
    if (site.autoRebuild !== undefined && site.autoRebuild !== existing.autoRebuildOnContent) {
      changes.autoRebuild = [existing.autoRebuildOnContent, site.autoRebuild];
      body.auto_rebuild_on_storage_change = site.autoRebuild;
    }
    if (!Object.keys(changes).length) continue;
    steps.push({
      id: `website:${lower(site.name)}`, action: "update", resource: "website", key: site.name, changes,
      request: fixed((ids) => ({ method: "PUT", path: `deployments/${existing.id}`, body: { ...body, ...(presetChanges ? { build_preset_id: presetId(ids, site.preset) } : {}) } }), deps),
      dependsOn: deps, prune: false,
    });
  }
  const websiteId = (ids: Ids, name: string) => findWebsite(name)?.id ?? created(ids.websites, lower(name), `website ${name}`);
  const websiteSteps = (name: string | null) => (name && !findWebsite(name) ? [`website:${lower(name)}`] : []);

  // Domains.
  for (const domain of file.domains) {
    const existing = now.domains.find((item) => lower(item.hostname) === domain.hostname);
    const deps = websiteSteps(domain.website);
    if (!existing) {
      steps.push({
        id: `domain:${domain.hostname}`, action: "create", resource: "domain", key: domain.hostname, changes: {},
        request: fixed((ids) => ({ method: "POST", path: "domains", body: { hostname: domain.hostname, ...(domain.website ? { deploymentId: websiteId(ids, domain.website) } : {}) } }), deps),
        dependsOn: deps, prune: false,
      });
      continue;
    }
    const wanted = domain.website ? findWebsite(domain.website)?.id ?? null : null;
    const differs = domain.website ? deps.length > 0 || existing.deploymentId !== wanted : existing.deploymentId !== null;
    if (differs) {
      steps.push({
        id: `domain:${domain.hostname}`, action: "update", resource: "domain", key: domain.hostname,
        changes: { website: [existing.deploymentName ?? existing.deploymentId, domain.website] },
        request: fixed((ids) => ({ method: "PUT", path: `domains/${existing.id}`, body: { deploymentId: domain.website ? websiteId(ids, domain.website) : null } }), deps),
        dependsOn: deps, prune: false,
      });
    }
  }

  // Preview servers.
  for (const server of file.previewServers) {
    const existing = findServer(server.name);
    if (!existing) {
      const deps = [...secretSteps(server.secrets), ...sourceSteps(server.repo)];
      const op = operation(api.session, "apply.preview.create", server);
      steps.push({
        id: `preview:${lower(server.name)}`, action: "create", resource: "preview server", key: server.name, changes: {},
        request: fixed((ids) => ({
          method: "POST", path: "dev-servers",
          body: {
            request_id: op.id, name: server.name, code_source_id: sourceId(ids, server.repo), branch: server.branch ?? defaultBranch(server.repo),
            start_command: server.command, port: server.port, env_overrides: server.env, secret_ids: server.secrets.map((name) => secretId(ids, name)),
          },
        }), deps),
        created: () => op.done(), dependsOn: deps, prune: false,
      });
      continue;
    }
    const changes: Record<string, [unknown, unknown]> = {};
    const body: Record<string, unknown> = {};
    if (!same(existing.startCommand, server.command)) { changes.command = [existing.startCommand, server.command]; body.start_command = server.command; }
    if (existing.port !== server.port) { changes.port = [existing.port, server.port]; body.port = server.port; }
    if (server.branch && existing.branch !== server.branch) { changes.branch = [existing.branch, server.branch]; body.branch = server.branch; }
    const envWanted = prune ? server.env : { ...existing.envOverrides, ...server.env };
    if (!same(sortedEnv(existing.envOverrides), sortedEnv(envWanted))) { changes.env = [sortedEnv(existing.envOverrides), sortedEnv(envWanted)]; body.env_overrides = envWanted; }
    const currentNames = existing.secretIds.map(secretNameOf).sort();
    const wantedNames = [...new Set(prune ? server.secrets : [...currentNames, ...server.secrets])].sort();
    const secretsChange = !same(currentNames, wantedNames);
    if (secretsChange) changes.secrets = [currentNames, wantedNames];
    if (!Object.keys(changes).length) continue;
    const deps = secretsChange ? secretSteps(wantedNames) : [];
    const keep = (name: string) => existing.secretIds.find((id) => secretNameOf(id) === name);
    steps.push({
      id: `preview:${lower(server.name)}`, action: "update", resource: "preview server", key: server.name, changes,
      request: fixed((ids) => ({
        method: "PUT", path: `dev-servers/${existing.id}`,
        body: { ...body, ...(secretsChange ? { secret_ids: wantedNames.map((name) => keep(name) ?? secretId(ids, name)) } : {}) },
      }), deps),
      dependsOn: deps, prune: false,
    });
  }

  // Languages: additions, then the default; removals only with --prune.
  if (file.locales && now.locales) {
    const has = (list: string[], code: string) => list.some((item) => lower(item) === lower(code));
    const additions = file.locales.supported.filter((code) => !has(now.locales!.supported, code));
    for (const code of additions) {
      steps.push({ id: `locale:${lower(code)}`, action: "create", resource: "locale", key: code, changes: {}, request: { method: "POST", path: "localization/locales", body: { locale: code } }, dependsOn: [], prune: false });
    }
    if (lower(file.locales.default) !== lower(now.locales.default)) {
      const supported = [...new Set([...now.locales.supported, ...additions])];
      steps.push({
        id: "locale:default", action: "update", resource: "locale", key: "default", changes: { default: [now.locales.default, file.locales.default] },
        request: { method: "PUT", path: "localization", body: { ...now.localization, defaultLocale: file.locales.default, supportedLocales: supported } },
        dependsOn: additions.filter((code) => lower(code) === lower(file.locales!.default)).map((code) => `locale:${lower(code)}`), prune: false,
      });
    }
    // A removal whose cleanup failed earlier is finished on the next run (§12.2 P2-5).
    for (const job of now.cleanupJobs.filter((item) => item.status === "failed" && item.locale && !has(file.locales!.supported, item.locale))) {
      steps.push({
        id: `locale:${lower(job.locale!)}:cleanup`, action: "delete", resource: "locale", key: job.locale!, changes: { cleanup: ["failed", "retry"] },
        request: { method: "POST", path: `localization/cleanup-jobs/${encodeURIComponent(job.id)}/retry`, body: {} },
        dependsOn: [], prune: false, waitForCleanup: true,
      });
    }
    for (const code of now.locales.supported.filter((item) => !has(file.locales!.supported, item))) {
      pruned.push({
        id: `locale:${lower(code)}:remove`, action: "delete", resource: "locale", key: code, changes: {},
        request: { method: "DELETE", path: `localization/locales/${encodeURIComponent(code)}` },
        dependsOn: steps.some((step) => step.id === "locale:default") ? ["locale:default"] : [], prune: true, waitForCleanup: true,
      });
    }
  }

  // Image policy.
  if (file.imagePolicy && !same(now.imagePolicy, file.imagePolicy)) {
    steps.push({ id: "image-policy", action: "update", resource: "image policy", key: "image policy", changes: { policy: [now.imagePolicy, file.imagePolicy] }, request: { method: "PUT", path: "image-policy", body: file.imagePolicy }, dependsOn: [], prune: false });
  }

  // Forms.
  for (const form of file.forms) {
    const existing = now.forms.find((item) => item.type === form.name);
    if (!existing) {
      steps.push({ id: `form:${form.name}`, action: "create", resource: "form", key: form.name, changes: {}, request: { method: "POST", path: "submissions/types", body: stripUndefined({ type: form.name, acceptingResponses: form.accepting }) }, dependsOn: [], prune: false });
    } else if (form.accepting !== undefined && existing.acceptingResponses !== form.accepting) {
      steps.push({ id: `form:${form.name}`, action: "update", resource: "form", key: form.name, changes: { accepting: [existing.acceptingResponses, form.accepting] }, request: { method: "PUT", path: `submissions/types/${encodeURIComponent(form.name)}`, body: { acceptingResponses: form.accepting } }, dependsOn: [], prune: false });
    }
  }

  // Deletions (--prune): domains before their websites; secrets last, only when nothing uses them.
  const declared = {
    domains: new Set(file.domains.map((domain) => domain.hostname)),
    websites: new Set(file.websites.map((site) => lower(site.name))),
    forms: new Set(file.forms.map((form) => form.name)),
    secrets: new Set(wantedSecrets),
  };
  if (managed("domains")) {
    for (const domain of now.domains.filter((item) => !declared.domains.has(lower(item.hostname)))) {
      pruned.push({ id: `domain:${lower(domain.hostname)}:remove`, action: "delete", resource: "domain", key: domain.hostname, changes: {}, request: { method: "DELETE", path: `domains/${domain.id}` }, dependsOn: [], prune: true });
    }
  }
  if (managed("websites")) {
    for (const site of now.websites.filter((item) => !declared.websites.has(lower(item.name)))) {
      const domains = now.domains.filter((domain) => domain.deploymentId === site.id).map((domain) => `domain:${lower(domain.hostname)}:remove`)
        .filter((id) => pruned.some((step) => step.id === id));
      pruned.push({ id: `website:${lower(site.name)}:remove`, action: "delete", resource: "website", key: site.name, changes: {}, request: { method: "DELETE", path: `deployments/${site.id}` }, dependsOn: domains, prune: true });
    }
  }
  if (managed("forms")) {
    for (const form of now.forms.filter((item) => !declared.forms.has(item.type))) {
      pruned.push({ id: `form:${form.type}:remove`, action: "delete", resource: "form", key: form.type, changes: {}, request: { method: "DELETE", path: `submissions/types/${encodeURIComponent(form.type)}` }, dependsOn: [], prune: true });
    }
  }
  if (managed("secrets")) {
    // A secret goes only when nothing uses it once --prune made the file's lists exact.
    // Targets the file doesn't mention keep what they have.
    const usedAfterPrune = new Set<string>([
      ...file.presets.flatMap((preset) => preset.secrets),
      ...file.previewServers.flatMap((server) => server.secrets),
      ...now.presets.filter((preset) => !file.presets.some((item) => lower(item.name) === lower(preset.name))).flatMap((preset) => preset.secretIds.map(secretNameOf)),
      ...now.servers.filter((server) => !file.previewServers.some((item) => lower(item.name) === lower(server.name))).flatMap((server) => server.secretIds.map(secretNameOf)),
    ]);
    for (const secret of now.secrets.filter((item) => !declared.secrets.has(item.name) && !usedAfterPrune.has(item.name))) {
      const detaching = steps.filter((step) => step.changes.secrets).map((step) => step.id);
      pruned.push({ id: `secret:${secret.name}:remove`, action: "delete", resource: "secret", key: secret.name, changes: {}, request: { method: "DELETE", path: `secrets/${secret.id}` }, dependsOn: detaching, prune: true });
    }
  }

  // Never delete what the file declares (§12.1 P1-6): a mismatch here is a bug, not a deletion.
  for (const step of pruned) {
    const key = step.resource === "secret" ? step.key : lower(step.key);
    const set = step.resource === "domain" ? declared.domains : step.resource === "website" ? declared.websites
      : step.resource === "form" ? declared.forms : step.resource === "secret" ? declared.secrets : null;
    if (set?.has(key) || (step.resource === "locale" && file.locales?.supported.some((code) => lower(code) === key))) {
      throw new CliError("unexpected", `Refusing to plan deleting ${step.resource} ${step.key}: the file lists it.`);
    }
  }

  return { steps: prune ? [...steps, ...pruned] : steps, pruned: prune ? [] : pruned, missingValues };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

// --- Plan output ------------------------------------------------------------------------

export const planStepSchema = z.object({
  id: z.string(), action: z.string(), resource: z.string(), key: z.string(),
  changes: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])), dependsOn: z.array(z.string()), prune: z.boolean(),
});
export const planResultSchema = z.object({ steps: z.array(planStepSchema), pruneWouldDelete: z.array(planStepSchema), changes: z.number() });

/** What `plan` prints: never a request body (a secret value would be in it). */
export function describePlan(plan: Plan): z.infer<typeof planResultSchema> {
  const view = (step: Step) => ({ id: step.id, action: step.action, resource: step.resource, key: step.key, changes: step.changes, dependsOn: step.dependsOn, prune: step.prune });
  return { steps: plan.steps.map(view), pruneWouldDelete: plan.pruned.map(view), changes: plan.steps.length };
}

// --- Apply ------------------------------------------------------------------------------

export const applyResultSchema = z.object({
  results: z.array(z.object({
    id: z.string(), outcome: z.enum(["done", "failed", "skipped"]),
    /** With what's needed to recover: a cleanup job's ID, the command to retry (§12.2 P2-5). */
    error: z.object({ code: z.string(), message: z.string(), fix: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
  })),
  applied: z.number(),
  failed: z.number(),
});

/**
 * Runs the plan. With a personal credential, every change already known asks
 * once, as the exact plan (the server derives and checks what each request
 * does before anything runs); a change that needs an ID created earlier in
 * the run asks on its own when it runs. A failed step skips only the steps
 * that depend on it.
 */
export async function applyPlan(
  api: ApiClient,
  plan: Plan,
  options: { onStep?: (step: Step, outcome: string) => void; pause?: (ms: number) => Promise<unknown> } = {},
): Promise<z.infer<typeof applyResultSchema>> {
  const ids = noIds();
  const known = plan.steps.filter((step) => typeof step.request !== "function").map((step) => step.request as Request);
  if (known.length && isPersonalCredential(api.session.token)) {
    // Approved as the exact plan shown; the CLI waits here like any approval.
    await api.cliApprovals("POST", "plans", {
      body: {
        projectId: api.session.projectId,
        operations: known.map((request) => ({ method: request.method, path: `/projects/${api.session.projectId}/${request.path}`, body: request.body })),
      },
    });
  }
  const inPlan = new Set(plan.steps.map((step) => step.id));
  const outcomes = new Map<string, "done" | "failed" | "skipped">();
  const results: z.infer<typeof applyResultSchema>["results"] = [];
  for (const step of plan.steps) {
    // Run only after every prerequisite succeeded in this run (§12.2 P2-3).
    if (step.dependsOn.some((dependency) => !inPlan.has(dependency) || outcomes.get(dependency) !== "done")) {
      outcomes.set(step.id, "skipped");
      results.push({ id: step.id, outcome: "skipped" });
      options.onStep?.(step, "skipped");
      continue;
    }
    try {
      const request = typeof step.request === "function" ? step.request(ids) : step.request;
      const response = await api.json(request.method, request.path, { body: request.body, signal: AbortSignal.timeout(300_000) });
      step.created?.(response, ids);
      if (step.waitForCleanup) await followCleanup(api, response, step, options.pause);
      outcomes.set(step.id, "done");
      results.push({ id: step.id, outcome: "done" });
      options.onStep?.(step, "done");
    } catch (error) {
      // An approval to wait for, or a credential that can't do this, stops the run as a whole.
      if (error instanceof CliError && ([EXIT.auth, EXIT.confirmation, EXIT.pending] as number[]).includes(error.exitCode)) throw error;
      const failure = error instanceof CliError ? error : new CliError("unexpected", String(error));
      outcomes.set(step.id, "failed");
      results.push({
        id: step.id, outcome: "failed",
        error: { code: failure.code, message: failure.message, ...(failure.fix ? { fix: failure.fix } : {}), ...(failure.details ? { details: failure.details } : {}) },
      });
      options.onStep?.(step, "failed");
    }
  }
  return { results, applied: results.filter((result) => result.outcome === "done").length, failed: results.filter((result) => result.outcome !== "done").length };
}

/** A pruned language is done when its translation cleanup is (§5.6). */
async function followCleanup(api: ApiClient, response: unknown, step: Step, pause?: (ms: number) => Promise<unknown>) {
  const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  if (typeof record.id !== "string" || typeof record.status !== "string") return;
  await waitForCleanup(api, { ...record, id: record.id, status: record.status }, { locale: step.key, pause });
}
