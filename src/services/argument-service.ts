import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb, rawQuery, withTransaction } from "../db/client.js";
import { arguments_, argumentEvaluations, argumentEvaluationsInForce } from "../db/schema.js";
import { currentLabel } from "../llm/usage-context.js";

/**
 * Inline claim reference inside an argument's written form:
 *   [[claim:<uuid>]]              — rendered as the claim's canonical text
 *   [[claim:<uuid>|inline text]]  — rendered as the given phrasing
 * Renderers resolve the id at display time (following merged_into), so links
 * never dangle after a merge.
 */
const CLAIM_LINK_PATTERN =
  /\[\[claim:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\|([^\]]*))?\]\]/g;

export interface ClaimLink {
  claimId: string;
  display: string | null;
}

/** Extract every [[claim:<uuid>]] / [[claim:<uuid>|text]] reference, in order. */
export function parseClaimLinks(writtenForm: string): ClaimLink[] {
  const links: ClaimLink[] = [];
  for (const m of writtenForm.matchAll(CLAIM_LINK_PATTERN)) {
    links.push({ claimId: m[1]!.toLowerCase(), display: m[2] ?? null });
  }
  return links;
}

/**
 * Does this argument carry a real written form? Steward-created arguments
 * start with their label (`description`) copied into `content`, so the
 * written form (issue #129) is content that is no longer that label. Links
 * are not the test (#747): an argument whose settled premises live in the
 * prose (§6, §7) has a written form with nothing to link. An argument with
 * no label (one a user posted through the API) is its own written form.
 * LACKS_WRITTEN_FORM_SQL is its negation in SQL.
 */
export function hasWrittenForm(argument: { content: string; description: string | null }): boolean {
  const content = argument.content.trim();
  if (parseClaimLinks(content).length > 0) return true;
  if (argument.description === null) return content.length > 0;
  return content !== argument.description.trim();
}

/** hasWrittenForm's negation over an `arguments` row aliased `a`, for the backfill scripts. */
export const LACKS_WRITTEN_FORM_SQL = `(a.content NOT LIKE '%[[claim:%'
    AND a.description IS NOT NULL
    AND btrim(a.content) = btrim(a.description))`;

export async function addArgument(input: {
  claimId: string;
  stance: "for" | "against" | "neutral";
  content: string;
  name?: string;
  description?: string;
  createdBy?: string;
}) {
  const db = getDb();
  const [argument] = await db
    .insert(arguments_)
    .values({
      claimId: input.claimId,
      stance: input.stance,
      content: input.content,
      name: input.name ?? null,
      description: input.description ?? null,
      createdBy: input.createdBy ?? "user",
      // The argument is the writing run's: one written at a restricted
      // label on a public claim is restricted (src/labels.ts).
      sensitivityLabel: currentLabel(),
    })
    .returning();

  return argument!;
}

export async function getArgument(argumentId: string) {
  const db = getDb();
  const [argument] = await db
    .select()
    .from(arguments_)
    .where(eq(arguments_.id, argumentId))
    .limit(1);
  return argument ?? null;
}

/** A claim's arguments, leaving out any its Steward retired (#741). */
export async function getArgumentsForClaim(claimId: string) {
  const db = getDb();
  return db
    .select()
    .from(arguments_)
    .where(and(eq(arguments_.claimId, claimId), isNull(arguments_.retiredAt)));
}

/** The arguments a claim's Steward retired (#741): history, oldest retirement first. */
export async function getRetiredArgumentsForClaim(claimId: string) {
  const db = getDb();
  return db
    .select()
    .from(arguments_)
    .where(and(eq(arguments_.claimId, claimId), isNotNull(arguments_.retiredAt)))
    .orderBy(arguments_.retiredAt);
}

/**
 * The child claims of the decomposition edges grouped under this argument
 * (membership lives in argument_subclaims, #437; a child attached to the
 * parent by two relation types appears once per edge).
 */
export async function getArgumentSubclaims(
  argumentId: string
): Promise<{ id: string; text: string }[]> {
  return rawQuery<{ id: string; text: string }>(
    `SELECT c.id, c.text
       FROM argument_subclaims am
       JOIN claim_relationships cr ON cr.id = am.relationship_id
       JOIN claims c ON c.id = cr.child_claim_id
      WHERE am.argument_id = $1
      ORDER BY am.created_at, cr.id`,
    [argumentId]
  );
}

/** Overwrite an argument's written form (its `content`). */
export async function setArgumentContent(argumentId: string, content: string) {
  const db = getDb();
  const [argument] = await db
    .update(arguments_)
    .set({ content })
    .where(eq(arguments_.id, argumentId))
    .returning();
  return argument ?? null;
}

// ---------------------------------------------------------------------------
// Argument evaluations (issue #173)
// ---------------------------------------------------------------------------

/**
 * How far the conclusion follows if the premises hold (constitution §7,
 * #540). The rating is of the inference, never of the conclusion: whether
 * the premises do hold is read from their own assessments. "certain": it
 * follows necessarily; "likely": much more likely, not guaranteed; "slight":
 * the premises bear on it only a little; "none": no real support even if
 * they are true.
 */
export const ARGUMENT_VERDICTS = [
  "certain",
  "likely",
  "slight",
  "none",
] as const;
export type ArgumentVerdict = (typeof ARGUMENT_VERDICTS)[number];

export function isArgumentVerdict(v: unknown): v is ArgumentVerdict {
  return (
    typeof v === "string" && (ARGUMENT_VERDICTS as readonly string[]).includes(v)
  );
}

export async function getCurrentEvaluation(argumentId: string) {
  const db = getDb();
  const [evaluation] = await db
    .select()
    .from(argumentEvaluationsInForce)
    .where(eq(argumentEvaluationsInForce.argumentId, argumentId))
    .limit(1);
  return evaluation ?? null;
}

/**
 * Record a new current evaluation for an argument, retiring the previous one
 * (assessments-style history: prior rows stay, flagged non-current).
 */
export async function setArgumentEvaluation(input: {
  argumentId: string;
  verdict: ArgumentVerdict;
  content: string;
  /** The argument settles its conclusion as its premises now stand (§7). */
  decisive?: boolean;
  assessmentId?: string | null;
  /** On a quantity: the estimate the evaluation was made under. */
  estimateId?: string | null;
  createdBy?: string;
}) {
  const db = getDb();
  await db
    .update(argumentEvaluations)
    .set({ isCurrent: false })
    .where(eq(argumentEvaluations.argumentId, input.argumentId));
  const [evaluation] = await db
    .insert(argumentEvaluations)
    .values({
      argumentId: input.argumentId,
      verdict: input.verdict,
      content: input.content,
      decisive: input.decisive ?? false,
      assessmentId: input.assessmentId ?? null,
      estimateId: input.estimateId ?? null,
      isCurrent: true,
      createdBy: input.createdBy ?? "claim_steward",
      // The label of the run that wrote it (src/labels.ts).
      sensitivityLabel: currentLabel(),
    })
    .returning();
  return evaluation!;
}

/**
 * Whether an evaluation (alias `ae`) predates its claim's current judgment:
 * the current assessment (alias `ca`) for a proposition, the current
 * estimate (alias `cq`) for a quantity (§10). The claim row is alias `c`.
 */
export const EVALUATION_STALE_SQL = `(CASE WHEN c.kind = 'quantity'
    THEN (cq.id IS NULL OR ae.estimate_id IS DISTINCT FROM cq.id)
    ELSE (ca.id IS NULL OR ae.assessment_id IS DISTINCT FROM ca.id) END)`;

export interface ArgumentEvaluationState {
  argument_id: string;
  argument_name: string | null;
  verdict: string | null;
  decisive: boolean | null;
  content: string | null;
  /** True when the evaluation predates the claim's current assessment. */
  stale: boolean;
}

/**
 * The evaluation standing of every NAMED argument on a claim: its current
 * evaluation (if any) and whether that evaluation was derived under the
 * claim's current assessment. Drives the update_claim_assessment nudge and
 * the backfill's detection query.
 */
export async function getEvaluationStateForClaim(
  claimId: string
): Promise<ArgumentEvaluationState[]> {
  return rawQuery<ArgumentEvaluationState>(
    `SELECT a.id AS argument_id, a.name AS argument_name,
            ae.verdict, ae.decisive, ae.content,
            (ae.id IS NOT NULL AND ${EVALUATION_STALE_SQL}) AS stale
       FROM arguments a
       JOIN claims c ON c.id = a.claim_id
       LEFT JOIN argument_evaluations_in_force ae
              ON ae.argument_id = a.id
       LEFT JOIN assessments_in_force ca
              ON ca.claim_id = a.claim_id
       LEFT JOIN quantity_estimates_in_force cq
              ON cq.claim_id = a.claim_id
      WHERE a.claim_id = $1
        AND a.name IS NOT NULL
        AND a.retired_at IS NULL
      ORDER BY a.created_at`,
    [claimId]
  );
}

// ---------------------------------------------------------------------------
// Correcting arguments (#741): rename, flip, retire
// ---------------------------------------------------------------------------

/**
 * Rename an argument, or flip its stance (#670). A flip changes the
 * conclusion the argument reaches (§7: an argument against has the claim's
 * denial as its conclusion), so the current evaluation, which rated the
 * inference to the old conclusion, stops being current. Returns whether an
 * evaluation was retired.
 */
export async function reviseArgument(input: {
  argumentId: string;
  name?: string;
  stance?: "for" | "against";
}): Promise<{ evaluationRetired: boolean }> {
  return withTransaction(async (tx) => {
    if (input.name !== undefined) {
      await tx.query(`UPDATE arguments SET name = $2 WHERE id = $1`, [input.argumentId, input.name]);
    }
    if (input.stance === undefined) return { evaluationRetired: false };
    await tx.query(`UPDATE arguments SET stance = $2 WHERE id = $1`, [input.argumentId, input.stance]);
    const retired = await tx.query<{ id: string }>(
      `UPDATE argument_evaluations SET is_current = false
        WHERE argument_id = $1 AND is_current = true RETURNING id`,
      [input.argumentId]
    );
    return { evaluationRetired: retired.length > 0 };
  });
}

/**
 * Retire an argument (#741): stamp it retired with the reason, and release
 * its subclaims, whose edges stay, to the claim's basis or to the other
 * arguments they are grouped under. The row and its evaluations stay as
 * history. Returns the child claims that were released.
 */
export async function retireArgument(input: {
  argumentId: string;
  reason: string;
}): Promise<{ released: { id: string; text: string }[] }> {
  return withTransaction(async (tx) => {
    const released = await tx.query<{ id: string; text: string }>(
      `SELECT c.id, c.text
         FROM argument_subclaims am
         JOIN claim_relationships cr ON cr.id = am.relationship_id
         JOIN claims c ON c.id = cr.child_claim_id
        WHERE am.argument_id = $1
        ORDER BY am.created_at, cr.id`,
      [input.argumentId]
    );
    await tx.query(`DELETE FROM argument_subclaims WHERE argument_id = $1`, [input.argumentId]);
    await tx.query(
      `UPDATE arguments SET retired_at = now(), retired_reason = $2 WHERE id = $1`,
      [input.argumentId, input.reason]
    );
    return { released };
  });
}
