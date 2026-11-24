import { CliError, EXIT } from "./errors";

/** One field that differs between what exists and what was asked for. */
export interface Difference {
  current: unknown;
  wanted: unknown;
}

export interface EnsureSpec<Existing, Created> {
  /** What is being created, for messages: "domain", "website", "link". */
  kind: string;
  /** Its natural key, for messages: the hostname, the name, the code. */
  key: string;
  /** Looks the thing up by its natural key. */
  find: () => Promise<Existing | null>;
  /** Fields where the existing one differs from what was asked; empty when equal. */
  differences: (existing: Existing) => Record<string, Difference>;
  create: () => Promise<Created>;
  /** The command that changes an existing one, named in the conflict's fix. */
  editCommand: string;
}

export type EnsureResult<Existing, Created> =
  | { unchanged: true; existing: Existing }
  | { unchanged: false; created: Created };

/**
 * Create-or-confirm, so commands are safe to run twice (CliEverywherePlan
 * §4.3.4): the same thing again is a success with `unchanged: true`; something
 * different under the same key is `already_exists` (exit 5) with the
 * differences and the edit command.
 */
export async function ensure<Existing, Created>(spec: EnsureSpec<Existing, Created>): Promise<EnsureResult<Existing, Created>> {
  const existing = await spec.find();
  if (!existing) return { unchanged: false, created: await spec.create() };
  const differences = spec.differences(existing);
  if (!Object.keys(differences).length) return { unchanged: true, existing };
  throw new CliError("already_exists", `A ${spec.kind} '${spec.key}' already exists with different settings.`, {
    exitCode: EXIT.conflict,
    details: { kind: spec.kind, key: spec.key, differences },
    fix: `Change it with '${spec.editCommand}', or remove it first.`,
  });
}

/** `{ field: { current, wanted } }` for each wanted value that isn't already current. */
export function diffFields(current: Record<string, unknown>, wanted: Record<string, unknown>): Record<string, Difference> {
  const differences: Record<string, Difference> = {};
  for (const [field, value] of Object.entries(wanted)) {
    if (value === undefined) continue;
    if (JSON.stringify(current[field] ?? null) !== JSON.stringify(value ?? null)) differences[field] = { current: current[field] ?? null, wanted: value };
  }
  return differences;
}
