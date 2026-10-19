export interface Content {
  path: string;
  structure: any;
  type?: string;
}

export interface EventConfig {
  columns: string[];
  description?: string;
}

export interface SubmissionConfig {
  description?: string;
  fields: Record<string, unknown>;
  requiresCaptcha?: boolean;
  captchaProvider?: string;
}

export type OutputDefinition = import("@atmyapp/structure").SchemaDocument;

export interface MigrateOptions {
  dryRun: boolean;
  verbose: boolean;
}

export interface TypeTransformer {
  canTransform: (obj: any) => boolean;
  transform: (obj: any) => any;
}

export interface ProcessingResult {
  contents: Content[];
  errors: string[];
  successCount: number;
  failureCount: number;
}
