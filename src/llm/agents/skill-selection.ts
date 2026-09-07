/**
 * How a run finds its domain skills (docs/mathematics.md §3.4).
 *
 * Selection is a recorded admin judgment, read from the record, never a
 * filter and never the funding mandate: claim-scoped runs read
 * `claims.domains` (the Reviewer and Arbitrator through the contribution's
 * target claim, Audit as the union over the claims in the decisions under
 * review), mandate-scoped runs read `grants.skills`. A lookup that fails
 * degrades to an unskilled run with a warning rather than a failed run
 * (§20); a Steward's next pass on the claim carries the skill regardless.
 */
import { rawQuery } from "../../db/client.js";
import {
  knownDomains,
  skillsByName,
  skillsForDomains,
  type Skill,
} from "../prompts/skills.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Keep only values from the closed list of domains, deduplicated and sorted. */
export function sanitizeDomains(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const known = new Set(knownDomains());
  return [
    ...new Set(
      input
        .map((d) => String(d).trim().toLowerCase())
        .filter((d) => known.has(d))
    ),
  ].sort();
}

function warn(what: string, err: unknown): void {
  console.warn(
    `[skills] ${what} failed; proceeding without domain skills: ` +
      `${err instanceof Error ? err.message : String(err)}`
  );
}

/** The recorded domains of one claim ([] when untagged or unknown). */
export async function domainsForClaim(claimId: string): Promise<string[]> {
  try {
    const [row] = await rawQuery<{ domains: string[] | null }>(
      `SELECT domains FROM claims WHERE id = $1`,
      [claimId]
    );
    return sanitizeDomains(row?.domains ?? []);
  } catch (err) {
    warn(`domain lookup for claim ${claimId}`, err);
    return [];
  }
}

/** The domains of a contribution's target claim ([] for intake proposals with no claim yet). */
export async function domainsForContribution(contributionId: string): Promise<string[]> {
  try {
    const [row] = await rawQuery<{ domains: string[] | null }>(
      `SELECT c.domains
         FROM contributions ct
         JOIN claims c ON c.id = ct.claim_id
        WHERE ct.id = $1`,
      [contributionId]
    );
    return sanitizeDomains(row?.domains ?? []);
  } catch (err) {
    warn(`domain lookup for contribution ${contributionId}`, err);
    return [];
  }
}

/**
 * The union of domains over the claims an audit's context names, directly
 * (claim ids) or through the contributions it names (their target claims).
 * A pattern analysis names no decisions and gets no skill; the load_skill
 * fallback for those runs is deferred.
 */
export async function domainsForAuditContext(context: string): Promise<string[]> {
  const ids = [...new Set((context.match(UUID_RE) ?? []).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return [];
  try {
    const rows = await rawQuery<{ domains: string[] | null }>(
      `SELECT c.domains FROM claims c WHERE c.id = ANY($1::uuid[])
       UNION ALL
       SELECT c.domains FROM contributions ct
         JOIN claims c ON c.id = ct.claim_id
        WHERE ct.id = ANY($1::uuid[])`,
      [ids]
    );
    return sanitizeDomains(rows.flatMap((r) => r.domains ?? []));
  } catch (err) {
    warn("domain lookup for audit context", err);
    return [];
  }
}

/** The skills a mandate's Grantmaker carries (`grants.skills`). */
export async function skillsForGrant(grantId: string): Promise<Skill[]> {
  try {
    const [row] = await rawQuery<{ skills: string[] | null }>(
      `SELECT skills FROM grants WHERE id = $1`,
      [grantId]
    );
    return skillsByName(row?.skills ?? []);
  } catch (err) {
    warn(`skill lookup for grant ${grantId}`, err);
    return [];
  }
}

/** Convenience: the skills a claim's recorded domains activate. */
export async function skillsForClaim(claimId: string): Promise<Skill[]> {
  return skillsForDomains(await domainsForClaim(claimId));
}
