import { and, eq } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { arguments_, argumentEvaluations } from "../db/schema.js";

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
 * Does this argument's content carry a real written form? Steward-created
 * arguments start with their label copied into `content`; the written form
 * (issue #129) is distinguished by referencing its subclaims inline.
 */
export function hasWrittenForm(content: string): boolean {
  return parseClaimLinks(content).length > 0;
}

export async function addArgument(input: {
  claimId: string;
  stance: "for" | "against" | "neutral";
  content: string;
  name?: string;
  description?: string;
  evidenceUrls?: string[];
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
      evidenceUrls: input.evidenceUrls ?? [],
      createdBy: input.createdBy ?? "user",
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

export async function getArgumentsForClaim(claimId: string) {
  const db = getDb();
  return db
    .select()
    .from(arguments_)
    .where(eq(arguments_.claimId, claimId));
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
 * Whether the inference goes through granting its premises. "contested" is
 * for a framework whose validity is itself live-disputed (constitution §7's
 * ASSUMES case).
 */
export const ARGUMENT_VERDICTS = [
  "holds",
  "holds_with_caveats",
  "fails",
  "contested",
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
    .from(argumentEvaluations)
    .where(
      and(
        eq(argumentEvaluations.argumentId, argumentId),
        eq(argumentEvaluations.isCurrent, true)
      )
    )
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
  assessmentId?: string | null;
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
      assessmentId: input.assessmentId ?? null,
      isCurrent: true,
      createdBy: input.createdBy ?? "claim_steward",
    })
    .returning();
  return evaluation!;
}

export interface ArgumentEvaluationState {
  argument_id: string;
  argument_name: string | null;
  verdict: string | null;
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
            ae.verdict, ae.content,
            (ae.id IS NOT NULL AND (ca.id IS NULL OR ae.assessment_id IS DISTINCT FROM ca.id)) AS stale
       FROM arguments a
       LEFT JOIN argument_evaluations ae
              ON ae.argument_id = a.id AND ae.is_current = true
       LEFT JOIN assessments ca
              ON ca.claim_id = a.claim_id AND ca.is_current = true
      WHERE a.claim_id = $1
        AND a.name IS NOT NULL
      ORDER BY a.created_at`,
    [claimId]
  );
}
