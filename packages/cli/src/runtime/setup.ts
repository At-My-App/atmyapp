import * as fs from "node:fs";
import { z } from "zod";
import type { ApiClient } from "./api";
import { addCodeSource, findCodeSource, sourceRef } from "./code";
import { diffFields, ensure } from "./ensure";
import { CliError, EXIT } from "./errors";
import { operation } from "./operations";

/**
 * Hosting setup (`atmyapp hosting websites|presets`, `env`, `secrets`,
 * `preview create|edit`, `projects website connect`; CliEverywherePlan §5.5 4b).
 *
 * Three kinds of environment value stay apart:
 * - a plain override lives on one target (a website's preset or a preview server);
 * - an attached secret: the target holds the secret's ID, the value lives once;
 * - a secret value: project-level, shared by every target it's attached to.
 */

const timeout = () => AbortSignal.timeout(30_000);
type Row = Record<string, unknown>;

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function matchOne<T extends { id: string; name: string }>(items: T[], ref: string, kind: string, fix: string): T {
  const wanted = ref.trim().toLowerCase();
  const matches = items.filter((item) => item.id === ref.trim() || item.name.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  throw new CliError(matches.length ? `${kind}_ambiguous` : `${kind}_not_found`,
    matches.length ? `Several ${kind.replace(/_/g, " ")}s are called '${ref}'.` : `No ${kind.replace(/_/g, " ")} '${ref}' in this project.`, {
      exitCode: EXIT.usage, details: { choices: items.map(({ id, name }) => ({ id, name })) }, fix,
    });
}

function only<T extends { id: string; name: string }>(items: T[], kind: string, flag: string): T {
  if (items.length === 1) return items[0];
  throw new CliError(`${kind}_required`, items.length ? `This project has several ${kind}s. Choose one with ${flag}.` : `This project has no ${kind} yet.`, {
    exitCode: EXIT.usage, details: { choices: items.map(({ id, name }) => ({ id, name })) },
  });
}

// --- Presets ---------------------------------------------------------------------

export const presetSchema = z.object({
  id: z.string(), name: z.string(), codeSourceId: z.string().nullable(), branch: z.string().nullable(),
  framework: z.string().nullable(), installCommand: z.string().nullable(), buildCommand: z.string().nullable(),
  rootDirectory: z.string().nullable(), outputDirectory: z.string().nullable(),
  envOverrides: z.record(z.string(), z.string()), secretIds: z.array(z.string()),
  /**
   * False when the server sent a summary without the settings (a credential
   * without hosting.manage): envOverrides and secretIds are then unknown,
   * not empty, and must never be written back (§12.1 P1-4).
   */
  settingsVisible: z.boolean(),
});
export type Preset = z.infer<typeof presetSchema>;

/** The server included a target's settings (both spellings, as the APIs differ). */
function settingsIn(row: Row): boolean {
  return ["env_overrides", "envOverrides"].some((key) => key in row);
}

/** A target's variables, only when the server showed them. */
export function knownSettings<T extends { name: string; settingsVisible: boolean }>(target: T, label: string): T {
  if (target.settingsVisible) return target;
  throw new CliError("settings_unavailable", `This credential can't read the variables of ${label}, so it can't change them safely.`, {
    exitCode: EXIT.auth, fix: "Use a login or key with hosting.manage ('atmyapp login --preset developer').",
  });
}

function toPreset(row: Row): Preset {
  return {
    id: String(row.id), name: String(row.name ?? ""), codeSourceId: text(row.code_source_id), branch: text(row.branch),
    framework: text(row.framework), installCommand: text(row.install_command), buildCommand: text(row.build_command),
    rootDirectory: text(row.root_directory), outputDirectory: text(row.output_directory),
    envOverrides: (row.env_overrides && typeof row.env_overrides === "object" ? row.env_overrides : {}) as Record<string, string>,
    secretIds: strings(row.secret_ids),
    settingsVisible: settingsIn(row),
  };
}

export async function listPresets(api: ApiClient): Promise<{ presets: Preset[] }> {
  const raw = await api.json("GET", "build-presets", { signal: timeout() });
  return { presets: read(z.object({ build_presets: z.array(z.looseObject({ id: z.string() })) }), raw, "preset list").build_presets.map(toPreset) };
}

export async function showPreset(api: ApiClient, ref: string): Promise<{ preset: Preset }> {
  const { presets } = await listPresets(api);
  return { preset: matchOne(presets, ref, "preset", "Run 'atmyapp hosting presets ls'.") };
}

export interface PresetInput {
  name?: string;
  repo?: string;
  branch?: string;
  framework?: string;
  install?: string;
  build?: string;
  root?: string;
  output?: string;
}

function presetBody(input: PresetInput) {
  return Object.fromEntries(Object.entries({
    name: input.name, branch: input.branch, framework: input.framework, install_command: input.install,
    build_command: input.build, root_directory: input.root, output_directory: input.output,
  }).filter(([, value]) => value !== undefined));
}

/** Creates a build preset; safe to run twice by name. */
export async function createPreset(api: ApiClient, input: PresetInput & { name: string }) {
  if (!input.repo) throw new CliError("invalid_options", "Say which repository it builds with --repo owner/repo.", { exitCode: EXIT.usage });
  if (!input.build) throw new CliError("invalid_options", "Give the build command with --build, such as 'npm run build'.", { exitCode: EXIT.usage });
  const source = await findCodeSource(api, sourceRef(input.repo));
  if (!source) {
    throw new CliError("code_source_not_found", `${input.repo} isn't connected to this project.`, { fix: input.repo.includes("/") ? `Run 'atmyapp code add ${input.repo}' first.` : `Run 'atmyapp code create ${input.repo}' first.` });
  }
  const body = { ...presetBody(input), code_source_id: source.id, branch: input.branch ?? source.branch ?? undefined };
  const outcome = await ensure({
    kind: "preset", key: input.name,
    find: async () => (await listPresets(api)).presets.find((preset) => preset.name.toLowerCase() === input.name.toLowerCase()) ?? null,
    differences: (existing) => diffFields(
      { name: existing.name, branch: existing.branch, build_command: existing.buildCommand, output_directory: existing.outputDirectory, install_command: existing.installCommand },
      { branch: body.branch, build_command: input.build, output_directory: input.output, install_command: input.install },
    ),
    create: async () => toPreset(read(z.object({ build_preset: z.looseObject({ id: z.string() }) }),
      await api.json("POST", "build-presets", { body, signal: timeout() }), "preset").build_preset),
    editCommand: `atmyapp hosting presets edit "${input.name}"`,
  });
  return { preset: outcome.unchanged ? outcome.existing : outcome.created, unchanged: outcome.unchanged };
}

async function putPreset(api: ApiClient, id: string, body: Record<string, unknown>): Promise<Preset> {
  const raw = await api.json("PUT", `build-presets/${encodeURIComponent(id)}`, { body, signal: timeout() });
  const row = (raw as { build_preset?: Row } | null)?.build_preset;
  return row ? toPreset(row) : (await listPresets(api)).presets.find((preset) => preset.id === id)!;
}

export async function editPreset(api: ApiClient, ref: string, input: PresetInput) {
  const { preset } = await showPreset(api, ref);
  const body = presetBody(input);
  if (!Object.keys(body).length) return { preset, unchanged: true };
  return { preset: await putPreset(api, preset.id, body), unchanged: false };
}

// --- Websites ------------------------------------------------------------------------

export const websiteSchema = z.object({
  id: z.string(), name: z.string(), presetId: z.string().nullable(), activeReleaseId: z.string().nullable(),
  autoPromote: z.boolean(), autoRebuildOnContent: z.boolean(), autoRebuildOnCode: z.boolean(),
});
export type Website = z.infer<typeof websiteSchema>;

function toWebsite(row: Row): Website {
  return {
    id: String(row.id), name: String(row.name ?? ""), presetId: text(row.build_preset_id), activeReleaseId: text(row.active_release_id),
    autoPromote: row.auto_promote_on_release !== false,
    autoRebuildOnContent: row.auto_rebuild_on_storage_change !== false,
    autoRebuildOnCode: row.auto_rebuild_on_code_source_change !== false,
  };
}

export async function listWebsites(api: ApiClient): Promise<{ websites: Website[] }> {
  const raw = await api.json("GET", "deployments", { signal: timeout() });
  return { websites: read(z.object({ deployments: z.array(z.looseObject({ id: z.string() })) }), raw, "website list").deployments.map(toWebsite) };
}

async function website(api: ApiClient, ref: string | undefined): Promise<Website> {
  const { websites } = await listWebsites(api);
  return ref ? matchOne(websites, ref, "website", "Run 'atmyapp hosting websites ls'.") : only(websites, "website", "--website");
}

export interface WebsiteInput {
  name?: string;
  preset?: string;
  autoPromote?: boolean;
  autoRebuild?: boolean;
}

/**
 * Creates a website from an existing build preset; safe to run twice by name.
 * The first website of a fresh project has no preset yet: use
 * `projects website connect`, which creates both.
 */
export async function createWebsite(api: ApiClient, input: WebsiteInput & { name: string }) {
  const { presets } = await listPresets(api);
  if (!presets.length) {
    throw new CliError("preset_required", "This project has no build preset yet, and a website needs one.", {
      exitCode: EXIT.usage,
      fix: "Run 'atmyapp projects website connect --repo <owner/repo>' for the first website, or 'atmyapp hosting presets create'.",
    });
  }
  const preset = input.preset ? matchOne(presets, input.preset, "preset", "Run 'atmyapp hosting presets ls'.") : only(presets, "preset", "--preset");
  const outcome = await ensure({
    kind: "website", key: input.name,
    find: async () => (await listWebsites(api)).websites.find((site) => site.name.toLowerCase() === input.name.toLowerCase()) ?? null,
    differences: (existing): Record<string, { current: unknown; wanted: unknown }> =>
      (existing.presetId !== preset.id ? { preset: { current: existing.presetId, wanted: preset.id } } : {}),
    create: async () => {
      const raw = await api.json("POST", "deployments", {
        body: {
          name: input.name, build_preset_id: preset.id,
          ...(input.autoPromote !== undefined ? { auto_promote_on_release: input.autoPromote } : {}),
          ...(input.autoRebuild !== undefined ? { auto_rebuild_on_storage_change: input.autoRebuild } : {}),
        },
        signal: timeout(),
      });
      const row = (raw as { deployment?: Row } | null)?.deployment;
      return row ? toWebsite(row) : (await listWebsites(api)).websites.find((site) => site.name === input.name)!;
    },
    editCommand: `atmyapp hosting websites edit "${input.name}"`,
  });
  return { website: outcome.unchanged ? outcome.existing : outcome.created, unchanged: outcome.unchanged };
}

export async function editWebsite(api: ApiClient, ref: string, input: WebsiteInput) {
  const site = await website(api, ref);
  const presetId = input.preset ? matchOne((await listPresets(api)).presets, input.preset, "preset", "Run 'atmyapp hosting presets ls'.").id : undefined;
  const body = Object.fromEntries(Object.entries({
    name: input.name, build_preset_id: presetId,
    auto_promote_on_release: input.autoPromote, auto_rebuild_on_storage_change: input.autoRebuild,
  }).filter(([, value]) => value !== undefined));
  if (!Object.keys(body).length) return { website: site, unchanged: true };
  const raw = await api.json("PUT", `deployments/${encodeURIComponent(site.id)}`, { body, signal: timeout() });
  const row = (raw as { deployment?: Row } | null)?.deployment;
  return { website: row ? toWebsite(row) : site, unchanged: false };
}

export async function removeWebsite(api: ApiClient, ref: string, options: { ifExists?: boolean; dryRun?: boolean }) {
  const { websites } = await listWebsites(api);
  const wanted = ref.trim().toLowerCase();
  const site = websites.find((candidate) => candidate.id === ref.trim() || candidate.name.toLowerCase() === wanted);
  if (!site) {
    if (options.ifExists) return { name: ref, removed: false, dryRun: Boolean(options.dryRun) };
    matchOne(websites, ref, "website", "Run 'atmyapp hosting websites ls'.");
  }
  if (options.dryRun) return { name: site!.name, removed: false, dryRun: true };
  await api.json("DELETE", `deployments/${encodeURIComponent(site!.id)}`, { signal: timeout() });
  return { name: site!.name, removed: true, dryRun: false };
}

// --- Secrets -------------------------------------------------------------------------

export const secretSchema = z.object({
  id: z.string(), name: z.string(), secret: z.boolean(), hint: z.string().nullable(), attachedTo: z.array(z.string()),
});
export type Secret = z.infer<typeof secretSchema>;

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * A project secret's name as the server stores it: upper case (§12.1 P1-6).
 * `stripe_key` and `STRIPE_KEY` are the same secret.
 */
export function secretName(name: string): string {
  const trimmed = name.trim();
  if (!ENV_NAME.test(trimmed)) {
    throw new CliError("invalid_name", "Use letters, digits and underscores, starting with a letter: API_URL.", { exitCode: EXIT.usage });
  }
  return trimmed.toUpperCase();
}

async function rawSecrets(api: ApiClient) {
  const raw = await api.json("GET", "secrets", { signal: timeout() });
  return read(z.object({ secrets: z.array(z.looseObject({ id: z.string(), name: z.string() })) }), raw, "secret list").secrets;
}

/** Every target holding a secret, by name: "website Main", "preview server Preview". */
async function attachments(api: ApiClient) {
  const [{ presets }, { websites }, servers] = await Promise.all([listPresets(api), listWebsites(api), listPreviewServers(api)]);
  const targets: Array<{ label: string; secretIds: string[] }> = [];
  for (const preset of presets) {
    const users = websites.filter((site) => site.presetId === preset.id).map((site) => `website ${site.name}`);
    targets.push({ label: users.length ? users.join(", ") : `preset ${preset.name}`, secretIds: preset.secretIds });
  }
  for (const server of servers) targets.push({ label: `preview server ${server.name}`, secretIds: server.secretIds });
  return targets;
}

/** Names, hints and where each is attached; never a value. */
export async function listSecrets(api: ApiClient): Promise<{ secrets: Secret[] }> {
  const [rows, targets] = await Promise.all([rawSecrets(api), attachments(api)]);
  return {
    secrets: rows.map((row) => ({
      id: row.id,
      name: row.name,
      secret: row.is_secret !== false,
      // Plain variables come back as their value; secrets as a masked hint.
      hint: row.is_secret !== false ? text(row.value) : null,
      attachedTo: targets.filter((target) => target.secretIds.includes(row.id)).map((target) => target.label),
    })),
  };
}

/** A value from stdin or an environment variable, never a flag (it would stay in shell history). */
export function secretValue(options: { fromStdin?: boolean; fromEnv?: string; stdin?: () => string }): string {
  if (options.fromStdin && options.fromEnv) throw new CliError("invalid_options", "Pass --from-stdin or --from-env, not both.", { exitCode: EXIT.usage });
  let value: string | undefined;
  if (options.fromEnv) {
    value = process.env[options.fromEnv];
    if (value === undefined) throw new CliError("invalid_options", `The environment variable ${options.fromEnv} isn't set.`, { exitCode: EXIT.usage });
  } else if (options.fromStdin) {
    value = (options.stdin ?? (() => fs.readFileSync(0, "utf8")))().replace(/\r?\n$/, "");
  } else {
    throw new CliError("invalid_options", "Give the value with --from-stdin (echo … | atmyapp secrets set NAME --from-stdin) or --from-env VAR.", {
      exitCode: EXIT.usage, fix: "Values never go in a flag: they would stay in your shell history.",
    });
  }
  if (!value) throw new CliError("invalid_options", "The value is empty.", { exitCode: EXIT.usage });
  return value;
}

export const secretSetSchema = z.object({ name: z.string(), created: z.boolean(), secret: z.boolean() });

/** Creates or replaces a project-level value. The value is never printed back. */
/** Every project secret's ID and name (no values). */
export async function secretNames(api: ApiClient): Promise<Array<{ id: string; name: string }>> {
  return (await rawSecrets(api)).map(({ id, name }) => ({ id, name }));
}

/**
 * Each `secrets set` is its own action (§12.1 P1-7): the journal gives it an
 * operation ID, reused only when this exact run is retried after a lost
 * answer. Setting an earlier value again is a new action, never a replay of
 * the old receipt. The journal is keyed by the name; the value never goes in.
 */
export async function setSecret(api: ApiClient, rawName: string, value: string, options: { plain?: boolean; description?: string } = {}) {
  const name = secretName(rawName);
  const existing = (await rawSecrets(api)).find((row) => row.name === name);
  const secret = !options.plain;
  const op = operation(api.session, "secrets.set", [name, existing?.id ?? null]);
  const body = { value, is_secret: secret, description: options.description, operationId: op.id };
  if (existing) await api.json("PUT", `secrets/${encodeURIComponent(existing.id)}`, { body, signal: timeout() });
  else await api.json("POST", "secrets", { body: { name, ...body }, signal: timeout() });
  op.done();
  return { name, created: !existing, secret };
}

export const secretRemoveSchema = z.object({ name: z.string(), removed: z.boolean(), detachedFrom: z.array(z.string()) });

/** Refused while targets still use it, unless `detachAll` (each detach is its own approval). */
export async function removeSecret(api: ApiClient, rawName: string, options: { detachAll?: boolean; ifExists?: boolean }) {
  const name = secretName(rawName);
  const rows = await rawSecrets(api);
  const row = rows.find((candidate) => candidate.name === name);
  if (!row) {
    if (options.ifExists) return { name, removed: false, detachedFrom: [] };
    throw new CliError("secret_not_found", `No secret '${name}' in this project.`, { details: { secrets: rows.map((item) => item.name) } });
  }
  const [{ presets }, servers] = await Promise.all([listPresets(api), listPreviewServers(api)]);
  // Unknown attachments would read as "unused" (§12.1 P1-4).
  presets.forEach((preset) => knownSettings(preset, `build preset ${preset.name}`));
  servers.forEach((server) => knownSettings(server, `preview server ${server.name}`));
  const users = [
    ...presets.filter((preset) => preset.secretIds.includes(row.id)).map((preset) => ({ kind: "preset" as const, id: preset.id, name: preset.name, ids: preset.secretIds })),
    ...servers.filter((server) => server.secretIds.includes(row.id)).map((server) => ({ kind: "server" as const, id: server.id, name: server.name, ids: server.secretIds })),
  ];
  if (users.length && !options.detachAll) {
    throw new CliError("secret_in_use", `${name} is still attached to ${users.map((user) => user.name).join(", ")}.`, {
      exitCode: EXIT.conflict, details: { attachedTo: users.map(({ kind, name: userName }) => ({ kind, name: userName })) },
      fix: `Detach it with 'atmyapp env rm ${name} --website <name>', or pass --detach-all.`,
    });
  }
  for (const user of users) {
    const secretIds = user.ids.filter((id) => id !== row.id);
    if (user.kind === "preset") await putPreset(api, user.id, { secret_ids: secretIds });
    else await api.json("PUT", `dev-servers/${encodeURIComponent(user.id)}`, { body: { secret_ids: secretIds }, signal: timeout() });
  }
  // The server checks again at deletion time: a target attached meanwhile refuses it (secret_in_use).
  await api.json("DELETE", `secrets/${encodeURIComponent(row.id)}`, { signal: timeout() });
  return { name, removed: true, detachedFrom: users.map((user) => user.name) };
}

// --- Preview servers (setup) ---------------------------------------------------------

export const previewServerSchema = z.object({
  id: z.string(), name: z.string(), codeSourceId: z.string().nullable(), branch: z.string().nullable(), startCommand: z.string().nullable(), port: z.number().nullable(),
  envOverrides: z.record(z.string(), z.string()), secretIds: z.array(z.string()),
  /** See presetSchema.settingsVisible. */
  settingsVisible: z.boolean(),
});
export type PreviewServer = z.infer<typeof previewServerSchema>;

function toServer(row: Row): PreviewServer {
  return {
    id: String(row.id), name: String(row.name ?? ""), codeSourceId: text(row.code_source_id ?? row.codeSourceId), branch: text(row.branch),
    startCommand: text(row.start_command ?? row.startCommand), port: typeof row.port === "number" ? row.port : null,
    envOverrides: ((row.env_overrides ?? row.envOverrides) && typeof (row.env_overrides ?? row.envOverrides) === "object"
      ? (row.env_overrides ?? row.envOverrides) : {}) as Record<string, string>,
    secretIds: strings(row.secret_ids ?? row.secretIds),
    settingsVisible: settingsIn(row),
  };
}

export async function listPreviewServers(api: ApiClient): Promise<PreviewServer[]> {
  const raw = await api.json("GET", "dev-servers", { signal: timeout() });
  return read(z.object({ devServers: z.array(z.looseObject({ id: z.string() })) }), raw, "preview server list").devServers.map(toServer);
}

export interface PreviewServerInput {
  name?: string;
  repo?: string;
  branch?: string;
  command?: string;
  port?: number;
  install?: string;
  root?: string;
}

/** Creates a preview server; safe to run twice by name. */
export async function createPreviewServer(api: ApiClient, input: PreviewServerInput & { name: string }) {
  if (!input.repo || !input.command || !input.port) {
    throw new CliError("invalid_options", "Give --repo owner/repo, --command (such as 'npm run dev') and --port.", { exitCode: EXIT.usage });
  }
  const source = await findCodeSource(api, sourceRef(input.repo));
  if (!source) throw new CliError("code_source_not_found", `${input.repo} isn't connected to this project.`, { fix: input.repo.includes("/") ? `Run 'atmyapp code add ${input.repo}' first.` : `Run 'atmyapp code create ${input.repo}' first.` });
  const op = operation(api.session, "preview.create", [input.name]);
  const outcome = await ensure({
    kind: "preview server", key: input.name,
    find: async () => (await listPreviewServers(api)).find((server) => server.name.toLowerCase() === input.name.toLowerCase()) ?? null,
    differences: (existing) => diffFields({ start_command: existing.startCommand, port: existing.port }, { start_command: input.command, port: input.port }),
    create: async () => {
      const raw = await api.json("POST", "dev-servers", {
        body: {
          request_id: op.id, name: input.name, code_source_id: source.id, branch: input.branch ?? source.branch ?? "main",
          start_command: input.command, port: input.port, install_command: input.install, root_directory: input.root,
        },
        signal: AbortSignal.timeout(120_000),
      });
      op.done();
      const row = (raw as { devServer?: Row } | null)?.devServer;
      return row ? toServer(row) : (await listPreviewServers(api)).find((server) => server.name === input.name)!;
    },
    editCommand: `atmyapp preview edit --server "${input.name}"`,
  });
  return { server: outcome.unchanged ? outcome.existing : outcome.created, unchanged: outcome.unchanged };
}

export async function editPreviewServer(api: ApiClient, ref: string | undefined, input: PreviewServerInput) {
  const servers = await listPreviewServers(api);
  const server = ref ? matchOne(servers, ref, "preview_server", "Run 'atmyapp preview status'.") : only(servers, "preview server", "--server");
  const body = Object.fromEntries(Object.entries({
    name: input.name, branch: input.branch, start_command: input.command, port: input.port, install_command: input.install, root_directory: input.root,
  }).filter(([, value]) => value !== undefined));
  if (!Object.keys(body).length) return { server, unchanged: true };
  const raw = await api.json("PUT", `dev-servers/${encodeURIComponent(server.id)}`, { body, signal: AbortSignal.timeout(120_000) });
  const row = (raw as { devServer?: Row } | null)?.devServer;
  return { server: row ? toServer(row) : server, unchanged: false };
}

// --- Environment variables -------------------------------------------------------------

export interface EnvTarget {
  website?: string;
  previewServer?: string;
}

type ResolvedTarget =
  | { kind: "website"; label: string; preset: Preset; websites: string[] }
  | { kind: "preview"; label: string; server: PreviewServer };

/**
 * A website's variables live on its build preset. When other websites build
 * from the same preset, a change reaches them too (§12.1 P1-5): it's refused
 * unless `shared` says the person means all of them, and the label names them.
 */
async function envTarget(api: ApiClient, target: EnvTarget & { shared?: boolean; write?: boolean }): Promise<ResolvedTarget> {
  if (target.website && target.previewServer) throw new CliError("invalid_options", "Choose --website or --preview-server, not both.", { exitCode: EXIT.usage });
  if (target.previewServer) {
    const server = matchOne(await listPreviewServers(api), target.previewServer, "preview_server", "Run 'atmyapp preview status'.");
    const label = `preview server ${server.name}`;
    return { kind: "preview", label, server: knownSettings(server, label) };
  }
  const { websites } = await listWebsites(api);
  const site = target.website ? matchOne(websites, target.website, "website", "Run 'atmyapp hosting websites ls'.") : only(websites, "website", "--website");
  if (!site.presetId) throw new CliError("preset_required", `${site.name} has no build preset.`, { fix: "Set one with 'atmyapp hosting websites edit --preset'." });
  const preset = (await listPresets(api)).presets.find((candidate) => candidate.id === site.presetId);
  if (!preset) throw new CliError("preset_not_found", `${site.name}'s build preset can't be read with this credential.`, { exitCode: EXIT.auth, fix: "It needs hosting.manage." });
  const sharing = websites.filter((item) => item.presetId === preset.id).map((item) => item.name);
  const label = sharing.length > 1 ? `build preset ${preset.name} (websites ${sharing.join(", ")})` : `website ${site.name}`;
  if (target.write && sharing.length > 1 && !target.shared) {
    throw new CliError("preset_shared", `${site.name} shares the build preset ${preset.name} with ${sharing.filter((name) => name !== site.name).join(", ")}: this change would reach all of them.`, {
      exitCode: EXIT.conflict, details: { preset: preset.name, websites: sharing },
      fix: `Pass --shared to change it for ${sharing.join(", ")}, or give ${site.name} its own preset ('atmyapp hosting presets create', then 'hosting websites edit ${site.name} --preset').`,
    });
  }
  return { kind: "website", label, preset: knownSettings(preset, label), websites: sharing };
}

function current(target: ResolvedTarget) {
  return target.kind === "website" ? target.preset : target.server;
}

async function update(api: ApiClient, target: ResolvedTarget, body: { env_overrides?: Record<string, string>; secret_ids?: string[] }) {
  if (target.kind === "website") await putPreset(api, target.preset.id, body);
  else await api.json("PUT", `dev-servers/${encodeURIComponent(target.server.id)}`, { body, signal: AbortSignal.timeout(120_000) });
}

export const envListSchema = z.object({
  target: z.string(),
  variables: z.array(z.object({ name: z.string(), kind: z.enum(["plain", "secret"]), value: z.string().nullable() })),
});

export async function listEnv(api: ApiClient, target: EnvTarget): Promise<z.infer<typeof envListSchema>> {
  const resolved = await envTarget(api, target);
  const { envOverrides, secretIds } = current(resolved);
  const secrets = await rawSecrets(api);
  return {
    target: resolved.label,
    variables: [
      ...Object.entries(envOverrides).map(([name, value]) => ({ name, kind: "plain" as const, value })),
      ...secretIds.map((id) => ({ name: secrets.find((row) => row.id === id)?.name ?? id, kind: "secret" as const, value: null })),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export const envChangeSchema = z.object({ target: z.string(), name: z.string(), kind: z.enum(["plain", "secret"]), unchanged: z.boolean() });

/**
 * `NAME=value` sets a plain override on this target. `NAME --secret` attaches
 * the project secret called NAME (its value stays in `secrets`).
 */
export async function setEnv(api: ApiClient, assignment: string, target: EnvTarget & { secret?: boolean; shared?: boolean }) {
  const resolved = await envTarget(api, { ...target, write: true });
  const now = current(resolved);
  if (target.secret) {
    if (assignment.includes("=")) throw new CliError("invalid_options", "With --secret, give only the name; the value lives in 'atmyapp secrets set'.", { exitCode: EXIT.usage });
    const name = secretName(assignment);
    const secret = (await rawSecrets(api)).find((row) => row.name === name);
    if (!secret) throw new CliError("secret_not_found", `No project secret '${name}'.`, { fix: `Create it with 'atmyapp secrets set ${name} --from-stdin'.` });
    if (now.secretIds.includes(secret.id)) return { target: resolved.label, name, kind: "secret" as const, unchanged: true };
    if (name in now.envOverrides) {
      throw new CliError("env_conflict", `${resolved.label} already has a plain ${name}.`, { exitCode: EXIT.conflict, fix: `Remove it first with 'atmyapp env rm ${name}'.` });
    }
    await update(api, resolved, { secret_ids: [...now.secretIds, secret.id] });
    return { target: resolved.label, name, kind: "secret" as const, unchanged: false };
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]{0,127})=([\s\S]*)$/.exec(assignment);
  if (!match) throw new CliError("invalid_argument", "Write it as NAME=value, or NAME --secret to attach a secret.", { exitCode: EXIT.usage });
  const [, name, value] = match;
  if (now.envOverrides[name] === value) return { target: resolved.label, name, kind: "plain" as const, unchanged: true };
  await update(api, resolved, { env_overrides: { ...now.envOverrides, [name]: value } });
  return { target: resolved.label, name, kind: "plain" as const, unchanged: false };
}

export const envRemoveSchema = z.object({ target: z.string(), name: z.string(), removed: z.enum(["plain", "secret", "nothing"]) });

/** Removes a plain override, or detaches a secret from this target only (the secret and its other targets stay). */
export async function removeEnv(api: ApiClient, name: string, target: EnvTarget & { ifExists?: boolean; shared?: boolean }) {
  const resolved = await envTarget(api, { ...target, write: true });
  const now = current(resolved);
  if (name in now.envOverrides) {
    const { [name]: _removed, ...rest } = now.envOverrides;
    await update(api, resolved, { env_overrides: rest });
    return { target: resolved.label, name, removed: "plain" as const };
  }
  const secret = ENV_NAME.test(name) ? (await rawSecrets(api)).find((row) => row.name === secretName(name) && now.secretIds.includes(row.id)) : undefined;
  if (secret) {
    await update(api, resolved, { secret_ids: now.secretIds.filter((id) => id !== secret.id) });
    return { target: resolved.label, name, removed: "secret" as const };
  }
  if (target.ifExists) return { target: resolved.label, name, removed: "nothing" as const };
  throw new CliError("env_not_found", `${resolved.label} has no ${name}.`, { fix: "Run 'atmyapp env ls' to see its variables." });
}

// --- Website Connect -------------------------------------------------------------------

export interface ConnectInput {
  repo?: string;
  branch?: string;
  root?: string;
  framework?: string;
  install?: string;
  build?: string;
  output?: string;
  previewCommand?: string;
  previewPort?: number;
  previewUrl?: string;
  preview?: boolean;
  wait?: boolean;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

const detectionSchema = z.object({
  candidates: z.array(z.looseObject({
    root: z.string(),
    framework: z.looseObject({ value: z.string() }),
    commands: z.looseObject({
      install: z.looseObject({ value: z.string() }),
      build: z.looseObject({ value: z.string() }).nullable(),
      output: z.looseObject({ value: z.string() }).nullable(),
      preview: z.looseObject({ value: z.string() }),
      port: z.number(),
    }),
  })),
  recommended_index: z.number(),
});

export const websiteConnectSchema = z.object({
  status: z.string(),
  repository: z.string(),
  settings: z.record(z.string(), z.unknown()),
  steps: z.array(z.looseObject({ id: z.string(), status: z.string() })),
  website: z.unknown(),
});

/**
 * The first website of a project (and its build preset, key and preview
 * server) through the dashboard's Website Connect flow, with the settings
 * the repository suggests unless flags say otherwise. Retrying the same
 * connect reuses its request ID, so it continues instead of starting over.
 */
export async function connectWebsite(api: ApiClient, input: ConnectInput): Promise<z.infer<typeof websiteConnectSchema>> {
  let source = input.repo ? await findCodeSource(api, sourceRef(input.repo)) : null;
  if (!source) {
    if (!input.repo) {
      throw new CliError("invalid_options", "Say which repository with --repo owner/repo, or the name of code stored in AtMyApp.", { exitCode: EXIT.usage });
    }
    if (!input.repo.includes("/")) {
      throw new CliError("code_source_not_found", `This project has no code called '${input.repo}'.`, { fix: `Create it with 'atmyapp code create ${input.repo}', push the website, then run this again.` });
    }
    source = (await addCodeSource(api, input.repo, { branch: input.branch, wait: true, timeoutMs: input.timeoutMs, onProgress: input.onProgress })).codeSource;
  }
  const branch = input.branch ?? source.branch ?? "main";
  const detection = read(detectionSchema, await api.json("GET", `code-sources/${encodeURIComponent(source.id)}/website-profile`, {
    query: { branch }, signal: AbortSignal.timeout(60_000),
  }), "website detection");
  const suggestion = input.root !== undefined
    ? detection.candidates.find((candidate) => candidate.root === input.root) ?? detection.candidates[detection.recommended_index]
    : detection.candidates[detection.recommended_index];
  const build = input.build ?? suggestion?.commands.build?.value;
  if (!build) {
    throw new CliError("build_command_required", "No build command was found in the repository.", {
      exitCode: EXIT.usage, fix: "Pass --build 'npm run build' and --output dist.",
    });
  }
  const preview = input.preview === false
    ? { mode: "later" as const }
    : input.previewUrl
      ? { mode: "external" as const, url: input.previewUrl }
      : { mode: "managed" as const, command: input.previewCommand ?? suggestion?.commands.preview.value ?? "npm run dev", port: input.previewPort ?? suggestion?.commands.port ?? 4321 };
  const settings = {
    code_source_id: source.id,
    branch,
    root_directory: input.root ?? suggestion?.root ?? "",
    framework: input.framework ?? suggestion?.framework.value ?? null,
    install_command: input.install ?? suggestion?.commands.install.value ?? "npm install",
    preview,
    build: { command: build, output_directory: input.output ?? suggestion?.commands.output?.value ?? "dist" },
  };
  const op = operation(api.session, "website.connect", [source.id, branch, settings]);
  const raw = await api.json("POST", "website/connect", { body: { request_id: op.id, ...settings }, signal: AbortSignal.timeout(300_000) });
  const result = read(z.looseObject({ status: z.string(), steps: z.array(z.looseObject({ id: z.string(), status: z.string(), message: z.string().optional() })), website: z.unknown() }), raw, "website connect");
  if (result.status === "failed") {
    const failed = result.steps.find((step) => step.status === "failed");
    throw new CliError("website_connect_failed", `Setting up the website failed${failed ? ` at ${failed.id}: ${failed.message ?? "unknown error"}` : "."}`, {
      details: { steps: result.steps },
      fix: "Fix the cause and run the same command again; finished steps are kept.",
    });
  }
  op.done();
  return { status: result.status, repository: `${source.owner}/${source.repo}`, settings, steps: result.steps, website: result.website };
}
