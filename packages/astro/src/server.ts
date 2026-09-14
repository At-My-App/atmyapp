import defaults from "virtual:atmyapp/config";
import { getSecret } from "astro:env/server";
import {
  createAtMyAppClient,
  type AtMyAppClientOptions,
  type AtMyAppClient,
  type CanonicalSchemaInput,
} from "@atmyapp/core";
import {
  ENV_KEYS,
  resolveClientOptions,
  type AstroClientOptions,
} from "./config.js";
export type AtMyAppContext = { url: URL; locals: object; site?: URL };
const contexts = new WeakMap<
  object,
  { options: AtMyAppClientOptions; client: AtMyAppClient<any, any> }[]
>();
const buildClients: {
  options: AtMyAppClientOptions;
  client: AtMyAppClient<any, any>;
}[] = [];
export function getAtMyApp<const T extends CanonicalSchemaInput>(
  context: AtMyAppContext,
  options: AstroClientOptions & { schema: T },
): AtMyAppClient<T, true>;
export function getAtMyApp(
  context: AtMyAppContext,
  options?: AstroClientOptions,
): AtMyAppClient;
export function getAtMyApp(
  context: AtMyAppContext,
  overrides: AstroClientOptions = {},
): AtMyAppClient<any, any> {
  const env = { ...defaults.env };
  if (defaults.dynamic)
    for (const key of ENV_KEYS) {
      const value = getSecret(key);
      if (value !== undefined) env[key] = value;
    }
  const options = resolveClientOptions(
    env,
    context.url,
    defaults.dynamic,
    overrides,
  );
  let entries = defaults.dynamic ? contexts.get(context.locals) : buildClients;
  if (!entries) {
    entries = [];
    contexts.set(context.locals, entries);
  }
  const existing = entries.find(
    (entry) =>
      Object.keys(options).length === Object.keys(entry.options).length &&
      Object.entries(options).every(
        ([key, value]) =>
          entry.options[key as keyof AtMyAppClientOptions] === value,
      ),
  );
  if (existing) return existing.client;
  const fetchImpl = options.customFetch ?? fetch;
  let previewValidation: Promise<void> | undefined;
  const client = createAtMyAppClient({
    ...options,
    customFetch: async (input, init) => {
      if (options.previewKey && !String(input).endsWith("/diagnostics")) {
        previewValidation ??= (async () => {
          const report = await createAtMyAppClient({
            ...options,
            customFetch: fetchImpl,
          }).diagnostics.report();
          if (report.checks.preview.status !== "passed")
            throw new Error(
              "AtMyApp: preview access could not be verified. Reopen the preview from AtMyApp.",
            );
        })();
        await previewValidation;
      }
      return fetchImpl(input, init);
    },
  });
  entries.push({ options, client });
  return client;
}
export function getAtMyAppConfiguration(
  context: AtMyAppContext,
  overrides: AstroClientOptions = {},
) {
  const env = { ...defaults.env };
  if (defaults.dynamic)
    for (const key of ENV_KEYS) {
      const value = getSecret(key);
      if (value !== undefined) env[key] = value;
    }
  const options = resolveClientOptions(
    env,
    context.url,
    defaults.dynamic,
    overrides,
  );
  return {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    previewKey: options.previewKey ?? null,
    preview: !!options.previewKey,
    dynamic: defaults.dynamic,
  };
}

export { fetchWebsiteMetadataOnce } from "./websiteMetadata.js";
export type { AstroClientOptions } from "./config.js";
