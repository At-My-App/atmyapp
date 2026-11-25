import { z } from "zod";
import type { ApiClient } from "./api";
import { CliError, EXIT } from "./errors";
import { operation } from "./operations";

/**
 * The project's team (`atmyapp members invite|role|rm`, `invitations`;
 * CliEverywherePlan §5.5 4d). A project's team is its organisation's: a
 * change applies to every project in it, and the CLI says so (E32).
 */

const timeout = () => AbortSignal.timeout(30_000);
export const ROLES = ["owner", "admin", "editor", "reviewer"] as const;

const organizationSchema = z.object({ id: z.string(), name: z.string(), projects: z.number() });
export const teamSchema = z.object({
  organization: organizationSchema,
  members: z.array(z.looseObject({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), role: z.string() })),
  invitations: z.array(z.looseObject({ id: z.string(), email: z.string(), role: z.string().nullable() })),
});
export type Team = z.infer<typeof teamSchema>;

function read<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", `The server returned an unexpected ${what} response.`);
  return parsed.data;
}

function role(value: string): (typeof ROLES)[number] {
  const wanted = value.trim().toLowerCase();
  if (!(ROLES as readonly string[]).includes(wanted)) throw new CliError("invalid_role", `Choose a role: ${ROLES.join(", ")}.`, { exitCode: EXIT.usage });
  return wanted as (typeof ROLES)[number];
}

/** "all 4 projects in Gamrot Studio": what a team change reaches. */
export function teamReach(organization: z.infer<typeof organizationSchema>): string {
  return organization.projects === 1 ? `the 1 project in ${organization.name}` : `all ${organization.projects} projects in ${organization.name}`;
}

export async function team(api: ApiClient): Promise<Team> {
  return read(teamSchema, await api.json("GET", "team", { signal: timeout() }), "team");
}

function member(current: Team, ref: string) {
  const wanted = ref.trim().toLowerCase();
  const found = current.members.find((item) => item.id === ref.trim() || item.email?.toLowerCase() === wanted);
  if (found) return found;
  throw new CliError("member_not_found", `No member '${ref}' in ${current.organization.name}.`, {
    exitCode: EXIT.usage, details: { members: current.members.map(({ id, name, email, role: memberRole }) => ({ id, name, email, role: memberRole })) },
  });
}

export const teamChangeSchema = z.object({
  organization: organizationSchema, change: z.string(), subject: z.string(), role: z.string().nullable(), unchanged: z.boolean(),
});

/** Invites someone; safe to run twice (a pending invitation with that role is reported unchanged). */
export async function inviteMember(api: ApiClient, email: string, roleName: string): Promise<z.infer<typeof teamChangeSchema>> {
  const wanted = role(roleName);
  const address = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new CliError("invalid_email", `'${email}' isn't an email address.`, { exitCode: EXIT.usage });
  const current = await team(api);
  if (current.members.some((item) => item.email?.toLowerCase() === address)) {
    throw new CliError("already_member", `${address} is already in ${current.organization.name}.`, {
      exitCode: EXIT.conflict, fix: `Change their role with 'atmyapp members role ${address} ${wanted}'.`,
    });
  }
  if (current.invitations.some((item) => item.email.toLowerCase() === address && item.role === wanted)) {
    return { organization: current.organization, change: "invite", subject: address, role: wanted, unchanged: true };
  }
  const op = operation(api.session, "team.invite", [address, wanted]);
  await api.json("POST", "team/invitations", { body: { email: address, role: wanted, requestId: op.id }, signal: timeout() });
  op.done();
  return { organization: current.organization, change: "invite", subject: address, role: wanted, unchanged: false };
}

export async function changeRole(api: ApiClient, ref: string, roleName: string) {
  const wanted = role(roleName);
  const current = await team(api);
  const found = member(current, ref);
  const subject = found.name ?? found.email ?? found.id;
  if (found.role === wanted) return { organization: current.organization, change: "role", subject, role: wanted, unchanged: true };
  const op = operation(api.session, "team.role", [found.id, wanted]);
  await api.json("PUT", `team/members/${encodeURIComponent(found.id)}`, { body: { role: wanted, requestId: op.id }, signal: timeout() });
  op.done();
  return { organization: current.organization, change: "role", subject, role: wanted, unchanged: false };
}

export async function removeMember(api: ApiClient, ref: string, options: { ifExists?: boolean }) {
  const current = await team(api);
  const wanted = ref.trim().toLowerCase();
  const found = current.members.find((item) => item.id === ref.trim() || item.email?.toLowerCase() === wanted);
  if (!found) {
    if (options.ifExists) return { organization: current.organization, change: "remove", subject: ref, role: null, unchanged: true };
    member(current, ref);
  }
  await api.json("DELETE", `team/members/${encodeURIComponent(found!.id)}`, { signal: timeout() });
  return { organization: current.organization, change: "remove", subject: found!.name ?? found!.email ?? found!.id, role: found!.role, unchanged: false };
}

export async function revokeInvitation(api: ApiClient, ref: string, options: { ifExists?: boolean }) {
  const current = await team(api);
  const wanted = ref.trim().toLowerCase();
  const found = current.invitations.find((item) => item.id === ref.trim() || item.email.toLowerCase() === wanted);
  if (!found) {
    if (options.ifExists) return { organization: current.organization, change: "revoke", subject: ref, role: null, unchanged: true };
    throw new CliError("invitation_not_found", `No pending invitation '${ref}'.`, { details: { invitations: current.invitations.map(({ id, email }) => ({ id, email })) } });
  }
  await api.json("DELETE", `team/invitations/${encodeURIComponent(found.id)}`, { signal: timeout() });
  return { organization: current.organization, change: "revoke", subject: found.email, role: found.role, unchanged: false };
}
