export type AtMyAppConfigArgs = Record<string, unknown>;

export type AtMyAppConfig = {
  include?: string[];
  description?: string;
  args?: AtMyAppConfigArgs;
  metadata?: Record<string, unknown>;
};
