/**
 * Action tools for the Contribution Reviewer agent.
 *
 * These let the reviewer record decisions (escalation included) and hand an
 * accepted contribution to the claim's Steward, all through tool calls.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  acceptanceSchemaProperties,
  applyAcceptanceEffects,
} from "../../services/contribution-acceptance.js";
import {
  contributions,
  contributionReviews,
} from "../../db/schema.js";
import {
  enqueueArbitration,
  requestAudit,
} from "../../services/queue-service.js";
import {
  executeNotifyClaimSteward,
  getNotifyClaimStewardToolDefinition,
  NOTIFY_CLAIM_STEWARD,
} from "./notify-claim-steward.js";
import {
  applyReviewOutcome,
  BAD_FAITH_CATEGORIES,
} from "../../services/reputation-service.js";
import type { IntakeMaterializationResult } from "../../services/intake-service.js";
import { getContributionById } from "../../services/contribution-service.js";
import {
  admitPrizeClaim,
  prizeClaimReviewBlock,
  rejectPrizeClaimAtReview,
} from "../../services/prize-claim-service.js";

export function getReviewerToolDefinitions(): Tool[] {
  return [
    {
      name: "record_review_decision",
      description:
        "Record your review decision for a contribution. This writes the " +
        "decision to the database and updates the contribution's review " +
        "status. Escalating also places the case in the Dispute " +
        "Arbitrator's queue, with escalation_reason on the contribution. " +
        "Accepting an intake contribution (propose_claim, " +
        "propose_question, propose_source) also materializes it here: the Matcher decides " +
        "identity, then the claim is created or the source queued for " +
        "extraction, and the outcome is reported in the tool result.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the contribution being reviewed",
          },
          decision: {
            type: "string",
            enum: ["accept", "reject", "escalate"],
            description: "Your decision",
          },
          reasoning: {
            type: "string",
            description:
              "Your reasoning: the contributor's hearing and the record an " +
              "auditor checks. On a rejection, say what a resubmission would " +
              "need, and exactly what to clarify where clarification would fix it.",
          },
          escalation_reason: {
            type: "string",
            description:
              "Required with 'escalate': the open question the Arbitrator is " +
              "asked to settle, in a sentence or two. Your reasoning above " +
              "carries the rest.",
          },
          confidence: {
            type: "number",
            description: "Confidence in this decision (0.0-1.0)",
          },
          policy_citations: {
            type: "array",
            items: { type: "string" },
            description:
              "Constitution sections the decision rests on, e.g. \"§2\", " +
              "\"§13\", \"Part VIII\"",
          },
          suspected_bad_faith: {
            type: "boolean",
            description:
              "Only with 'reject': a finding of deliberate abuse under §13, " +
              "as your role prompt sets out; never for a sincere contribution " +
              "rejected on the merits. Requires bad_faith_category.",
          },
          bad_faith_category: {
            type: "string",
            enum: [...BAD_FAITH_CATEGORIES],
            description:
              "Required when suspected_bad_faith is true: which kind of abuse.",
          },
          ...acceptanceSchemaProperties(),
        },
        required: [
          "contribution_id",
          "decision",
          "reasoning",
          "confidence",
          "policy_citations",
        ],
      },
    },
    {
      name: "get_prize_claim_details",
      description:
        "The prize_claim block for a claim_prize contribution (docs/" +
        "mathematics.md §8.4): the bounty, the statement version and its " +
        "pretty type, the direction, the tools disclosure, the declarations, " +
        "the attachments with sizes and hashes, the checker record, a " +
        "bounded comment-stripped excerpt of the Lean source, and " +
        "duplicate_of references when the same bytes were submitted earlier " +
        "by another account. Read it beside get_contribution_details before " +
        "deciding. You judge form, good faith, identity, and duplicates, " +
        "never the proof: the checker's verdict is already in hand. Never " +
        "call notify_claim_steward for a prize claim; admission itself " +
        "brings the Steward.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the claim_prize contribution",
          },
        },
        required: ["contribution_id"],
      },
    },
    getNotifyClaimStewardToolDefinition("contribution_reviewer"),
  ];
}

export async function executeReviewerTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  try {
    switch (toolName) {
      case "record_review_decision": {
        const contributionId = input.contribution_id as string;
        const decision = input.decision as "accept" | "reject" | "escalate";
        const reasoning = input.reasoning as string;
        const confidence = input.confidence as number;
        const policyCitations = (input.policy_citations as string[]) ?? [];
        // A bad-faith flag is only coherent on a rejection; anything else is
        // recorded as flag-free so the flag's consequences can't fire by
        // accident (#71: sincere contributions must never pay).
        const suspectedBadFaith =
          input.suspected_bad_faith === true && decision === "reject";
        // Which kind of abuse is the reviewer's judgment; code must not
        // fabricate one by default (#179). Refuse the call before any write
        // so the reviewer can restate the decision with the category.
        if (
          suspectedBadFaith &&
          !BAD_FAITH_CATEGORIES.includes(
            input.bad_faith_category as (typeof BAD_FAITH_CATEGORIES)[number]
          )
        ) {
          return JSON.stringify({
            success: false,
            error:
              "suspected_bad_faith requires bad_faith_category (one of: " +
              BAD_FAITH_CATEGORIES.join(", ") +
              "). Nothing was recorded. Repeat the call naming the kind of " +
              "abuse you found, or drop the flag if none applies.",
          });
        }
        const badFaithCategory = suspectedBadFaith
          ? (input.bad_faith_category as string)
          : null;
        // An escalation is one call (#717): the decision, the reason the
        // Arbitrator reads first (#178), and the enqueue. Checked before
        // anything is written.
        const escalationReason =
          typeof input.escalation_reason === "string" ? input.escalation_reason.trim() : "";
        if (decision === "escalate" && !escalationReason) {
          return JSON.stringify({
            success: false,
            error:
              "Escalating needs escalation_reason: the open question for the " +
              "Arbitrator. Nothing was recorded.",
          });
        }

        const db = getDb();

        // A prize claim (docs/mathematics.md §8.4) branches before the
        // ordinary outcome: accept ADMITS it — the review row is written,
        // the prize claim moves to in_review, and no credit is applied (the
        // accepted-contribution award waits for the Steward's accept);
        // reject is the ordinary path with the prize claim marked rejected
        // at stage review; escalate goes to the Arbitrator, whose overturn
        // admits. A challenge against an accepted prize claim that the
        // Reviewer accepts is escalated mechanically: accepting the case is
        // not upholding it, and the admission pauses the window.
        const reviewed = await getContributionById(contributionId);
        if (reviewed?.contributionType === "claim_prize" && decision === "accept") {
          const admitted = await admitPrizeClaim({
            contributionId,
            review: { reasoning, confidence, policyCitations },
            actor: "contribution_reviewer",
          });
          if (!admitted.ok) {
            return JSON.stringify({ success: false, error: admitted.message });
          }
          return JSON.stringify({
            success: true,
            message:
              `Prize claim ${admitted.prize_claim_id} admitted (in_review); no credit applied. ` +
              `The Claim Steward now judges fidelity directly; do not call notify_claim_steward.`,
            prize_claim_id: admitted.prize_claim_id,
          });
        }
        const challengedPrizeClaimId =
          (reviewed as { challengedPrizeClaimId?: string | null } | null)?.challengedPrizeClaimId ?? null;
        if (
          reviewed?.contributionType === "challenge" &&
          challengedPrizeClaimId &&
          decision === "accept"
        ) {
          const [review] = await db
            .insert(contributionReviews)
            .values({
              contributionId,
              decision: "accept",
              reasoning,
              confidence,
              policyCitations,
              suspectedBadFaith: false,
              badFaithCategory: null,
              reviewedBy: "contribution_reviewer",
            })
            .returning();
          await db
            .update(contributions)
            .set({ reviewStatus: "escalated", escalationReason: `admitted challenge against prize claim ${challengedPrizeClaimId}: ${reasoning.slice(0, 500)}`, reviewClaimedAt: null, reviewAttempts: 0 })
            .where(eq(contributions.id, contributionId));
          await enqueueArbitration({ contributionId, trigger: "escalated_review" });
          return JSON.stringify({
            success: true,
            message:
              `Challenge ${contributionId} admitted and escalated to the Dispute Arbitrator; ` +
              `the prize claim's window is paused while the case is open (review ${review?.id}).`,
          });
        }

        // What accepting does beyond the record (#724): a proposed request
        // is filed, material offered for one is recorded as work on it, and
        // an intake proposal is materialized through the Matcher (#157). The
        // same service runs on an Arbitrator's overturn. It runs before the
        // review is recorded so a refusal or failure surfaces to the reviewer
        // instead of stranding an "accepted" contribution that never took
        // effect (materialization is idempotent, so a retry is safe).
        let materialization: IntakeMaterializationResult | null = null;
        let requestNote = "";
        if (decision === "accept") {
          const effects = await applyAcceptanceEffects(contributionId, input);
          if (!effects.ok) return JSON.stringify({ success: false, error: effects.error });
          materialization = effects.materialization;
          requestNote = effects.note;
        }

        // Write review record
        const [review] = await db
          .insert(contributionReviews)
          .values({
            contributionId,
            decision,
            reasoning,
            confidence,
            policyCitations,
            suspectedBadFaith,
            badFaithCategory,
            reviewedBy: "contribution_reviewer",
          })
          .returning();

        // Update contribution status. The claim/attempt columns reset so the
        // escalated->arbitration phase, when there is one, starts with a fresh
        // recovery budget (#218); on terminal decisions the reset is inert.
        await db
          .update(contributions)
          .set({
            reviewStatus: decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "escalated",
            ...(decision === "escalate" ? { escalationReason } : {}),
            reviewClaimedAt: null,
            reviewAttempts: 0,
          })
          .where(eq(contributions.id, contributionId));
        if (decision === "escalate") {
          await enqueueArbitration({ contributionId, trigger: "escalated_review" });
        }

        if (reviewed?.contributionType === "claim_prize" && decision === "reject") {
          await rejectPrizeClaimAtReview(contributionId, "contribution_reviewer", reasoning.slice(0, 500));
        }

        // Counters, reputation ledger, standing, and owl awards — one write path
        // in the reputation service (#71).
        const outcome = await applyReviewOutcome({
          contributionId,
          reviewId: review?.id ?? null,
          decision,
          suspectedBadFaith,
          badFaithCategory,
        });

        // A bad-faith flag is the reviewer's highest-stakes judgment, so the
        // constitution's "reviews high-stakes cases fully" becomes concrete
        // here: every flag gets a decision audit (#180). At most one per
        // contribution, and a failure to enqueue must not fail the review
        // that was already recorded.
        if (suspectedBadFaith) {
          try {
            await requestAudit({
              auditType: "decision_audit",
              context:
                `A bad-faith flag (${badFaithCategory}) was applied to ` +
                `contribution ${contributionId}. Audit the decision fully: ` +
                `does the evidence clear the deliberate-abuse bar, and is ` +
                `the contributor's wider record consistent with it?`,
              triggeredBy: "bad_faith_flag",
              dedupeKey: `bad-faith:${contributionId}`,
            });
          } catch (auditErr) {
            console.error(
              "Failed to request bad-faith audit:",
              auditErr instanceof Error ? auditErr.message : auditErr
            );
          }
        }

        return JSON.stringify({
          success: true,
          message: `Review decision '${decision}' recorded for contribution ${contributionId}.${requestNote}`,
          ...(materialization ? { materialization } : {}),
          ...(input.suspected_bad_faith === true && !suspectedBadFaith
            ? {
                note: "suspected_bad_faith was ignored because the decision is not 'reject'",
              }
            : {}),
          ...(outcome
            ? {
                contributor: {
                  reputation: outcome.newScore,
                  standing: outcome.standing,
                  suspended: outcome.suspended,
                  owls_awarded: outcome.owlsAwarded,
                },
              }
            : {}),
        });
      }

      case "get_prize_claim_details": {
        const block = await prizeClaimReviewBlock(input.contribution_id as string);
        if (!block) {
          return JSON.stringify({
            success: false,
            message: `Contribution ${input.contribution_id} is not a prize claim`,
          });
        }
        return JSON.stringify({ success: true, prize_claim: block }, null, 2);
      }

      case NOTIFY_CLAIM_STEWARD:
        return executeNotifyClaimSteward(input, "contribution_reviewer");

      default:
        return `Error: Unknown reviewer tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
