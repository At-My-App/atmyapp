import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ApiClient } from "./api";
import { CliError, EXIT, stillPending } from "./errors";

/**
 * Project settings from the CLI (CliEverywherePlan §5.5 4c): languages,
 * image policy, SEO settings (read; they're content, changed with `content`
 * and `stage`), collection labels and editor hints, and forms (4d).
 */

const timeout = () => AbortSignal.timeout(30_000);
type Row = Record<string, unknown>;

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

/** A JSON file, for `--file`. */
export function jsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError("invalid_file", `Couldn't read JSON from ${file}: ${error instanceof Error ? error.message : String(error)}`, { exitCode: EXIT.usage });
  }
}

// --- Languages ---------------------------------------------------------------------

const localizationSchema = z.looseObject({ defaultLocale: z.string(), supportedLocales: z.array(z.string()) });
export type Localization = z.infer<typeof localizationSchema>;

const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function locale(value: string): string {
  if (!LOCALE.test(value.trim())) throw new CliError("invalid_locale", `'${value}' isn't a language code such as de or pt-BR.`, { exitCode: EXIT.usage });
  return value.trim();
}

export async function localization(api: ApiClient): Promise<Localization> {
  return read(localizationSchema, await api.json("GET", "localization", { signal: timeout() }), "localization");
}

/** The server's refusals, with what to do about them. */
function localeError(error: unknown): never {
  if (error instanceof CliError) {
    const message = error.message;
    if (/LOCALE_CLEANUP_IN_PROGRESS/.test(message)) {
      throw new CliError("locale_cleanup_in_progress", "Translations of a removed language are still being cleaned up.", {
        exitCode: EXIT.conflict, fix: "Wait for it with 'atmyapp locales jobs', then try again.",
      });
    }
    if (/DEFAULT_LOCALE_MIGRATION_REQUIRED/.test(message)) {
      throw new CliError("default_locale", "That's the default language.", { exitCode: EXIT.usage, fix: "Choose another default first with 'atmyapp locales default <code>'." });
    }
    if (/LOCALIZATION_NOT_CONFIGURED/.test(message)) {
      throw new CliError("localization_not_configured", "This project has no languages set up yet.", { fix: "Set them up once in the dashboard: Settings → Languages." });
    }
    if (/draft/i.test(message) && error.status === 409) {
      throw new CliError("pending_drafts", message, { exitCode: EXIT.conflict, details: error.details, fix: "Publish or discard the open drafts first ('atmyapp stage ls')." });
    }
  }
  throw error;
}

export const localeChangeSchema = z.object({ locale: z.string(), unchanged: z.boolean(), localization: z.unknown() });

/** Adds a language; safe to run twice. */
export async function addLocale(api: ApiClient, code: string) {
  const wanted = locale(code);
  const current = await localization(api);
  if (current.supportedLocales.some((existing) => existing.toLowerCase() === wanted.toLowerCase())) {
    return { locale: wanted, unchanged: true, localization: current };
  }
  const result = await api.json("POST", "localization/locales", { body: { locale: wanted }, signal: timeout() }).catch(localeError);
  return { locale: wanted, unchanged: false, localization: result };
}

export async function setDefaultLocale(api: ApiClient, code: string) {
  const wanted = locale(code);
  const current = await localization(api);
  if (current.defaultLocale.toLowerCase() === wanted.toLowerCase()) return { locale: wanted, unchanged: true, localization: current };
  if (!current.supportedLocales.some((existing) => existing.toLowerCase() === wanted.toLowerCase())) {
    throw new CliError("locale_not_supported", `${wanted} isn't one of this project's languages.`, { exitCode: EXIT.usage, fix: `Add it first with 'atmyapp locales add ${wanted}'.` });
  }
  const result = await api.json("PUT", "localization", { body: { ...current, defaultLocale: wanted }, signal: timeout() }).catch(localeError);
  return { locale: wanted, unchanged: false, localization: result };
}

const jobSchema = z.looseObject({ id: z.string(), locale: z.string().optional(), status: z.string() });

export const localeRemoveSchema = z.object({
  locale: z.string(), removed: z.boolean(), job: z.looseObject({ id: z.string(), status: z.string() }).nullable(),
});

/**
 * Removes a language with the dedicated route: it starts a translation
 * cleanup job; `--wait` follows it. (A full localization update that drops a
 * language is refused on purpose.)
 */
export async function removeLocale(
  api: ApiClient,
  code: string,
  options: { wait?: boolean; timeoutMs?: number; ifExists?: boolean; pause?: (ms: number) => Promise<unknown>; onProgress?: (status: string) => void },
): Promise<z.infer<typeof localeRemoveSchema>> {
  const wanted = locale(code);
  const current = await localization(api);
  if (!current.supportedLocales.some((existing) => existing.toLowerCase() === wanted.toLowerCase())) {
    if (options.ifExists) return { locale: wanted, removed: false, job: null };
    throw new CliError("locale_not_supported", `${wanted} isn't one of this project's languages.`, { details: { locales: current.supportedLocales } });
  }
  let job = read(jobSchema, await api.json("DELETE", `localization/locales/${encodeURIComponent(wanted)}`, { signal: timeout() }).catch(localeError), "cleanup job");
  if (options.wait) job = await waitForCleanup(api, job, { ...options, locale: wanted });
  return { locale: wanted, removed: true, job };
}

export async function waitForCleanup(api: ApiClient, job: z.infer<typeof jobSchema>, options: { timeoutMs?: number; locale: string; pause?: (ms: number) => Promise<unknown>; onProgress?: (status: string) => void }) {
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  let current = job;
  let last = "";
  for (;;) {
    if (current.status !== last) {
      last = current.status;
      options.onProgress?.(last);
    }
    if (["completed", "succeeded", "done"].includes(current.status)) return current;
    if (current.status === "failed") {
      throw new CliError("locale_cleanup_failed", `Cleaning up ${options.locale} translations failed${typeof current.error === "string" ? `: ${current.error}` : "."}`, {
        details: { jobId: current.id, job: current },
        fix: `Retry it in the dashboard (Settings → Languages), or with 'atmyapp locales jobs --retry ${current.id}'.`,
      });
    }
    if (Date.now() >= deadline) {
      throw stillPending("locale_cleanup_timeout", `Cleaning up ${options.locale} translations is still running.`, { state: current.status, resume: `atmyapp locales jobs ${current.id} --wait` });
    }
    await (options.pause ?? delay)(3000);
    current = read(jobSchema, await api.json("GET", `localization/cleanup-jobs/${encodeURIComponent(current.id)}`, { signal: timeout() }), "cleanup job");
  }
}

export async function cleanupJobs(api: ApiClient, jobId: string | undefined, options: { wait?: boolean; retry?: boolean; timeoutMs?: number; onProgress?: (status: string) => void }) {
  if (!jobId) {
    return { jobs: read(z.array(jobSchema), await api.json("GET", "localization/cleanup-jobs", { signal: timeout() }), "cleanup jobs") };
  }
  if (options.retry) await api.json("POST", `localization/cleanup-jobs/${encodeURIComponent(jobId)}/retry`, { body: {}, signal: timeout() });
  let job = read(jobSchema, await api.json("GET", `localization/cleanup-jobs/${encodeURIComponent(jobId)}`, { signal: timeout() }), "cleanup job");
  if (options.wait) job = await waitForCleanup(api, job, { ...options, locale: job.locale ?? "the language" });
  return { jobs: [job] };
}

// --- Image policy and SEO --------------------------------------------------------------

export async function imagePolicy(api: ApiClient) {
  return { imagePolicy: await api.json("GET", "image-policy", { signal: timeout() }) };
}

export async function setImagePolicy(api: ApiClient, file: string) {
  const body = jsonFile(file);
  return { imagePolicy: await api.json("PUT", "image-policy", { body, signal: timeout() }) };
}

/** SEO settings as published. Change them like content: `content edit`, then `stage push` and `stage commit`. */
export async function seoSettings(api: ApiClient) {
  return { seo: await api.json("GET", "system-config/website.metadata", { signal: timeout() }) };
}

// --- Collections -------------------------------------------------------------------------

export const collectionEditSchema = z.object({ collection: z.string(), metadata: z.unknown().nullable(), hints: z.unknown().nullable() });

/** Labels, description and editor hints of a collection. */
export async function editCollection(api: ApiClient, name: string, input: { label?: string; description?: string; hints?: string; branch?: string }) {
  if (!/^[\w-]{1,100}$/.test(name)) throw new CliError("invalid_argument", `Invalid collection name '${name}'.`, { exitCode: EXIT.usage });
  const branch = input.branch ?? "main";
  const metadata = Object.fromEntries(Object.entries({ label: input.label, description: input.description }).filter(([, value]) => value !== undefined));
  if (!Object.keys(metadata).length && !input.hints) {
    throw new CliError("invalid_options", "Say what to change: --label, --description or --hints <file>.", { exitCode: EXIT.usage });
  }
  const route = `collections/${encodeURIComponent(name)}`;
  const saved = Object.keys(metadata).length
    ? await api.json("PUT", `${route}/metadata`, { query: { branch }, body: metadata, signal: timeout() })
    : null;
  const hints = input.hints
    ? await api.json("PUT", `${route}/ui-hints`, { query: { branch }, body: jsonFile(input.hints), signal: timeout() })
    : null;
  return { collection: name, metadata: saved, hints };
}

// --- Forms ---------------------------------------------------------------------------------

export const formSchema = z.object({ type: z.string(), acceptingResponses: z.boolean(), formUrl: z.string().nullable() });
export type Form = z.infer<typeof formSchema>;

function toForm(row: Row): Form {
  return { type: String(row.type), acceptingResponses: row.acceptingResponses !== false, formUrl: typeof row.formUrl === "string" ? row.formUrl : null };
}

const FORM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export async function listForms(api: ApiClient): Promise<{ forms: Form[] }> {
  return { forms: read(z.array(z.looseObject({ type: z.string() })), await api.json("GET", "submissions/types", { signal: timeout() }), "form list").map(toForm) };
}

export interface FormInput {
  accepting?: boolean;
  file?: string;
}

function formBody(input: FormInput) {
  const fromFile = input.file ? (jsonFile(input.file) as Record<string, unknown>) : {};
  return { ...fromFile, ...(input.accepting !== undefined ? { acceptingResponses: input.accepting } : {}) };
}

/** Creates a form; safe to run twice by name. */
export async function createForm(api: ApiClient, type: string, input: FormInput) {
  if (!FORM_NAME.test(type)) throw new CliError("invalid_name", "Use 1–64 letters, numbers, dashes or underscores, starting with a letter or number.", { exitCode: EXIT.usage });
  const existing = (await listForms(api)).forms.find((form) => form.type === type);
  if (existing) return { form: existing, unchanged: true };
  const raw = await api.json("POST", "submissions/types", { body: { type, ...formBody(input) }, signal: timeout() });
  return { form: toForm((raw ?? { type }) as Row), unchanged: false };
}

export async function editForm(api: ApiClient, type: string, input: FormInput) {
  const body = formBody(input);
  if (!Object.keys(body).length) throw new CliError("invalid_options", "Say what to change: --accepting on|off or --file <json>.", { exitCode: EXIT.usage });
  const raw = await api.json("PUT", `submissions/types/${encodeURIComponent(type)}`, { body, signal: timeout() });
  return { form: toForm((raw ?? { type }) as Row) };
}

export async function removeForm(api: ApiClient, type: string, options: { ifExists?: boolean }) {
  const exists = (await listForms(api)).forms.some((form) => form.type === type);
  if (!exists) {
    if (options.ifExists) return { type, removed: false };
    throw new CliError("form_not_found", `No form '${type}' in this project.`, { fix: "Run 'atmyapp forms ls'." });
  }
  await api.json("DELETE", `submissions/types/${encodeURIComponent(type)}`, { signal: timeout() });
  return { type, removed: true };
}

/** The form's layout: show it, replace it from a file, reset it, or have it generated. */
export async function formLayout(api: ApiClient, type: string, input: { file?: string; reset?: boolean; generate?: boolean; instructions?: string }) {
  const route = `submissions/types/${encodeURIComponent(type)}/layout`;
  const chosen = [input.file, input.reset, input.generate].filter(Boolean).length;
  if (chosen > 1) throw new CliError("invalid_options", "Choose one of --file, --reset or --generate.", { exitCode: EXIT.usage });
  if (input.file) return { layout: await api.json("PUT", route, { body: jsonFile(input.file), signal: timeout() }) };
  if (input.reset) return { layout: await api.json("DELETE", route, { signal: timeout() }) };
  if (input.generate) {
    return { layout: await api.json("POST", `${route}/generate`, { body: { instructions: input.instructions }, signal: AbortSignal.timeout(120_000) }) };
  }
  return { layout: await api.json("GET", route, { signal: timeout() }) };
}

/** Checks captcha keys before a form uses them. The secret comes from stdin or an environment variable. */
export async function verifyCaptcha(api: ApiClient, input: { provider: string; siteKey: string; secret: string }) {
  return { result: await api.json("POST", "submissions/captcha/verify", { body: { provider: input.provider, siteKey: input.siteKey, secret: input.secret }, signal: timeout() }) };
}
