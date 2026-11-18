import {
  AtMyAppClient,
  AtMyAppClientOptions,
  CanonicalSchemaInput,
  ClientMode,
} from "./clientTypes";

import { createDiagnosticsClient } from "./diagnostics";

import { createStorageClient } from "./storage";
import { createAnalyticsClient } from "./analytics";
import { createCollectionsClient } from "./collections";
import { createSystemConfigClient } from "./systemConfig";
import { createSubmissionsClient } from "./submissions";
import { createLocalizationClient } from "./localization";

const CLIENT_MODES: ReadonlyArray<ClientMode> = ["online", "with-fallback", "local"];

/**
 * ATMYAPP_CLIENT_MODE overrides `clientMode`, so `ATMYAPP_CLIENT_MODE=local
 * npm run dev` renders the local copy (and a space's drafts) without a code
 * change. Only read where `process` exists; browsers keep the option as is.
 */
export function resolveClientOptions(options: AtMyAppClientOptions): AtMyAppClientOptions {
  const fromEnv =
    typeof process !== "undefined" && typeof process.env === "object"
      ? process.env.ATMYAPP_CLIENT_MODE?.trim()
      : undefined;
  if (!fromEnv || !CLIENT_MODES.includes(fromEnv as ClientMode)) return options;
  return { ...options, clientMode: fromEnv as ClientMode };
}

export function createAtMyAppClient<const TSchema extends CanonicalSchemaInput>(
  options: Omit<AtMyAppClientOptions, "schema"> & { schema: TSchema },
): AtMyAppClient<TSchema, true>;
export function createAtMyAppClient<TSchema = unknown>(
  options: AtMyAppClientOptions,
): AtMyAppClient<TSchema, false>;
export function createAtMyAppClient<TSchema = unknown>(
  input: AtMyAppClientOptions,
): AtMyAppClient<TSchema, boolean> {
  const options = resolveClientOptions(input);
  return {
    diagnostics: createDiagnosticsClient(options),
    storage: createStorageClient(options) as any,
    analytics: createAnalyticsClient<TSchema>(options),
    collections: createCollectionsClient<TSchema>(options),
    submissions: createSubmissionsClient<TSchema>(options),
    systemConfig: createSystemConfigClient(options),
    localization: createLocalizationClient(options),
  } as AtMyAppClient<TSchema, boolean>;
}
