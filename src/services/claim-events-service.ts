/**
 * Claim events service -- the unified per-claim history (issue #175).
 *
 * Composes everything that has happened to a claim into one chronological
 * record: assessments (from the append-only assessments table), contributions
 * and the decisions made about them (reviews, appeals, arbitration), the
 * Steward's audit-log entries, and, for mathematics (docs/mathematics.md
 * §11.1), the formal statement's lifecycle, the checker's verdicts, the
 * bounty and its prize claims, and the house solver's attempts. Most claims
 * have only a creation and a single assessment; a contested claim can
 * accumulate dozens of entries from several parties — the event list is
 * flat and typed so both extremes render the same way.
 *
 * composeClaimEvents() is pure (rows in, events out) so the merge/ordering
 * logic is testable without a database; getClaimEvents() is the thin fetch
 * wrapper the route calls. Every event is derived from a row, so the record
 * is reproducible; emitClaimEvent() is the in-process seam a write fires
 * through when the state changes, for listeners that react as it happens.
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  assessments,
  contributions,
  contributionReviews,
  appeals,
  arbitrationResults,
  auditLog,
  claimFormalizations,
  leanChecks,
  bounties,
  prizeClaims,
  proofAttempts,
} from "../db/schema.js";

// One flat discriminated union rather than nested threads: a review or an
// arbitration is an event in its own right (it can trigger a reassessment),
// so it gets its own timestamped entry, cross-referenced to its contribution
// by id. Field names are already the API's snake_case — the route passes
// events through untouched.
export type ClaimEvent =
  | {
      kind: "created";
      id: string;
      at: string;
      actor: string;
    }
  | {
      kind: "assessment";
      id: string;
      at: string;
      actor: string;
      assessment_id: string;
      status: string;
      confidence: number;
      claim_credence: number | null;
      summary: string;
      trigger: string | null;
      trigger_context: string | null;
      is_current: boolean;
      // What this assessment superseded — null on the first one. Computed
      // here so clients can render "verified → supported" without holding
      // the whole history.
      prev_status: string | null;
      prev_confidence: number | null;
    }
  | {
      kind: "contribution";
      id: string;
      at: string;
      actor: string;
      contribution_id: string;
      contribution_type: string;
      content: string;
      evidence_urls: string[];
      // Current disposition, denormalized so a paginated window that has
      // dropped the review event still shows how the exchange ended.
      review_status: string;
    }
  | {
      kind: "review";
      id: string;
      at: string;
      actor: string;
      review_id: string;
      contribution_id: string;
      contribution_type: string | null;
      decision: string;
      reasoning: string;
      confidence: number;
      policy_citations: string[];
      suspected_bad_faith: boolean;
    }
  | {
      kind: "appeal";
      id: string;
      at: string;
      actor: string;
      appeal_id: string;
      contribution_id: string;
      reasoning: string;
      status: string;
    }
  | {
      kind: "arbitration";
      id: string;
      at: string;
      actor: string;
      arbitration_id: string;
      contribution_id: string;
      appeal_id: string | null;
      outcome: string;
      reasoning: string;
      consensus_achieved: boolean | null;
      human_review_recommended: boolean;
    }
  | {
      kind: "steward_note";
      id: string;
      at: string;
      actor: string;
      audit_id: string;
      action: string;
      reasoning: string;
    }
  | FormalizationEvent
  | LeanCheckEvent
  | PrizeEvent
  | AttemptEvent;

/** A formal statement changed state (docs/mathematics.md §5). */
export interface FormalizationEvent {
  kind: "formalization";
  id: string;
  at: string;
  actor: string;
  claim_id: string;
  subtype: "reviewed" | "published" | "retired" | "returned_to_draft";
  formalization_id: string;
  version: number;
  status: string;
  namespace: string;
  pin_id: string;
  source_hash: string;
  expr_hash: string;
  review_period_ends_at: string | null;
  reason: string | null;
}

/** The checker returned a verdict on a submission (§5.2). */
export interface LeanCheckEvent {
  kind: "lean_check";
  id: string;
  at: string;
  actor: string;
  claim_id: string;
  lean_check_id: string;
  formalization_id: string;
  mode: string;
  check_kind: string;
  verdict: string;
  failed_gate: string | null;
  pin_id: string;
  submission_sha256: string;
}

/**
 * A bounty or a prize claim moved (§8). The prize slice emits these as
 * they happen; the read model derives them from the rows.
 */
export interface PrizeEvent {
  kind: "prize";
  id: string;
  at: string;
  actor: string;
  claim_id: string;
  subtype:
    | "bounty_requested"
    | "bounty_opened"
    | "bounty_resolved"
    | "claim_filed"
    | "claim_decided";
  bounty_id: string | null;
  prize_claim_id: string | null;
  formalization_id: string | null;
  amount_micro_usd: number | null;
  status: string;
  direction: string | null;
  credit_name: string | null;
  rules_version: string | null;
}

/** The house solver started or finished an attempt (§7). */
export interface AttemptEvent {
  kind: "attempt";
  id: string;
  at: string;
  actor: string;
  claim_id: string;
  subtype: "started" | "finished" | "published";
  attempt_id: string;
  formalization_id: string;
  variant: string;
  effort: string;
  status: string;
  outcome: string | null;
  spent_micro_usd: number;
  is_calibration: boolean;
}

// Structural row types — the drizzle $inferSelect shapes the composer needs,
// declared loosely so tests can pass plain objects. The mathematics rows are
// optional: a claim outside the domain composes exactly as before.
export interface ClaimEventsInput {
  claim: { id: string; createdBy: string; createdAt: Date };
  assessments: Array<{
    id: string;
    status: string;
    confidence: number;
    claimCredence: number | null;
    summary: string | null;
    reasoningTrace: string;
    isCurrent: boolean;
    trigger: string | null;
    triggerContext: string | null;
    assessedAt: Date;
  }>;
  contributions: Array<{
    id: string;
    contributorId: string;
    contributionType: string;
    content: string;
    evidenceUrls: string[];
    reviewStatus: string;
    submittedAt: Date;
  }>;
  reviews: Array<{
    id: string;
    contributionId: string;
    decision: string;
    reasoning: string;
    confidence: number;
    policyCitations: string[];
    suspectedBadFaith: boolean;
    reviewedAt: Date;
    reviewedBy: string;
  }>;
  appeals: Array<{
    id: string;
    contributionId: string;
    appellantId: string;
    appealReasoning: string;
    status: string;
    submittedAt: Date;
  }>;
  arbitrations: Array<{
    id: string;
    contributionId: string;
    appealId: string | null;
    outcome: string;
    reasoning: string;
    consensusAchieved: boolean | null;
    humanReviewRecommended: boolean;
    arbitratedAt: Date;
    arbitratedBy: string;
  }>;
  auditEntries: Array<{
    id: string;
    action: string;
    reasoning: string;
    createdBy: string;
    createdAt: Date;
  }>;
  formalizations?: Array<{
    id: string;
    version: number;
    status: string;
    namespace: string;
    pinId: string;
    sourceHash: string;
    exprHash: string;
    authoredBy: string;
    reviewedAt: Date | null;
    publishedAt: Date | null;
    reviewPeriodEndsAt: Date | null;
    retiredAt: Date | null;
    retireReason: string | null;
  }>;
  leanChecks?: Array<{
    id: string;
    formalizationId: string;
    mode: string;
    kind: string;
    verdict: string;
    checks: unknown;
    submittedBy: string;
    pinId: string;
    submissionSha256: string;
    createdAt: Date;
    finishedAt: Date | null;
  }>;
  bounties?: Array<{
    id: string;
    formalizationId: string;
    amountMicroUsd: number;
    status: string;
    rulesVersion: string;
    requestedAt: Date;
    openedAt: Date | null;
    resolvedAt: Date | null;
  }>;
  prizeClaims?: Array<{
    id: string;
    bountyId: string;
    formalizationId: string;
    direction: string;
    status: string;
    creditName: string | null;
    rulesVersion: string;
    submittedAt: Date;
    updatedAt: Date;
  }>;
  attempts?: Array<{
    id: string;
    formalizationId: string;
    variant: string;
    effort: string;
    status: string;
    outcome: string | null;
    spentMicroUsd: number;
    isCalibration: boolean;
    startedAt: Date;
    finishedAt: Date | null;
    publishedAt: Date | null;
  }>;
}

// Tie-break rank for events sharing a timestamp, in causal order: a claim
// exists before it is assessed; a contribution precedes the decision on it;
// a statement precedes the check on it, and a check precedes the attempt or
// prize decision that cites it.
const KIND_ORDER: Record<ClaimEvent["kind"], number> = {
  created: 0,
  contribution: 1,
  review: 2,
  appeal: 3,
  arbitration: 4,
  assessment: 5,
  steward_note: 6,
  formalization: 7,
  lean_check: 8,
  attempt: 9,
  prize: 10,
};

const TERMINAL_PRIZE_CLAIM = new Set([
  "paid",
  "rejected",
  "voided",
  "withdrawn",
  "superseded",
  "forfeited",
]);

function failedGate(checks: unknown): string | null {
  if (!checks || typeof checks !== "object") return null;
  for (const [gate, record] of Object.entries(checks as Record<string, { status?: string }>)) {
    if (record && record.status === "fail") return gate;
  }
  return null;
}

/**
 * Audit-log actions the prize path writes for itself: bounty transitions
 * (`bounty:*`, bounty-service), prize-claim transitions and notes
 * (`prize_claim:*`, prize-claim-service), and the money routes
 * (`prize_route:*`, routes/prizes). Each is already a `prize` event derived
 * from its row, so it is not also a steward note.
 */
export const PRIZE_AUDIT_ACTION_PREFIXES = ["bounty:", "prize_claim:", "prize_route:"] as const;

export function isPrizeAuditAction(action: string): boolean {
  return PRIZE_AUDIT_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix));
}

export function composeClaimEvents(input: ClaimEventsInput): ClaimEvent[] {
  const events: ClaimEvent[] = [];

  events.push({
    kind: "created",
    id: `created:${input.claim.id}`,
    at: input.claim.createdAt.toISOString(),
    actor: input.claim.createdBy,
  });

  const byTime = [...input.assessments].sort(
    (a, b) => a.assessedAt.getTime() - b.assessedAt.getTime()
  );
  byTime.forEach((a, i) => {
    const prev = byTime[i - 1] ?? null;
    events.push({
      kind: "assessment",
      id: `assessment:${a.id}`,
      at: a.assessedAt.toISOString(),
      // Assessments carry no author column; the Steward is the only writer.
      actor: "claim_steward",
      assessment_id: a.id,
      status: a.status,
      confidence: a.confidence,
      claim_credence: a.claimCredence ?? null,
      // Reader-facing body; fall back to the reasoning trace for assessments
      // written before the summary/reasoning split (nullable column).
      summary: a.summary ?? a.reasoningTrace,
      trigger: a.trigger,
      trigger_context: a.triggerContext,
      is_current: a.isCurrent,
      prev_status: prev?.status ?? null,
      prev_confidence: prev?.confidence ?? null,
    });
  });

  const contributionTypeById = new Map(
    input.contributions.map((c) => [c.id, c.contributionType])
  );

  for (const c of input.contributions) {
    events.push({
      kind: "contribution",
      id: `contribution:${c.id}`,
      at: c.submittedAt.toISOString(),
      actor: c.contributorId,
      contribution_id: c.id,
      contribution_type: c.contributionType,
      content: c.content,
      evidence_urls: c.evidenceUrls,
      review_status: c.reviewStatus,
    });
  }

  for (const r of input.reviews) {
    events.push({
      kind: "review",
      id: `review:${r.id}`,
      at: r.reviewedAt.toISOString(),
      actor: r.reviewedBy,
      review_id: r.id,
      contribution_id: r.contributionId,
      contribution_type: contributionTypeById.get(r.contributionId) ?? null,
      decision: r.decision,
      reasoning: r.reasoning,
      confidence: r.confidence,
      policy_citations: r.policyCitations,
      suspected_bad_faith: r.suspectedBadFaith,
    });
  }

  for (const ap of input.appeals) {
    events.push({
      kind: "appeal",
      id: `appeal:${ap.id}`,
      at: ap.submittedAt.toISOString(),
      actor: ap.appellantId,
      appeal_id: ap.id,
      contribution_id: ap.contributionId,
      reasoning: ap.appealReasoning,
      status: ap.status,
    });
  }

  for (const arb of input.arbitrations) {
    events.push({
      kind: "arbitration",
      id: `arbitration:${arb.id}`,
      at: arb.arbitratedAt.toISOString(),
      actor: arb.arbitratedBy,
      arbitration_id: arb.id,
      contribution_id: arb.contributionId,
      appeal_id: arb.appealId ?? null,
      outcome: arb.outcome,
      reasoning: arb.reasoning,
      consensus_achieved: arb.consensusAchieved ?? null,
      human_review_recommended: arb.humanReviewRecommended,
    });
  }

  for (const entry of input.auditEntries) {
    // The prize path writes its own audit_log rows for every bounty and
    // prize-claim transition and every money route; those already surface
    // as `prize` events from the rows themselves, so they are not repeated
    // as steward notes.
    if (isPrizeAuditAction(entry.action)) continue;
    events.push({
      kind: "steward_note",
      id: `steward_note:${entry.id}`,
      at: entry.createdAt.toISOString(),
      actor: entry.createdBy,
      audit_id: entry.id,
      action: entry.action,
      reasoning: entry.reasoning,
    });
  }

  // A statement's lifecycle, one event per recorded transition: the row
  // keeps the timestamps, so the record is reproducible from it.
  for (const f of input.formalizations ?? []) {
    const base = {
      kind: "formalization" as const,
      actor: f.authoredBy,
      claim_id: input.claim.id,
      formalization_id: f.id,
      version: f.version,
      status: f.status,
      namespace: f.namespace,
      pin_id: f.pinId,
      source_hash: f.sourceHash,
      expr_hash: f.exprHash,
      review_period_ends_at: f.reviewPeriodEndsAt?.toISOString() ?? null,
    };
    if (f.reviewedAt) {
      events.push({
        ...base,
        id: `formalization:${f.id}:reviewed`,
        at: f.reviewedAt.toISOString(),
        subtype: "reviewed",
        reason: null,
      });
    }
    if (f.publishedAt) {
      events.push({
        ...base,
        id: `formalization:${f.id}:published`,
        at: f.publishedAt.toISOString(),
        subtype: "published",
        reason: null,
      });
    }
    if (f.retiredAt) {
      events.push({
        ...base,
        id: `formalization:${f.id}:retired`,
        at: f.retiredAt.toISOString(),
        subtype: "retired",
        reason: f.retireReason ?? null,
      });
    }
  }

  for (const lc of input.leanChecks ?? []) {
    events.push({
      kind: "lean_check",
      id: `lean_check:${lc.id}`,
      at: (lc.finishedAt ?? lc.createdAt).toISOString(),
      actor: lc.submittedBy,
      claim_id: input.claim.id,
      lean_check_id: lc.id,
      formalization_id: lc.formalizationId,
      mode: lc.mode,
      check_kind: lc.kind,
      verdict: lc.verdict,
      failed_gate: lc.verdict === "rejected" ? failedGate(lc.checks) : null,
      pin_id: lc.pinId,
      submission_sha256: lc.submissionSha256,
    });
  }

  for (const b of input.bounties ?? []) {
    const base = {
      kind: "prize" as const,
      actor: "minerval",
      claim_id: input.claim.id,
      bounty_id: b.id,
      prize_claim_id: null,
      formalization_id: b.formalizationId,
      amount_micro_usd: Number(b.amountMicroUsd),
      status: b.status,
      direction: null,
      credit_name: null,
      rules_version: b.rulesVersion,
    };
    events.push({
      ...base,
      id: `prize:bounty:${b.id}:requested`,
      at: b.requestedAt.toISOString(),
      subtype: "bounty_requested",
    });
    if (b.openedAt) {
      events.push({
        ...base,
        id: `prize:bounty:${b.id}:opened`,
        at: b.openedAt.toISOString(),
        subtype: "bounty_opened",
      });
    }
    if (b.resolvedAt) {
      events.push({
        ...base,
        id: `prize:bounty:${b.id}:resolved`,
        at: b.resolvedAt.toISOString(),
        subtype: "bounty_resolved",
      });
    }
  }

  for (const pc of input.prizeClaims ?? []) {
    const base = {
      kind: "prize" as const,
      actor: pc.creditName ?? "claimant",
      claim_id: input.claim.id,
      bounty_id: pc.bountyId,
      prize_claim_id: pc.id,
      formalization_id: pc.formalizationId,
      amount_micro_usd: null,
      status: pc.status,
      direction: pc.direction,
      credit_name: pc.creditName ?? null,
      rules_version: pc.rulesVersion,
    };
    events.push({
      ...base,
      id: `prize:claim:${pc.id}:filed`,
      at: pc.submittedAt.toISOString(),
      subtype: "claim_filed",
    });
    if (TERMINAL_PRIZE_CLAIM.has(pc.status) && pc.updatedAt.getTime() > pc.submittedAt.getTime()) {
      events.push({
        ...base,
        id: `prize:claim:${pc.id}:decided`,
        at: pc.updatedAt.toISOString(),
        subtype: "claim_decided",
      });
    }
  }

  for (const a of input.attempts ?? []) {
    const base = {
      kind: "attempt" as const,
      actor: "math_solver",
      claim_id: input.claim.id,
      attempt_id: a.id,
      formalization_id: a.formalizationId,
      variant: a.variant,
      effort: a.effort,
      status: a.status,
      outcome: a.outcome ?? null,
      spent_micro_usd: Number(a.spentMicroUsd),
      is_calibration: a.isCalibration,
    };
    events.push({
      ...base,
      id: `attempt:${a.id}:started`,
      at: a.startedAt.toISOString(),
      subtype: "started",
    });
    if (a.finishedAt) {
      events.push({
        ...base,
        id: `attempt:${a.id}:finished`,
        at: a.finishedAt.toISOString(),
        subtype: "finished",
      });
    }
    if (a.publishedAt) {
      events.push({
        ...base,
        id: `attempt:${a.id}:published`,
        at: a.publishedAt.toISOString(),
        subtype: "published",
      });
    }
  }

  // Newest first, matching the assessments endpoint; causal kind order breaks
  // same-timestamp ties (so creation never sorts after the first assessment).
  return events.sort(
    (a, b) =>
      b.at.localeCompare(a.at) || KIND_ORDER[b.kind] - KIND_ORDER[a.kind]
  );
}

export async function getClaimEvents(
  claim: { id: string; createdBy: string; createdAt: Date },
  options: { limit?: number; offset?: number } = {}
): Promise<{ events: ClaimEvent[]; total: number }> {
  const db = getDb();
  const { limit = 50, offset = 0 } = options;

  const [
    assessmentRows,
    contributionRows,
    auditRows,
    formalizationRows,
    bountyRows,
    prizeClaimRows,
    attemptRows,
  ] = await Promise.all([
    db.select().from(assessments).where(eq(assessments.claimId, claim.id)),
    db.select().from(contributions).where(eq(contributions.claimId, claim.id)),
    db.select().from(auditLog).where(eq(auditLog.claimId, claim.id)),
    db.select().from(claimFormalizations).where(eq(claimFormalizations.claimId, claim.id)),
    db.select().from(bounties).where(eq(bounties.claimId, claim.id)),
    db.select().from(prizeClaims).where(eq(prizeClaims.claimId, claim.id)),
    db.select().from(proofAttempts).where(eq(proofAttempts.claimId, claim.id)),
  ]);

  const contributionIds = contributionRows.map((c) => c.id);
  const [reviewRows, appealRows, arbitrationRows] =
    contributionIds.length > 0
      ? await Promise.all([
          db
            .select()
            .from(contributionReviews)
            .where(inArray(contributionReviews.contributionId, contributionIds)),
          db
            .select()
            .from(appeals)
            .where(inArray(appeals.contributionId, contributionIds)),
          db
            .select()
            .from(arbitrationResults)
            .where(inArray(arbitrationResults.contributionId, contributionIds)),
        ])
      : [[], [], []];

  const formalizationIds = formalizationRows.map((f) => f.id);
  const leanCheckRows =
    formalizationIds.length > 0
      ? await db
          .select()
          .from(leanChecks)
          .where(inArray(leanChecks.formalizationId, formalizationIds))
      : [];

  const events = composeClaimEvents({
    claim,
    assessments: assessmentRows,
    contributions: contributionRows,
    reviews: reviewRows,
    appeals: appealRows,
    arbitrations: arbitrationRows,
    auditEntries: auditRows,
    formalizations: formalizationRows,
    leanChecks: leanCheckRows,
    bounties: bountyRows,
    prizeClaims: prizeClaimRows,
    attempts: attemptRows,
  });

  return { events: events.slice(offset, offset + limit), total: events.length };
}

// ---------------------------------------------------------------------------
// Firing events as they happen
// ---------------------------------------------------------------------------

export type ClaimEventListener = (event: ClaimEvent) => void | Promise<void>;

const listeners = new Set<ClaimEventListener>();

/** Register a listener for events fired by the writers; returns the unsubscribe. */
export function subscribeClaimEvents(listener: ClaimEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fire a claim event. The write that produced it has already committed;
 * the event is the notification, and a listener that throws never fails
 * the write that fired it.
 */
export async function emitClaimEvent(event: ClaimEvent): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(event);
    } catch (err) {
      console.error(
        `[claim-events] listener failed on ${event.kind} ${event.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
