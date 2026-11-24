/**
 * Which coding agent runs the CLI, sent as `X-AtMyApp-Agent` and shown in
 * approval requests and credential lists ("last used via Claude Code").
 * Advisory only: nothing authorizes on it (CliEverywherePlan §4.3.6).
 *
 * Only variables confirmed for a tool are listed. Any other tool, or a person,
 * can name itself with ATMYAPP_AGENT.
 */
export const AGENT_ENV = "ATMYAPP_AGENT";

const KNOWN_AGENTS: ReadonlyArray<{ name: string; detect: (env: Record<string, string | undefined>) => boolean }> = [
  // Confirmed 2026-11-24: Claude Code sets CLAUDECODE=1 in the shells it runs.
  { name: "Claude Code", detect: (env) => env.CLAUDECODE === "1" },
];

/** A short label, or undefined when no agent is detected. Never includes other env values. */
export function detectAgent(env: Record<string, string | undefined>): string | undefined {
  const explicit = env[AGENT_ENV]?.trim();
  if (explicit) return explicit.replace(/[^\w .()/-]/g, "").slice(0, 60) || undefined;
  return KNOWN_AGENTS.find((agent) => agent.detect(env))?.name;
}
