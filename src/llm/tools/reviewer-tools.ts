/**
 * Action tools for the Contribution Reviewer agent.
 *
 * These let the reviewer record decisions, provide feedback, escalate disputes,
 * and notify the claim steward -- all through tool calls.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  contributions,
  contributionReviews,
} from "../../db/schema.js";
import {
  enqueueArbitration,
  enqueueSteward,
  requestAudit,
} from "../../services/queue-service.js";
import {
  applyReviewOutcome,
  BAD_FAITH_CATEGORIES,
} from "../../services/reputation-service.js";
import {
  isIntakeContributionType,
  materializeAcceptedIntake,
  type IntakeMaterializationResult,
} from "../../services/intake-service.js";
import { getContributionById } from "../../services/contribution-service.js";

export function getReviewerToolDefinitions(): Tool[] {
  return [
    {
      name: "record_review_decision",
      description:
        "Record your review decision for a contribution. This writes the " +
        "decision to the database and updates the contribution's review " +
        "status. Accepting an intake contribution (propose_claim, " +
        "propose_source) also materializes it here: the Matcher decides " +
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
            description: "Detailed reasoning for your decision",
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
              "Set true ONLY with a 'reject' decision when the contribution " +
              "shows deliberate abuse (spam, vandalism, sybil coordination, " +
              "deliberate misinformation), NOT for sincere contributions " +
              "rejected on the merits. This flag has real consequences " +
              "(reputation penalty, pay-to-contribute standing) and is " +
              "appealable; when uncertain, reject without the flag or " +
              "escalate. Setting it requires bad_faith_category.",
          },
          bad_faith_category: {
            type: "string",
            enum: [...BAD_FAITH_CATEGORIES],
            description:
              "Required when suspected_bad_faith is true: which kind of abuse.",
          },
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
      name: "escalate_to_arbitrator",
      description:
        "Place a contribution in the dispute arbitrator's queue. Use when " +
        "uncertain, when stakes are high, or when the situation requires " +
        "deeper adjudication. This call is what enqueues arbitration, and " +
        "the reason given here is persisted on the contribution for the " +
        "arbitrator to read; also record the review itself with " +
        "record_review_decision (decision 'escalate'), which carries your " +
        "fuller reasoning of record.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the contribution to escalate",
          },
          reason: {
            type: "string",
            description: "Why this needs arbitration",
          },
        },
        required: ["contribution_id", "reason"],
      },
    },
    {
      name: "notify_claim_steward",
      description:
        "Notify the claim steward that a claim may need attention due to " +
        "a contribution being accepted or other change. Not for accepted " +
        "intake contributions: those enqueue their own follow-on work " +
        "during record_review_decision.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim to notify about",
          },
          change_type: {
            type: "string",
            enum: ["contribution_accepted", "new_challenge", "new_support"],
            description: "Type of change",
          },
          details: {
            type: "string",
            description: "Details about what changed and why steward attention is needed",
          },
        },
        required: ["claim_id", "change_type", "details"],
      },
    },
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

        const db = getDb();

        // Intake contributions (#157): an accept is what admits the content
        // into the graph, so materialize FIRST — the Matcher decides identity
        // (dedup/canonicalization), then the claim goes live or the source is
        // extracted. Deliberately mechanical: the reviewer judged the
        // suggestion; code applies it. Runs before the review is recorded so
        // a failure surfaces to the reviewer instead of stranding an
        // "accepted" contribution that never materialized (the call is
        // idempotent, so a retry after partial failure is safe).
        let materialization: IntakeMaterializationResult | null = null;
        if (decision === "accept") {
          const contribution = await getContributionById(contributionId);
          if (
            contribution &&
            isIntakeContributionType(contribution.contributionType)
          ) {
            materialization = await materializeAcceptedIntake(contributionId);
          }
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
            reviewClaimedAt: null,
            reviewAttempts: 0,
          })
          .where(eq(contributions.id, contributionId));

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
          message: `Review decision '${decision}' recorded for contribution ${contributionId}`,
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

      case "escalate_to_arbitrator": {
        const contributionId = input.contribution_id as string;
        const reason = input.reason as string;

        await enqueueArbitration({
          contributionId,
          trigger: "escalated_review",
        });

        // Update contribution status and persist the escalation reason (#178)
        // so the Arbitrator sees why the case was escalated even when no
        // review row was recorded.
        const db = getDb();
        await db
          .update(contributions)
          .set({
            reviewStatus: "escalated",
            escalationReason: reason,
            // Fresh recovery budget for the arbitration phase (#218).
            reviewClaimedAt: null,
            reviewAttempts: 0,
          })
          .where(eq(contributions.id, contributionId));

        return JSON.stringify({
          success: true,
          message: `Contribution ${contributionId} escalated to arbitrator. Reason: ${reason}`,
        });
      }

      case "notify_claim_steward": {
        const claimId = input.claim_id as string;
        const changeType = input.change_type as string;
        const details = input.details as string;

        await enqueueSteward({
          claimId,
          trigger: "contribution_accepted",
          context: `${changeType}: ${details}`,
        });

        return JSON.stringify({
          success: true,
          message: `Claim steward notified about claim ${claimId}`,
        });
      }

      default:
        return `Error: Unknown reviewer tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
