import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApiClient } from "./api";
import { ensure } from "./ensure";
import { CliError, EXIT, needsPerson } from "./errors";

/**
 * Account commands for personal credentials (CliEverywherePlan §5.2): list,
 * show and create projects, list organisations. The server filters every
 * answer by the credential's reach.
 */

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  organization: z.object({ id: z.string(), name: z.string() }),
  via: z.enum(["member", "partner"]),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  via: z.enum(["member", "partner"]).optional(),
  role: z.string().nullable().optional(),
});

export const destinationSchema = z.object({
  id: z.string(),
  name: z.string(),
  via: z.enum(["member", "partner"]),
  partner: z.object({ id: z.string(), name: z.string() }).nullable(),
  limitReached: z.boolean(),
});

export const projectListSchema = z.object({ projects: z.array(projectSummarySchema) });
export const projectShowSchema = z.object({ project: projectSummarySchema, effectiveScopes: z.array(z.string()) });
export const organizationListSchema = z.object({ organizations: z.array(organizationSchema), canCreateIn: z.array(destinationSchema).optional() });
export const projectCreateSchema = z.discriminatedUnion("dryRun", [
  z.object({ dryRun: z.literal(true), unchanged: z.boolean(), name: z.string(), organization: z.object({ id: z.string(), name: z.string() }) }),
  z.object({ dryRun: z.literal(false), unchanged: z.boolean(), project: z.object({ id: z.string(), name: z.string() }).loose() }),
]);
export const projectUseSchema = z.object({ projectId: z.string(), name: z.string(), sessionFile: z.string(), droppedKey: z.boolean() });

const timeout = () => AbortSignal.timeout(30_000);

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

/** Older servers don't have the account routes yet. */
function unsupported(error: unknown): never {
  if (error instanceof CliError && error.code === "not_found") {
    throw new CliError("not_supported_yet", "This server doesn't support project commands yet.", {
      fix: "Update the server, or use the dashboard for now.",
    });
  }
  throw error;
}

export async function listProjects(api: ApiClient): Promise<z.infer<typeof projectListSchema>> {
  const raw = await api.cliAuth("GET", "projects", { signal: timeout() }).catch(unsupported);
  return read(projectListSchema, raw, "project list");
}

/** A project by ID, or by name when exactly one project has it. */
export async function findProject(api: ApiClient, ref: string): Promise<ProjectSummary> {
  const { projects } = await listProjects(api);
  const wanted = ref.trim();
  const byId = projects.find((project) => project.id === wanted);
  if (byId) return byId;
  const byName = projects.filter((project) => project.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new CliError("project_ambiguous", `Several projects are called '${ref}'.`, {
      exitCode: EXIT.usage,
      details: { projects: byName.map(({ id, name, organization }) => ({ id, name, organization: organization.name })) },
      fix: "Use the project ID instead.",
    });
  }
  throw new CliError("project_not_found", `No project '${ref}' that this login can reach.`, {
    exitCode: EXIT.usage,
    details: { projects: projects.slice(0, 10).map(({ id, name }) => ({ id, name })) },
    fix: "Run 'atmyapp projects ls' to see the projects.",
  });
}

export async function showProject(api: ApiClient, ref: string): Promise<z.infer<typeof projectShowSchema>> {
  const project = await findProject(api, ref);
  const raw = await api.cliAuth("GET", `projects/${encodeURIComponent(project.id)}`, { signal: timeout() }).catch(unsupported);
  return read(projectShowSchema, raw, "project");
}

export async function listOrganizations(api: ApiClient, options: { canCreate?: boolean } = {}): Promise<z.infer<typeof organizationListSchema>> {
  const raw = await api.cliAuth("GET", "orgs", { signal: timeout() }).catch(unsupported);
  const result = read(organizationListSchema, raw, "organisation list");
  if (!options.canCreate) return result;
  return { ...result, canCreateIn: await creationDestinations(api) };
}

export async function creationDestinations(api: ApiClient) {
  const raw = await api.cliAuth("GET", "project-creation", { signal: timeout() }).catch(unsupported);
  return read(z.object({ destinations: z.array(destinationSchema) }), raw, "project creation").destinations;
}

/** The same request ID for the same project, so a retried create returns the first one. */
export function creationRequestId(orgId: string, name: string, projectId?: string): string {
  const hex = createHash("sha256").update(JSON.stringify([orgId, name.trim(), projectId ?? null])).digest("hex");
  // Shaped as a UUID (version 8, custom), which the server accepts.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const REFUSALS: Record<string, string> = {
  partner_quota: "Ask your partner organisation's owners, or contact AtMyApp.",
  staff_limit: "Contact AtMyApp to raise the limit.",
  creation_not_allowed: "Ask an owner or admin of the organisation.",
  credential_project_limit: "Run 'atmyapp login' again and choose organisation reach.",
};

/**
 * Creates a project; safe to run twice (§4.3.4): a project with the same name
 * (or ID) in that organisation is returned with `unchanged: true`.
 */
export async function createProject(
  api: ApiClient,
  input: { name: string; org: string; projectId?: string; dryRun?: boolean },
): Promise<z.infer<typeof projectCreateSchema>> {
  const name = input.name.trim();
  if (!name) throw new CliError("invalid_name", "Give the project a name.", { exitCode: EXIT.usage });
  const destinations = await creationDestinations(api);
  const wanted = input.org.trim().toLowerCase();
  const organization = destinations.find((destination) => destination.id === input.org.trim()) ??
    destinations.find((destination) => destination.name.toLowerCase() === wanted);
  if (!organization) {
    throw new CliError("organization_not_found", `You can't create projects in '${input.org}' with this login.`, {
      exitCode: EXIT.usage,
      details: { organizations: destinations.map(({ id, name: orgName }) => ({ id, name: orgName })) },
      fix: destinations.length
        ? "Choose one of the organisations listed in details ('atmyapp orgs ls --can-create')."
        : "This login can't create projects. Run 'atmyapp login --preset everything' and choose organisation or full reach.",
    });
  }
  const { projects } = await listProjects(api);
  // A project from an earlier, interrupted run counts first: it may have taken
  // the last slot, and a rerun must find it, not report the limit (§11.2 P2-5).
  const existing = projects.find((project) =>
    project.organization.id === organization.id && (input.projectId ? project.id === input.projectId : project.name === name));
  if (!existing && organization.limitReached) {
    throw needsPerson("dashboard", `${organization.partner?.name ?? organization.name} has reached its website limit.`, {
      fix: REFUSALS.partner_quota,
      details: { organization: organization.id },
    });
  }
  const outcome = await ensure({
    kind: "project",
    key: input.projectId ?? name,
    find: async () => existing ?? null,
    differences: () => ({}),
    create: async () => {
      if (input.dryRun) return null;
      try {
        return await api.cliAuth<Record<string, unknown>>("POST", "projects", {
          body: { name, orgId: organization.id, projectId: input.projectId, requestId: creationRequestId(organization.id, name, input.projectId) },
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        if (error instanceof CliError && REFUSALS[error.code]) {
          throw needsPerson("dashboard", error.message, { fix: REFUSALS[error.code], details: { ...error.details, code: error.code } });
        }
        throw error;
      }
    },
    editCommand: "atmyapp projects show " + (input.projectId ?? name),
  });
  if (input.dryRun) return { dryRun: true, unchanged: outcome.unchanged, name, organization: { id: organization.id, name: organization.name } };
  if (outcome.unchanged) return { dryRun: false, unchanged: true, project: { id: outcome.existing.id, name: outcome.existing.name } };
  return { dryRun: false, unchanged: false, project: read(z.object({ id: z.string(), name: z.string() }).loose(), outcome.created, "project") };
}
