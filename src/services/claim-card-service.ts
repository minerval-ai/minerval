/**
 * The claim card: the graph's judgment of one node, whole, and nothing else.
 *
 * GET /claims/:id serves everything a claim page shows. A site that embeds a
 * claim, or an agent that only needs to report where a claim stands, wants a
 * small fixed shape it can build on: what the node says, what the graph
 * currently judges, how sure it is, how disputed the claim is, how fresh
 * that is, and where to send a reader. The card is that shape. Its keys are
 * always all present; a value that does not exist yet is null.
 *
 * It carries the judgment whole because callers are asked not to round it
 * (the constitution's reader principles): a status travels with its
 * confidence, and `contestation` (how actively the claim is disputed, which
 * is not a status, #524) travels beside both.
 *
 * Cards are read in one query however many are asked for, so a page showing
 * many claims makes one request (GET /claims/cards).
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { resolveClaimId, type ResolvedFrom } from "./claim-alias-service.js";

/**
 * The most ids one batch read takes: the list route's largest page. A
 * caller waits on the result, and the ids travel in a URL, which has a
 * length the HTTP layer bounds; a longer list is read in more requests.
 * Stated to callers in the `ids` parameter's schema and description.
 */
export const CLAIM_CARDS_MAX_IDS = 100;

export interface ClaimCard {
  id: string;
  /** claim | quantity | question (constitution §2, §7a). */
  kind: string;
  /** The node's canonical wording. */
  text: string;
  /** active | merged | deprecated | archived. */
  state: string;
  /**
   * A claim's current status on the evidential ladder; null when the claim
   * has not been assessed, and always null for a quantity or a question,
   * whose judgment is `estimate` or `standing`.
   */
  assessment_status: string | null;
  /**
   * How sure the Steward is that the status (or, for a question, the
   * standing) is the right reading of the evidence, 0..1. Not the
   * probability that the claim is true. Null when unassessed, when the
   * Steward stated none, and for a quantity.
   */
  assessment_confidence: number | null;
  /** A question's current standing; null for other kinds and until judged. */
  standing: string | null;
  /** A quantity's current estimate; null for other kinds and until estimated. */
  estimate: Record<string, unknown> | null;
  /** A quantity's unit; null for other kinds. */
  unit: Record<string, unknown> | null;
  /**
   * How actively the claim is disputed or consulted, 0..1; null until
   * judged. Reported beside the status, never folded into it.
   */
  contestation: number | null;
  /** When the current judgment of the node's kind was made; null if none. */
  assessed_at: string | null;
  /** When the node itself last changed. */
  updated_at: string;
  /** The node's public page. */
  page_url: string;
  /**
   * Null unless the id asked for was merged into another node (#884): then
   * the card is the survivor's, under the survivor's id, and this says
   * which id was asked, its wording, how it stood to the survivor
   * (`stance_relation`: after an `opposed` merge the judgment shown is of
   * the opposite of what the id stated) and when it was merged.
   */
  resolved_from: ResolvedFrom | null;
}

interface CardRow {
  id: string;
  kind: string | null;
  text: string;
  state: string;
  contestation: number | null;
  updated_at: Date | string;
  assessment_status: string | null;
  assessment_confidence: number | null;
  standing: string | null;
  estimate: Record<string, unknown> | null;
  unit: Record<string, unknown> | null;
  assessed_at: Date | string | null;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function claimPageUrl(claimId: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${claimId}`;
}

function toCard(row: CardRow): ClaimCard {
  return {
    id: row.id,
    kind: row.kind ?? "claim",
    text: row.text,
    state: row.state,
    assessment_status: row.assessment_status ?? null,
    assessment_confidence: row.assessment_confidence ?? null,
    standing: row.standing ?? null,
    estimate: row.estimate ?? null,
    unit: row.unit ?? null,
    contestation: row.contestation ?? null,
    assessed_at: row.assessed_at ? iso(row.assessed_at) : null,
    updated_at: iso(row.updated_at),
    page_url: claimPageUrl(row.id),
    resolved_from: null,
  };
}

/**
 * Cards for the given node ids, keyed by the id asked. An id the graph does
 * not hold is simply not in the map: the caller decides how to say so. An
 * id that was merged into another node answers, under the id asked, with
 * its survivor's card and `resolved_from` (#884). Aliases are rare, so each
 * costs its own resolution rather than widening the one query every read
 * pays for.
 */
export async function getClaimCards(ids: string[]): Promise<Map<string, ClaimCard>> {
  const cards = await readCards(ids);
  for (const [id, card] of cards) {
    if (card.state !== "merged") continue;
    const resolution = await resolveClaimId(id);
    if (!resolution?.resolvedFrom) continue;
    const survivor =
      cards.get(resolution.id) ?? (await readCards([resolution.id])).get(resolution.id);
    if (survivor) cards.set(id, { ...survivor, resolved_from: resolution.resolvedFrom });
  }
  return cards;
}

/**
 * The rows' own cards, in one query however many are asked for.
 *
 * Each kind's judgment is read from the table that kind keeps (`assessments`
 * holds verdicts on propositions only), at most one current row each by
 * partial unique index, so the joins never multiply a node.
 */
async function readCards(ids: string[]): Promise<Map<string, ClaimCard>> {
  if (ids.length === 0) return new Map();
  const rows = await rawQuery<CardRow>(
    `SELECT c.id, c.kind, c.text, c.state, c.contestation, c.updated_at,
            CASE WHEN c.kind = 'claim' THEN a.status END AS assessment_status,
            CASE c.kind WHEN 'claim' THEN a.confidence
                        WHEN 'question' THEN qa.confidence END AS assessment_confidence,
            CASE WHEN c.kind = 'question' THEN qa.standing END AS standing,
            CASE WHEN c.kind = 'quantity' THEN qe.estimate END AS estimate,
            CASE WHEN c.kind = 'quantity' THEN qd.unit END AS unit,
            CASE c.kind WHEN 'claim' THEN a.assessed_at
                        WHEN 'question' THEN qa.assessed_at
                        WHEN 'quantity' THEN qe.assessed_at END AS assessed_at
       FROM claims c
       LEFT JOIN assessments_in_force a ON a.claim_id = c.id
       LEFT JOIN question_assessments_in_force qa ON qa.claim_id = c.id
       LEFT JOIN quantity_estimates_in_force qe ON qe.claim_id = c.id
       LEFT JOIN quantity_definitions qd ON qd.claim_id = c.id
      WHERE c.id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(rows.map((row) => [row.id, toCard(row)]));
}

/** One node's card, or null when the graph holds no such node. */
export async function getClaimCard(id: string): Promise<ClaimCard | null> {
  return (await getClaimCards([id])).get(id) ?? null;
}
