import {
  AtMyAppClient,
  AtMyAppClientOptions,
  CanonicalSchemaInput,
} from "./clientTypes";

import { createStorageClient } from "./storage";
import { createAnalyticsClient } from "./analytics";
import { createCollectionsClient } from "./collections";
import { createSystemConfigClient } from "./systemConfig";
import { createSubmissionsClient } from "./submissions";
import { createLocalizationClient } from "./localization";

export function createAtMyAppClient<const TSchema extends CanonicalSchemaInput>(
  options: Omit<AtMyAppClientOptions, "schema"> & { schema: TSchema },
): AtMyAppClient<TSchema, true>;
export function createAtMyAppClient<TSchema = unknown>(
  options: AtMyAppClientOptions,
): AtMyAppClient<TSchema, false>;
export function createAtMyAppClient<TSchema = unknown>(
  options: AtMyAppClientOptions,
): AtMyAppClient<TSchema, boolean> {
  return {
    storage: createStorageClient(options) as any,
    analytics: createAnalyticsClient<TSchema>(options),
    collections: createCollectionsClient<TSchema>(options),
    submissions: createSubmissionsClient<TSchema>(options),
    systemConfig: createSystemConfigClient(options),
    localization: createLocalizationClient(options),
  } as AtMyAppClient<TSchema, boolean>;
}
