import { createAtMyAppClient } from "./client/client";
import { F } from "./client/collections/filter-dsl";
import { AmaCollectionDef, AmaCollection } from "./definitions/AmaCollection";

export { createAtMyAppClient } from "./client/client";
export type {
  AtMyAppClient,
  AtMyAppClientOptions,
  CanonicalSchemaInput,
  StorageGetOptions,
  StorageAssetValue,
  SchemaStorageKey,
  CollectionsClient,
  CollectionsListOptions,
  CollectionsFilterExpr,
  CollectionsResponse,
  ClientMode,
  ClientErrorPolicy,
  SubmissionsClient,
  SubmissionFormParams,
  SubmissionFormEncType,
  SubmissionSubmitOptions,
  SubmissionSubmitResult,
  SubmissionTypeStatus,
  SubmissionReportStep,
  SubmissionReport,
  SubmissionResult,
  SubmissionValidationResult,
  SubmissionUploadProgress,
  SubmissionCaptchaProvider,
  SubmissionCaptcha,
  SubmissionCaptchaWidget,
  LocalDataSource,
  LocalDataSourceEntry,
  LocalStorageOptions,
  LocaleStatus,
  LocalizationStatus,
  CollectionLocalizationSummary,
  LocalizationDiscovery,
  LocalizationClient,
} from "./client/clientTypes";
export type {
  SystemConfigClient,
  SystemConfigGetInput,
  SystemConfigResponse,
} from "./client/systemConfig";
export type { AtMyAppConfig, AtMyAppConfigArgs } from "./client/configTypes";
export { createCollectionsClient } from "./client/collections";
export type {
  SubmissionErrorCode,
  SubmissionFieldErrorCode,
  SubmissionFieldErrors,
} from "./client/submissionError";
export {
  createSubmissionsClient,
  SubmissionError,
  captchaWidget,
  SUBMISSION_HONEYPOT_FIELD,
  SUBMISSION_RENDERED_AT_FIELD,
} from "./client/submissions";
export { F as CollectionsFilter } from "./client/collections/filter-dsl";

export type { AmaContent, AmaContentDef } from "./definitions/AmaContent";
export type {
  AmaCustomEvent,
  AmaCustomEventDef,
} from "./definitions/AmaCustomEvent";
export type { AmaEvent, AmaEventDef } from "./definitions/AmaEvent";
export type { AmaFile, AmaFileDef } from "./definitions/AmaFile";
export type { AmaImage, AmaImageDef } from "./definitions/AmaImage";
export type { AmaIcon, AmaIconDef } from "./definitions/AmaIcon";
export type {
  AmaComponentDef,
  AmaMdxConfigDef,
  AmaMdxFieldDef,
} from "./definitions/AmaMdx";
export type {
  AmaCollection,
  AmaCollectionDef,
} from "./definitions/AmaCollection";
export * from "@atmyapp/structure";

export {
  createDiagnosticsHandler,
  DIAGNOSTICS_PATH,
} from "./client/diagnostics";
export type {
  IntegrationReport,
  DiagnosticCheck,
  DiagnosticStatus,
  DiagnosticsOptions,
} from "./client/diagnostics";
