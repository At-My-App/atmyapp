import { z } from "zod";
import type { ApiClient } from "./api";
import { CliError, EXIT, needsPerson, stillPending } from "./errors";
import { WAITS } from "./duration";
import { diffFields, ensure } from "./ensure";

/**
 * `atmyapp domains`: custom domains for hosted websites. Reading takes the
 * hosting.read scope; adding, editing, checking and removing take
 * hosting.deploy. Each result carries `setup`, a plain account of where the
 * domain stands and what to do next, so an agent never has to interpret raw
 * provider states.
 */

const recordSchema = z.object({
  type: z.enum(["CNAME", "TXT"]),
  purpose: z.enum(["routing", "certificate"]),
  name: z.string(),
  host: z.string(),
  value: z.string(),
  status: z.enum(["found", "missing", "wrong", "unknown"]),
  current: z.array(z.string()).optional(),
});
const issueSchema = z.object({ code: z.string(), message: z.string().optional(), values: z.array(z.string()).optional() });
const stepSchema = z.object({ state: z.enum(["done", "waiting", "action", "problem"]), since: z.string() });
const diagnosisSchema = z.looseObject({
  checkedAt: z.string(),
  records: z.array(recordSchema),
  certificateRecordsPending: z.boolean(),
  steps: z.object({ records: stepSchema, certificate: stepSchema }),
  certificate: z.looseObject({ status: z.string().nullish(), authority: z.string().nullish(), expiresOn: z.string().nullish() }),
  issues: z.array(issueSchema),
});

export const domainSummarySchema = z.object({
  id: z.string(),
  hostname: z.string(),
  status: z.string(),
  deploymentId: z.string().nullable(),
  // Servers before the domains API for keys list only the four fields above.
  deploymentName: z.string().nullable().default(null),
  routeStatus: z.string().nullable().default(null),
  removalPending: z.boolean().default(false),
  issues: z.array(z.string()).default([]),
  lastCheckedAt: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
});
export const domainDetailSchema = domainSummarySchema.extend({
  dnsTarget: z.string(),
  nextCheckAt: z.string().nullable(),
  assignment: z
    .object({
      deploymentId: z.string().nullable(),
      deploymentName: z.string().nullable(),
      routeStatus: z.string(),
      servingMode: z.string(),
      pinnedReleaseId: z.string().nullable(),
      spaFallback: z.boolean(),
      indexFallback: z.boolean(),
      fallback404Path: z.string().nullable(),
      release: z.object({ id: z.string(), status: z.string() }).nullable(),
    })
    .nullable(),
  diagnosis: diagnosisSchema.nullable(),
  debug: z.record(z.string(), z.unknown()),
});
export type DomainSummary = z.infer<typeof domainSummarySchema>;
export type DomainDetail = z.infer<typeof domainDetailSchema>;
export type DomainRecord = z.infer<typeof recordSchema>;

export const DOMAIN_PHASES = ["removing", "records", "certificate", "website", "live", "problem"] as const;
export type DomainPhase = (typeof DOMAIN_PHASES)[number];

const setupSchema = z.object({
  phase: z.enum(DOMAIN_PHASES),
  /** One sentence: where the domain stands. */
  summary: z.string(),
  /** Every record to add at the DNS provider; all of them are required. */
  records: z.array(recordSchema),
  /** Certificate records are on their way; run `domains show` again in a minute. */
  moreRecordsComing: z.boolean(),
  issues: z.array(z.object({ code: z.string(), message: z.string(), fix: z.string().optional() })),
  nextSteps: z.array(z.string()),
});
export type DomainSetup = z.infer<typeof setupSchema>;
export const domainResultSchema = z.object({ domain: domainDetailSchema, setup: setupSchema });
export type DomainResult = z.infer<typeof domainResultSchema>;
export const domainListSchema = z.object({ domains: z.array(domainSummarySchema) });
export const domainRemoveSchema = z.object({
  /** Null when `--if-exists` found nothing to remove. */
  id: z.string().nullable(), hostname: z.string(), dryRun: z.boolean(), removalPending: z.boolean(),
  /** False when there was nothing to remove (`--if-exists`). */
  removed: z.boolean(),
});

const deploymentSchema = z.object({ id: z.string(), name: z.string() });
const apiTimeout = () => AbortSignal.timeout(30_000);

function read<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliError("invalid_response", "The server returned an unexpected domain response.");
  return parsed.data;
}

/** `https://WWW.Example.com/` → `www.example.com`. */
export function normalizeHostname(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(value)) {
    throw new CliError("invalid_hostname", `'${input}' is not a valid domain name.`, {
      exitCode: EXIT.usage,
      fix: "Pass a full domain such as www.example.com.",
    });
  }
  return value;
}

function segment(id: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new CliError("invalid_domain_id", "Invalid domain ID.", { exitCode: EXIT.usage });
  return id;
}

const isWww = (hostname: string) => hostname.startsWith("www.") && hostname.split(".").length >= 3;

// --- Plain-language setup ----------------------------------------------------

function issueText(issue: z.infer<typeof issueSchema>, domain: DomainDetail): { message: string; fix?: string } {
  const values = issue.values?.join(", ");
  switch (issue.code) {
    case "dns_unavailable":
      return { message: "Public DNS could not be read for this name yet.", fix: "Wait a minute; the check repeats on its own." };
    case "cname_wrong_target":
      return {
        message: `The CNAME points to ${values}, not ${domain.dnsTarget}.`,
        fix: `Change the CNAME for ${domain.hostname} to ${domain.dnsTarget}.`,
      };
    case "cname_proxied":
      return {
        message: "The record is proxied through Cloudflare (orange cloud), which hides it and blocks HTTPS.",
        fix: "In Cloudflare DNS, set the record's proxy status to DNS only (grey cloud).",
      };
    case "address_conflict":
      return {
        message: `${domain.hostname} has A/AAAA records (${values}) instead of the CNAME.`,
        fix: "Delete the A and AAAA records for this name and add the CNAME.",
      };
    case "caa_blocks":
      return {
        message: `The domain's CAA records don't allow the certificate authority (${values}).`,
        fix: `Add CAA records allowing ${values}, or remove the CAA records.`,
      };
    case "certificate_slow":
      return {
        message: `The HTTPS certificate has been pending for ${issue.values?.[0] ?? "over 15"} minutes after the records appeared.`,
        fix: `Check every TXT record is exact, then run 'atmyapp domains check ${domain.hostname}'.`,
      };
    case "certificate_rejected":
      return {
        message: `The certificate authority rejected the request${issue.message ? `: ${issue.message}` : "."}`,
        fix: `Fix the records above, then run 'atmyapp domains check ${domain.hostname}'.`,
      };
    case "certificate_expiring":
      return {
        message: `The HTTPS certificate expires in ${issue.values?.[0] ?? "a few"} days and hasn't renewed.`,
        fix: "Make sure every DNS record is still in place; renewal is automatic once they are.",
      };
    default:
      return { message: issue.message || "The hosting provider reported a problem.", fix: "Try again in a few minutes." };
  }
}

/** Mirrors the dashboard's checklist (domainSetup.ts in the web app). */
export function domainSetup(domain: DomainDetail): DomainSetup {
  const status = domain.status.toLowerCase();
  const diagnosis = domain.diagnosis;
  const records: DomainRecord[] = diagnosis?.records ?? [{
    type: "CNAME", purpose: "routing", name: domain.hostname,
    host: domain.hostname.split(".").length > 2 ? domain.hostname.split(".").slice(0, -2).join(".") : "@",
    value: domain.dnsTarget, status: status === "pending_user_dns" ? "missing" : "unknown",
  }];
  const moreRecordsComing = diagnosis ? diagnosis.certificateRecordsPending : status !== "active";
  const recordsDone = diagnosis ? diagnosis.steps.records.state === "done" : status === "active";
  const certificateProblem = diagnosis?.steps.certificate.state === "problem";
  const assignment = domain.assignment;
  const issues = (diagnosis?.issues ?? [])
    .filter((issue) => issue.code !== "provider_error" || certificateProblem)
    .map((issue) => ({ code: issue.code, ...issueText(issue, domain) }));

  let phase: DomainPhase;
  if (domain.removalPending) phase = "removing";
  else if (["error", "blocked", "failed"].includes(status) || certificateProblem) phase = "problem";
  else if (status !== "active" && !recordsDone) phase = "records";
  else if (status !== "active") phase = "certificate";
  else if (!assignment?.deploymentId || assignment.routeStatus === "disabled" || !(assignment.release || assignment.pinnedReleaseId)) phase = "website";
  else phase = "live";

  const missing = records.filter((record) => record.status !== "found");
  const nextSteps: string[] = [];
  const check = `atmyapp domains check ${domain.hostname}`;
  let summary: string;
  switch (phase) {
    case "removing":
      summary = "The domain is being disconnected and its certificate deleted (about a minute).";
      break;
    case "records":
      summary = `Waiting for DNS: ${missing.length || records.length} of ${records.length} record(s) not visible yet.`;
      nextSteps.push(
        "At the DNS provider for " + domain.hostname + ", add every record in `records` (all are required). Paste each host exactly as shown; if the provider wants full names, use `name`.",
        "Delete any other A, AAAA or CNAME record for the same host. Leave TTL at its default.",
      );
      if (moreRecordsComing) nextSteps.push(`More certificate (TXT) records appear within a minute; run 'atmyapp domains show ${domain.hostname}' again.`);
      nextSteps.push(`DNS is checked every minute. After adding the records, run '${check} --wait' to follow it.`);
      break;
    case "certificate":
      summary = "DNS is correct; the HTTPS certificate is being issued (usually 5–15 minutes).";
      nextSteps.push(`Keep every record in place. Run '${check} --wait' to follow it.`);
      break;
    case "problem":
      summary = "Setup is stuck; see `issues`.";
      for (const issue of issues) if (issue.fix) nextSteps.push(issue.fix);
      nextSteps.push(`Then run '${check} --wait'.`);
      break;
    case "website":
      summary = !assignment?.deploymentId
        ? "The domain works but shows no website."
        : assignment.routeStatus === "disabled"
          ? "The domain works but is turned off."
          : "The domain works; it shows the website after its first publish.";
      if (!assignment?.deploymentId) nextSteps.push(`Choose a website: 'atmyapp domains edit ${domain.hostname} --deployment <name-or-id>'.`);
      else if (assignment.routeStatus === "disabled") nextSteps.push(`Turn it on: 'atmyapp domains edit ${domain.hostname} --enable'.`);
      else nextSteps.push("Publish the website: 'atmyapp hosting deploy --wait'.");
      break;
    default:
      summary = `Live at https://${domain.hostname}${assignment?.deploymentName ? ` (${assignment.deploymentName})` : ""}.`;
  }
  if (isWww(domain.hostname) && (phase === "records" || phase === "live")) {
    const apex = domain.hostname.slice(4);
    nextSteps.push(`Optional: make ${apex} open the site too with a permanent (301) redirect to https://${domain.hostname} in the DNS provider's URL forwarding. Don't change the www records.`);
  }
  return { phase, summary, records, moreRecordsComing, issues, nextSteps };
}

// --- API -----------------------------------------------------------------------

export async function listDomains(api: ApiClient): Promise<z.infer<typeof domainListSchema>> {
  return { domains: read(z.array(domainSummarySchema), await api.json("GET", "domains", { signal: apiTimeout() })) };
}

/** Finds a domain by hostname (any case, with or without https://) or by ID. */
export async function findDomain(api: ApiClient, ref: string): Promise<DomainSummary> {
  const { domains } = await listDomains(api);
  const byId = domains.find((domain) => domain.id === ref.trim());
  if (byId) return byId;
  let hostname: string | null = null;
  try {
    hostname = normalizeHostname(ref);
  } catch {
    /* not a hostname; fall through to not found */
  }
  const found = hostname ? domains.find((domain) => domain.hostname === hostname) : undefined;
  if (!found) {
    throw new CliError("domain_not_found", `No domain '${ref}' in this project.`, {
      status: 404,
      details: { domains: domains.map((domain) => domain.hostname) },
      fix: "Run 'atmyapp domains ls' to see the project's domains.",
    });
  }
  return found;
}

function result(raw: unknown): DomainResult {
  const domain = read(domainDetailSchema, raw);
  return { domain, setup: domainSetup(domain) };
}

export async function showDomain(api: ApiClient, ref: string): Promise<DomainResult> {
  const { id } = await findDomain(api, ref);
  return result(await api.json("GET", "domains/" + segment(id), { signal: apiTimeout() }));
}

async function deployments(api: ApiClient) {
  return read(z.object({ deployments: z.array(z.looseObject(deploymentSchema.shape)) }),
    await api.json("GET", "deployments", { signal: apiTimeout() })).deployments;
}

/** `--deployment` by ID or name; without it, the project's only website. */
async function resolveDeployment(api: ApiClient, wanted?: string): Promise<{ id: string; name: string } | null> {
  const rows = await deployments(api);
  if (wanted) {
    const match = rows.find((row) => row.id === wanted) ?? rows.filter((row) => row.name.toLowerCase() === wanted.toLowerCase())[0];
    if (!match) {
      throw new CliError("deployment_not_found", `No website deployment '${wanted}'.`, {
        exitCode: EXIT.usage,
        details: { deployments: rows.map(({ id, name }) => ({ id, name })) },
        fix: "Run 'atmyapp hosting status' to see the deployments.",
      });
    }
    return { id: match.id, name: match.name };
  }
  if (rows.length === 1) return { id: rows[0].id, name: rows[0].name };
  if (rows.length > 1) {
    throw new CliError("deployment_required", "Choose which website the domain shows with --deployment.", {
      exitCode: EXIT.usage,
      details: { deployments: rows.map(({ id, name }) => ({ id, name })) },
    });
  }
  return null;
}

/**
 * Connects a domain. Safe to run twice: when the domain is already connected
 * to the same website the result is `unchanged: true`; connected elsewhere, it
 * is `already_exists` with the difference.
 */
export async function addDomain(api: ApiClient, input: string, options: { deployment?: string; dryRun?: boolean } = {}) {
  // The server rejects bare domains (example.com) and explains to use www.
  const hostname = normalizeHostname(input);
  const { domains } = await listDomains(api);
  const existing = domains.find((domain) => domain.hostname === hostname) ?? null;
  // An existing domain keeps its website unless --deployment names one.
  const deployment = existing && !options.deployment
    ? (existing.deploymentId ? { id: existing.deploymentId, name: existing.deploymentName ?? existing.deploymentId } : null)
    : await resolveDeployment(api, options.deployment);
  const outcome = await ensure({
    kind: "domain",
    key: hostname,
    find: async () => existing,
    differences: (found) => diffFields({ deployment: found.deploymentId }, { deployment: deployment?.id ?? null }),
    create: async () => options.dryRun ? null : result(await api.json("POST", "domains", {
      body: { hostname, ...(deployment ? { deploymentId: deployment.id } : {}) },
      signal: AbortSignal.timeout(60_000),
    })),
    editCommand: `atmyapp domains edit ${hostname} --deployment <website>`,
  });
  // A dry run reports what would happen, including the conflict above.
  if (options.dryRun) return { dryRun: true as const, unchanged: outcome.unchanged, hostname, deployment };
  if (outcome.unchanged) return { dryRun: false as const, unchanged: true, ...result(await api.json("GET", "domains/" + segment(outcome.existing.id), { signal: apiTimeout() })) };
  return { dryRun: false as const, unchanged: false, ...outcome.created! };
}

export interface DomainEdit {
  deployment?: string;
  unassign?: boolean;
  enable?: boolean;
  disable?: boolean;
  pin?: string;
  unpin?: boolean;
  spaFallback?: boolean;
  notFoundPage?: string;
}

export async function editDomain(api: ApiClient, ref: string, edit: DomainEdit, dryRun = false) {
  const domain = await findDomain(api, ref);
  if (edit.enable && edit.disable) throw new CliError("invalid_options", "Pass --enable or --disable, not both.", { exitCode: EXIT.usage });
  if (edit.deployment && edit.unassign) throw new CliError("invalid_options", "Pass --deployment or --unassign, not both.", { exitCode: EXIT.usage });
  if (edit.pin && edit.unpin) throw new CliError("invalid_options", "Pass --pin or --unpin, not both.", { exitCode: EXIT.usage });
  const body: Record<string, unknown> = {};
  if (edit.deployment) body.deploymentId = (await resolveDeployment(api, edit.deployment))!.id;
  if (edit.unassign) body.deploymentId = null;
  if (edit.enable) body.routeStatus = "active";
  if (edit.disable) body.routeStatus = "disabled";
  if (edit.pin) body.pinnedReleaseId = segment(edit.pin);
  if (edit.unpin) body.pinnedReleaseId = null;
  if (edit.spaFallback !== undefined) body.spaFallback = edit.spaFallback;
  if (edit.notFoundPage !== undefined) {
    if (!edit.notFoundPage.startsWith("/")) throw new CliError("invalid_options", "The 404 page is a path such as /404.html.", { exitCode: EXIT.usage });
    body.fallback404Path = edit.notFoundPage;
  }
  if (!Object.keys(body).length) {
    throw new CliError("nothing_to_change", "Pass at least one change.", {
      exitCode: EXIT.usage,
      fix: "See 'atmyapp domains edit --help'.",
    });
  }
  if (!domain.deploymentId && body.deploymentId === undefined) {
    throw new CliError("deployment_required", "This domain shows no website yet; choose one with --deployment first.", { exitCode: EXIT.usage });
  }
  if (dryRun) return { dryRun: true as const, id: domain.id, hostname: domain.hostname, changes: body };
  const updated = result(await api.json("PUT", "domains/" + segment(domain.id), { body, signal: apiTimeout() }));
  return { dryRun: false as const, changes: body, ...updated };
}

/**
 * Checks DNS now and asks the certificate authority to validate again. With
 * `wait`, follows the setup until it is live, needs the user, or times out.
 */
export async function checkDomain(
  api: ApiClient,
  ref: string,
  options: { wait?: boolean; timeoutMs?: number; sleep?: (ms: number) => Promise<unknown>; now?: () => number; onProgress?: (setup: DomainSetup) => void } = {},
): Promise<DomainResult> {
  const { id } = await findDomain(api, ref);
  let current = result(await api.json("POST", "domains/" + segment(id) + "/verify", { body: {}, signal: AbortSignal.timeout(60_000) }));
  if (!options.wait) return current;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? WAITS.domain.default);
  let lastPhase = current.setup.phase;
  options.onProgress?.(current.setup);
  // Live, needs a website choice, stuck, or being removed: the user acts next.
  while (current.setup.phase === "records" || current.setup.phase === "certificate") {
    const remaining = deadline - now();
    if (remaining <= 0) {
      const resume = `atmyapp domains check ${current.domain.hostname} --wait`;
      // Records missing: the person has to change DNS. Certificate: just slow.
      if (current.setup.phase === "records") {
        throw needsPerson("dns", `${current.domain.hostname} still needs DNS records: ${current.setup.summary}`, {
          resume,
          fix: `Add the records from 'atmyapp domains show ${current.domain.hostname}' at your DNS provider, then run '${resume}'.`,
          details: { phase: current.setup.phase, records: current.setup.records },
        });
      }
      throw stillPending("domain_timeout", `${current.domain.hostname} is still waiting: ${current.setup.summary}`, {
        state: current.setup.phase,
        resume,
        details: { phase: current.setup.phase, records: current.setup.records },
      });
    }
    await sleep(Math.min(20_000, remaining));
    current = result(await api.json("GET", "domains/" + segment(id), { signal: apiTimeout() }));
    if (current.setup.phase !== lastPhase) {
      lastPhase = current.setup.phase;
      options.onProgress?.(current.setup);
    }
  }
  if (current.setup.phase === "problem") {
    throw needsPerson("dns", `${current.domain.hostname} needs attention: ${current.setup.summary}`, {
      resume: `atmyapp domains check ${current.domain.hostname} --wait`,
      fix: current.setup.issues.map((issue) => issue.fix ?? issue.message).join(" ") || undefined,
      details: { phase: current.setup.phase, issues: current.setup.issues },
    });
  }
  return current;
}

export async function removeDomain(
  api: ApiClient,
  ref: string,
  dryRun = false,
  options: { ifExists?: boolean } = {},
): Promise<z.infer<typeof domainRemoveSchema>> {
  let domain: DomainSummary;
  try {
    domain = await findDomain(api, ref);
  } catch (error) {
    if (options.ifExists && error instanceof CliError && error.code === "domain_not_found") {
      return { id: null, hostname: ref.trim(), dryRun, removalPending: false, removed: false };
    }
    throw error;
  }
  if (dryRun) return { id: domain.id, hostname: domain.hostname, dryRun: true, removalPending: domain.removalPending, removed: false };
  // Already being removed: running rm again is a no-op, not a second request.
  if (domain.removalPending) return { id: domain.id, hostname: domain.hostname, dryRun: false, removalPending: true, removed: true };
  await api.json("DELETE", "domains/" + segment(domain.id), { signal: apiTimeout() });
  return { id: domain.id, hostname: domain.hostname, dryRun: false, removalPending: true, removed: true };
}

/** Records as text for an email or a provider form. */
export function recordsAsText(hostname: string, records: DomainRecord[]): string {
  const width = Math.max(4, ...records.map((record) => record.host.length));
  return [
    `DNS records for ${hostname} (all required):`,
    ...records.map((record) => `${record.type.padEnd(6)} ${record.host.padEnd(width)}  ${record.value}`),
  ].join("\n");
}
