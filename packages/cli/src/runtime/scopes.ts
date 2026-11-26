import { CliError, EXIT } from "./errors";

/**
 * The CLI's copy of the scope list and presets in ama-shared
 * `lib/access/cliScopes.ts` (CliEverywherePlan §4.2). The server is the
 * authority; this copy only shapes requests and help text. Keep the two in
 * step: tests/__tests__/scopes.test.ts pins the values.
 */
export const PERSONAL_SCOPES = [
  "schema.read", "content.read", "content.stage", "content.publish", "schema.push", "snapshot",
  "forms.tail", "hosting.read", "hosting.deploy", "keys.manage",
  "hosting.logs", "project.read", "account.read", "projects.create",
  "forms.read", "forms.triage", "insights.read", "insights.manage", "preview.manage",
  "hosting.manage", "code.manage", "settings.manage", "forms.manage", "team.invite", "team.manage",
  "code.read", "code.write",
] as const;
export type PersonalScope = (typeof PERSONAL_SCOPES)[number];

/** What project keys may hold (CI and servers). */
export const PROJECT_KEY_SCOPES = [
  "schema.read", "content.read", "content.stage", "schema.push", "snapshot",
  "forms.tail", "content.publish", "hosting.read", "hosting.deploy", "hosting.logs", "project.read",
  "forms.read", "forms.triage", "insights.read", "insights.manage", "preview.manage",
  "hosting.manage", "settings.manage", "forms.manage", "code.read", "code.write",
] as const;

const READ_ONLY: PersonalScope[] = ["schema.read", "content.read", "hosting.read", "project.read", "account.read", "forms.read", "insights.read"];

export const LOGIN_PRESETS = {
  everything: [...PERSONAL_SCOPES],
  developer: PERSONAL_SCOPES.filter((scope) => !scope.startsWith("team.") && scope !== "keys.manage"),
  editor: ["schema.read", "content.read", "content.stage", "content.publish", "forms.read", "forms.triage", "insights.read", "project.read"] as PersonalScope[],
  "read-only": READ_ONLY,
} as const;
export type LoginPreset = keyof typeof LOGIN_PRESETS;

export const KEY_PRESETS = {
  "ci-deploy": ["schema.push", "content.read", "hosting.deploy", "code.read"],
  "ci-content": ["schema.read", "content.read"],
  "forms-feed": ["forms.tail"],
  "read-only": ["schema.read", "content.read", "hosting.read", "project.read", "forms.read", "insights.read"],
} as const;
export type KeyPreset = keyof typeof KEY_PRESETS;

function choose<T extends string>(kind: string, value: string, options: readonly T[]): T {
  if (!(options as readonly string[]).includes(value)) {
    throw new CliError("invalid_preset", `Choose a ${kind} preset: ${options.join(", ")}.`, { exitCode: EXIT.usage });
  }
  return value as T;
}

/** `--preset` or `--scopes` for `atmyapp login`; without either, Read only (§4.2.3). */
export function loginScopes(options: { preset?: string; scopes?: string }): { scopes: string[]; preset: LoginPreset | null } {
  if (options.preset && options.scopes) {
    throw new CliError("invalid_options", "Pass --preset or --scopes, not both.", { exitCode: EXIT.usage });
  }
  if (options.scopes) return { scopes: parseScopeList(options.scopes, PERSONAL_SCOPES), preset: null };
  const preset = choose("login", options.preset ?? "read-only", Object.keys(LOGIN_PRESETS) as LoginPreset[]);
  return { scopes: [...LOGIN_PRESETS[preset]], preset };
}

/** `--preset` or `--scopes` for `atmyapp keys create`. */
export function keyScopes(options: { preset?: string; scopes?: string }): string[] | undefined {
  if (options.preset && options.scopes) {
    throw new CliError("invalid_options", "Pass --preset or --scopes, not both.", { exitCode: EXIT.usage });
  }
  if (options.scopes) return parseScopeList(options.scopes, PROJECT_KEY_SCOPES);
  if (!options.preset) return undefined;
  return [...KEY_PRESETS[choose("key", options.preset, Object.keys(KEY_PRESETS) as KeyPreset[])]];
}

export function parseScopeList(input: string, accepted: readonly string[]): string[] {
  const requested = input.trim().split(/[,\s]+/).filter(Boolean);
  if (!requested.length || requested.some((scope) => !accepted.includes(scope))) {
    throw new CliError("invalid_scopes", "Choose scopes from " + accepted.join(", ") + ".", { exitCode: EXIT.usage });
  }
  return [...new Set(requested)];
}
