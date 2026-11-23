/**
 * Lateral links between claims (#436): symmetric, non-evaluative relations
 * for claims that are neither premise nor conclusion of each other
 * (constitution §19's third direction). They live in `claim_links`, not in
 * `claim_relationships`, so nothing that walks the dependency graph can
 * mistake a see-also for a premise.
 *
 * A link is stored once, with the pair in canonical order, and reads the
 * same from either side. Writers report a duplicate as `created: false`;
 * every other failure propagates.
 */
import { heldBelow, layered, lowerRowSql } from "./layer-service.js";

/** A link held at two layers is listed once, by the lowest layer's row (layer-service.ts). Empty on a graph with one layer. */
const oneLinkSql = (l: string) => (layered() ? ` AND ${lowerRowSql("claim_links", l, ["claim_a_id", "claim_b_id", "kind"])} IS NULL` : "");
import { rawQuery } from "../db/client.js";
import { asRunner, type Runner } from "./query-runner.js";
import { markSeveralInForce } from "./judgment-version-service.js";
import { currentLabel } from "../llm/usage-context.js";
import { CLAIM_LINK_KINDS } from "../schemas/common.js";

export type ClaimLinkKind = (typeof CLAIM_LINK_KINDS)[number];

export function isClaimLinkKind(v: unknown): v is ClaimLinkKind {
  return typeof v === "string" && (CLAIM_LINK_KINDS as readonly string[]).includes(v);
}

/** The pair as stored: lexicographically smaller uuid first. */
export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export interface ClaimLinkRow {
  id: string;
  claim_a_id: string;
  claim_b_id: string;
  kind: string;
  reasoning: string;
  created_by: string;
}

export async function linkClaims(input: {
  claimId: string;
  otherClaimId: string;
  kind: ClaimLinkKind;
  reasoning: string;
  createdBy: string;
}): Promise<{ id: string; created: boolean }> {
  if (input.claimId === input.otherClaimId) {
    throw new Error("A claim cannot be linked to itself");
  }
  const [a, b] = orderPair(input.claimId, input.otherClaimId);
  // A link a layer below already holds is the link (identity is per
  // layer, layer-service.ts): the public graph's, or one recorded at a
  // label this work reads. Nothing is recorded beside it.
  const below = await heldBelow(rawQuery, "claim_links", { claim_a_id: a, claim_b_id: b, kind: input.kind });
  if (below) return { id: below.id, created: false };
  const inserted = await rawQuery<{ id: string }>(
    `INSERT INTO claim_links (claim_a_id, claim_b_id, kind, reasoning, created_by, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (claim_a_id, claim_b_id, kind, sensitivity_label, origin) DO NOTHING
     RETURNING id`,
    [a, b, input.kind, input.reasoning, input.createdBy, currentLabel()]
  );
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const [existing] = await rawQuery<{ id: string }>(
    `SELECT id FROM claim_links WHERE claim_a_id = $1 AND claim_b_id = $2 AND kind = $3
        AND sensitivity_label = $4 AND origin = 'local'`,
    [a, b, input.kind, currentLabel()]
  );
  if (!existing) {
    throw new Error(`Link ${a} <-> ${b} (${input.kind}) neither inserted nor found`);
  }
  return { id: existing.id, created: false };
}

/** A link between two claims as the work in progress meets it. */
export interface HeldLink extends ClaimLinkRow {
  sensitivity_label: string;
  origin: string;
  /** Recorded at the work's own label, in this deployment: the only row the work may rewrite. */
  own: boolean;
}

/** Every link between two claims that the work in progress reads, oldest first. */
export async function getLinksBetween(claimId: string, otherClaimId: string): Promise<HeldLink[]> {
  const [a, b] = orderPair(claimId, otherClaimId);
  return rawQuery<HeldLink>(
    `SELECT id, claim_a_id, claim_b_id, kind, reasoning, created_by, sensitivity_label, origin,
            (sensitivity_label = $3 AND origin = 'local') AS own
       FROM claim_links
      WHERE claim_a_id = $1 AND claim_b_id = $2
      ORDER BY created_at, id`,
    [a, b, currentLabel()]
  );
}

/**
 * Rewrite a link's reasoning note, and its kind where `kind` differs
 * (#1189). The (pair, kind) key is unique at a label, so where the work's
 * label already holds a link of the new kind the two become one: that row
 * takes the note and this one is deleted. The caller has established that
 * the row is the work's own to change.
 */
export async function reviseLink(
  linkId: string,
  kind: ClaimLinkKind,
  reasoning: string,
  tx?: Runner
): Promise<{ id: string; merged: boolean }> {
  const run = asRunner(tx);
  const [link] = await run.query<{ claim_a_id: string; claim_b_id: string; kind: string; sensitivity_label: string; origin: string }>(
    `SELECT claim_a_id, claim_b_id, kind, sensitivity_label, origin FROM claim_links WHERE id = $1 FOR UPDATE`,
    [linkId]
  );
  if (!link) throw new Error(`Claim link not found: ${linkId}`);
  const [existing] = await run.query<{ id: string }>(
    `SELECT id FROM claim_links
      WHERE claim_a_id = $1 AND claim_b_id = $2 AND kind = $3 AND sensitivity_label = $4 AND origin = $5 AND id <> $6`,
    [link.claim_a_id, link.claim_b_id, kind, link.sensitivity_label, link.origin, linkId]
  );
  if (!existing) {
    await run.query(`UPDATE claim_links SET kind = $2, reasoning = $3 WHERE id = $1`, [linkId, kind, reasoning]);
    return { id: linkId, merged: false };
  }
  await run.query(`UPDATE claim_links SET reasoning = $2 WHERE id = $1`, [existing.id, reasoning]);
  await run.query(`DELETE FROM claim_links WHERE id = $1`, [linkId]);
  return { id: existing.id, merged: true };
}

/** Remove the link(s) between two claims; all kinds unless one is given. */
export async function unlinkClaims(input: {
  claimId: string;
  otherClaimId: string;
  kind?: ClaimLinkKind;
}): Promise<ClaimLinkRow[]> {
  const [a, b] = orderPair(input.claimId, input.otherClaimId);
  return rawQuery<ClaimLinkRow>(
    `DELETE FROM claim_links
      WHERE claim_a_id = $1 AND claim_b_id = $2
      ${input.kind ? "AND kind = $3" : ""}
      RETURNING id, claim_a_id, claim_b_id, kind, reasoning, created_by`,
    input.kind ? [a, b, input.kind] : [a, b]
  );
}

export interface RelatedClaim {
  link_id: string;
  kind: string;
  reasoning: string;
  created_by: string;
  created_at: Date;
  id: string;
  text: string;
  claim_type: string;
  assessment_status: string | null;
  assessment_confidence: number | null;
  assessment_credence: number | null;
  /** Present only where more than one judgment of the counterpart is in force for the asker (judgment-version-service.ts). */
  judgments_in_force?: number;
  judgments_in_force_note?: string;
}

/**
 * The claims linked laterally to this one, seen from its side, with each
 * counterpart's current standing. Merged and deprecated counterparts are
 * left out: a merge moves links onto the survivor (reconciliation-service),
 * and a deprecated claim is no longer a place to send a reader.
 */
export async function listRelatedClaims(claimId: string): Promise<RelatedClaim[]> {
  const related = await rawQuery<RelatedClaim>(
    `SELECT l.id AS link_id, l.kind, l.reasoning, l.created_by, l.created_at,
            c.id, c.text, c.claim_type,
            a.status AS assessment_status, a.confidence AS assessment_confidence,
            a.claim_credence AS assessment_credence
       FROM claim_links l
       JOIN claims c
         ON c.id = CASE WHEN l.claim_a_id = $1 THEN l.claim_b_id ELSE l.claim_a_id END
       LEFT JOIN assessments_in_force a ON a.claim_id = c.id
      WHERE (l.claim_a_id = $1 OR l.claim_b_id = $1)
        AND c.state = 'active'${oneLinkSql("l")}
      ORDER BY l.created_at, l.id`,
    [claimId]
  );
  // Where more than one judgment of a counterpart is in force for the asker, its row says so.
  await markSeveralInForce(related, (r) => r.id);
  return related;
}
