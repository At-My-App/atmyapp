import { CliError, EXIT } from "./errors";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export interface DurationLimits {
  min: number;
  max: number;
}

function describe(ms: number): string {
  if (ms >= UNIT_MS.d && ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d}d`;
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`;
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * `90s`, `5m`, `1h`, `7d` (a bare number means seconds) within `limits`. Every
 * `--timeout` uses this, so they accept the same values (CliEverywherePlan §4.3.3).
 */
export function parseDuration(value: string, limits: DurationLimits, example = "5m"): number {
  const match = /^(\d+)(s|m|h|d)?$/i.exec(value.trim());
  const ms = match ? Number(match[1]) * UNIT_MS[(match[2]?.toLowerCase() ?? "s") as keyof typeof UNIT_MS] : 0;
  if (ms < limits.min || ms > limits.max) {
    throw new CliError(
      "invalid_timeout",
      `Use a timeout between ${describe(limits.min)} and ${describe(limits.max)}, such as ${example}.`,
      { exitCode: EXIT.usage },
    );
  }
  return ms;
}

/** Default and longest wait per kind of work (CliEverywherePlan §4.3.3). */
export const WAITS = {
  deploy: { default: 15 * UNIT_MS.m, min: 5 * UNIT_MS.s, max: UNIT_MS.h, example: "15m" },
  promote: { default: 2 * UNIT_MS.m, min: 5 * UNIT_MS.s, max: 15 * UNIT_MS.m, example: "2m" },
  preview: { default: 3 * UNIT_MS.m, min: 5 * UNIT_MS.s, max: 15 * UNIT_MS.m, example: "3m" },
  domain: { default: 20 * UNIT_MS.m, min: 5 * UNIT_MS.s, max: UNIT_MS.h, example: "20m" },
  approval: { default: 3 * UNIT_MS.m, min: 5 * UNIT_MS.s, max: 15 * UNIT_MS.m, example: "3m" },
} as const;

export type WaitKind = keyof typeof WAITS;

/** `--timeout` for a kind of work; its default when the flag is absent. */
export function waitTimeout(kind: WaitKind, value: string | undefined): number {
  const wait = WAITS[kind];
  return value === undefined ? wait.default : parseDuration(value, wait, wait.example);
}
