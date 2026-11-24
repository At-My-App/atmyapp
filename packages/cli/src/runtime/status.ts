import { z } from "zod";
import type { ApiClient } from "./api";
import { isPersonalCredential } from "./auth";
import { listDomains, showDomain } from "./domains";
import { CliError } from "./errors";
import { hostingStatus } from "./hosting";
import { listNamedSessions } from "./sessions";

/**
 * `atmyapp status`: one overview of the project for an agent (CliEverywherePlan
 * §5.2 CLI 5). Each part is read with the credential's own scopes; a part it
 * can't read says so instead of failing the whole command.
 */

const unavailableSchema = z.object({ available: z.literal(false), reason: z.string() });
const part = <T extends z.ZodType>(schema: T) => z.union([schema, unavailableSchema]);

export const statusResultSchema = z.object({
  project: z.object({ id: z.string(), credential: z.enum(["personal", "projectKey"]) }),
  websites: part(z.object({
    available: z.literal(true),
    items: z.array(z.object({
      id: z.string(), name: z.string(), liveReleaseId: z.string().nullable(), publication: z.string().nullable(),
      autoPromote: z.boolean().nullable(),
    })),
  })),
  domains: part(z.object({
    available: z.literal(true),
    items: z.array(z.object({ hostname: z.string(), phase: z.string(), summary: z.string(), next: z.string().nullable() })),
  })),
  drafts: part(z.object({
    available: z.literal(true),
    items: z.array(z.object({ id: z.string(), name: z.string(), reviewState: z.string(), itemCount: z.number(), owner: z.string() })),
  })),
  /** What to do next, as commands. */
  next: z.array(z.object({ why: z.string(), command: z.string() })),
});
export type StatusResult = z.infer<typeof statusResultSchema>;

/** A part this credential may not read becomes `{ available: false }`; other errors still fail. */
async function optional<T>(read: () => Promise<T>): Promise<T | { available: false; reason: string }> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CliError && ["missing_scope", "keys_not_accepted", "forbidden", "key_stopped"].includes(error.code)) {
      return { available: false, reason: error.message };
    }
    throw error;
  }
}

export async function projectStatus(api: ApiClient): Promise<StatusResult> {
  const [hosting, domains, drafts] = await Promise.all([
    optional(async () => {
      const result = await hostingStatus(api);
      const states = new Map(result.publication.websites.map((site) => [site.deploymentId, site.state]));
      return {
        available: true as const,
        items: result.deployments.map((deployment) => ({
          id: deployment.id,
          name: deployment.name,
          liveReleaseId: deployment.active_release_id ?? null,
          publication: states.get(deployment.id) ?? null,
          autoPromote: deployment.auto_promote_on_release ?? null,
        })),
      };
    }),
    optional(async () => {
      const { domains: rows } = await listDomains(api);
      const attention = rows.filter((row) => row.status !== "active" || row.issues.length || row.removalPending);
      // Only domains that need something are read in full.
      const items = await Promise.all(attention.slice(0, 10).map(async (row) => {
        const { setup } = await showDomain(api, row.id).catch(() => ({ setup: null }));
        return {
          hostname: row.hostname,
          phase: setup?.phase ?? row.status,
          summary: setup?.summary ?? row.status,
          next: setup?.nextSteps[0] ?? null,
        };
      }));
      return { available: true as const, items };
    }),
    optional(async () => ({
      available: true as const,
      items: (await listNamedSessions(api)).filter((session) => session.status === "active").map((session) => ({
        id: session.sessionId, name: session.name, reviewState: session.reviewState, itemCount: session.itemCount, owner: session.owner.displayName,
      })),
    })),
  ]);

  const next: StatusResult["next"] = [];
  if (hosting.available && !hosting.items.length) {
    next.push({ why: "No website is connected yet.", command: "Connect one in the dashboard (Website → Connect); the CLI gets this later." });
  }
  if (hosting.available) {
    for (const site of hosting.items.filter((item) => !item.liveReleaseId)) {
      next.push({ why: `${site.name} has no live release.`, command: `atmyapp hosting deploy --deployment ${site.id} --wait` });
    }
  }
  if (domains.available) {
    for (const domain of domains.items) next.push({ why: `${domain.hostname}: ${domain.summary}`, command: `atmyapp domains show ${domain.hostname}` });
  }
  if (drafts.available) {
    for (const draft of drafts.items.filter((item) => item.reviewState === "sent_back")) {
      next.push({ why: `Draft '${draft.name}' was sent back.`, command: "atmyapp stage status" });
    }
  }
  return {
    project: { id: api.session.projectId, credential: isPersonalCredential(api.session.token) ? "personal" : "projectKey" },
    websites: hosting,
    domains,
    drafts,
    next,
  };
}
