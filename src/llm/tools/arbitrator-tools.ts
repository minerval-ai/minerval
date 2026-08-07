/**
 * Action tools for the Dispute Arbitrator agent.
 *
 * These let the arbitrator record decisions, notify the claim steward,
 * and flag items for human review.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { eq } from "drizzle-orm";
import { getDb, rawQuery } from "../../db/client.js";
import {
  arbitrationResults,
  contributions,
  contributors,
  appeals,
} from "../../db/schema.js";
import { enqueueSteward, requestAudit } from "../../services/queue-service.js";
import {
  applyArbitrationOutcome,
  reverseReviewOutcome,
  AUDIT_SUSPENSION_PREFIX,
  BAD_FAITH_CATEGORIES,
} from "../../services/reputation-service.js";
import {
  isIntakeContributionType,
  materializeAcceptedIntake,
  type IntakeMaterializationResult,
} from "../../services/intake-service.js";
import { getContributionById } from "../../services/contribution-service.js";

export function getArbitratorToolDefinitions(): Tool[] {
  return [
    {
      name: "record_arbitration_decision",
      description:
        "Record your arbitration decision. This writes the outcome, updates " +
        "the contribution and appeal status, and applies the consequences " +
        "mechanically: on an overturn the contributor is restored " +
        "(reputation, standing, any reputation-imposed suspension) and an " +
        "intake contribution is materialized through the Matcher; when the " +
        "case arrived by escalation and no outcome was ever applied, the " +
        "final accept or reject consequences (reputation, owl awards, and a " +
        "bad-faith finding's penalty and standing when you attach one) are " +
        "applied directly. Results are reported in the tool result.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the contribution being arbitrated",
          },
          appeal_id: {
            type: "string",
            description:
              "The UUID of the appeal, if this is an appeal arbitration. " +
              "Always include it when one was given: recording the decision " +
              "with this id is what resolves the appeal.",
          },
          outcome: {
            type: "string",
            enum: [
              "uphold_original",
              "overturn",
              "modify",
              "mark_contested",
              "human_review",
            ],
            description: "The arbitration outcome",
          },
          decision: {
            type: "string",
            description: "Summary of the decision",
          },
          reasoning: {
            type: "string",
            description: "Detailed reasoning for the decision",
          },
          policy_citations: {
            type: "array",
            items: { type: "string" },
            description: "Policy codes cited in the decision",
          },
          suspected_bad_faith: {
            type: "boolean",
            description:
              "Set true ONLY with an 'uphold_original' outcome when the full " +
              "case record shows deliberate abuse (spam, vandalism, sybil " +
              "coordination, deliberate misinformation), NOT for sincere " +
              "contributions rejected on the merits. §13's high bar applies. " +
              "The flag's consequences (reputation penalty, pay-to-contribute " +
              "standing) apply when the case arrived by escalation and the " +
              "outcome is being applied now; on an appeal of an " +
              "already-applied rejection the finding is recorded but adds no " +
              "late penalty. Appealable. Setting it requires " +
              "bad_faith_category.",
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
          "outcome",
          "decision",
          "reasoning",
        ],
      },
    },
    {
      name: "notify_claim_steward",
      description:
        "Notify the claim steward about the arbitration outcome so they " +
        "can update the claim accordingly.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim",
          },
          change_type: {
            type: "string",
            description: "Type of change resulting from arbitration",
          },
          details: {
            type: "string",
            description: "Details about the arbitration outcome",
          },
        },
        required: ["claim_id", "change_type", "details"],
      },
    },
    {
      name: "lift_suspension",
      description:
        "Lift a contributor's suspension. The mechanical restoration on an " +
        "overturn only lifts score-based suspensions; a deliberate audit " +
        "suspension needs this judgment call. Use it when adjudication shows " +
        "the suspension's basis no longer holds — an audit finding the " +
        "suspension cites is then marked resolved with your reasoning.",
      input_schema: {
        type: "object" as const,
        properties: {
          contributor_id: {
            type: "string",
            description: "The UUID of the suspended contributor",
          },
          reasoning: {
            type: "string",
            description: "Why the suspension should not stand",
          },
        },
        required: ["contributor_id", "reasoning"],
      },
    },
    {
      name: "flag_for_human_review",
      description:
        "Flag a specific contribution for human review. Use when the " +
        "situation is beyond what automated arbitration can handle.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the contribution to flag for human review",
          },
          reason: {
            type: "string",
            description: "Why human review is needed",
          },
        },
        required: ["contribution_id", "reason"],
      },
    },
  ];
}

export async function executeArbitratorTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  try {
    switch (toolName) {
      case "record_arbitration_decision": {
        const contributionId = input.contribution_id as string;
        const appealId = input.appeal_id as string | undefined;
        const outcome = input.outcome as string;
        const decision = input.decision as string;
        const reasoning = input.reasoning as string;

        const db = getDb();
        const policyCitations = (input.policy_citations as string[] | undefined) ?? [];

        // A bad-faith finding is only coherent when the rejection stands
        // (#213); on any other outcome it is recorded as flag-free so the
        // flag's consequences can't fire by accident — same guard as the
        // reviewer tool (#71: sincere contributions must never pay).
        const suspectedBadFaith =
          input.suspected_bad_faith === true && outcome === "uphold_original";
        // Which kind of abuse is the arbitrator's judgment; code must not
        // fabricate one by default (#179). Refuse the call before any write
        // so the arbitrator can restate the decision with the category.
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

        // An overturn that ACCEPTS an intake contribution (#157) must
        // materialize it, exactly as the reviewer's accept does — otherwise
        // an escalated proposal arbitrated in the contributor's favor would
        // read 'accepted' with nothing in the graph. Runs first so a failure
        // surfaces to the arbitrator; the call is idempotent.
        let materialization: IntakeMaterializationResult | null = null;
        if (outcome === "overturn") {
          const contribution = await getContributionById(contributionId);
          if (
            contribution &&
            isIntakeContributionType(contribution.contributionType)
          ) {
            materialization = await materializeAcceptedIntake(contributionId);
          }
        }

        await db.insert(arbitrationResults).values({
          contributionId,
          appealId: appealId ?? null,
          outcome,
          decision,
          reasoning: policyCitations.length > 0
            ? `${reasoning}\n\nPolicy citations: ${policyCitations.join(", ")}`
            : reasoning,
          suspectedBadFaith,
          badFaithCategory,
          humanReviewRecommended: outcome === "human_review",
          arbitratedBy: "dispute_arbitrator",
        });

        // Update contribution status based on outcome
        const reviewStatus =
          outcome === "overturn"
            ? "accepted"
            : outcome === "uphold_original"
              ? "rejected"
              : outcome === "mark_contested"
                ? "contested"
                : outcome === "human_review"
                  ? "human_review"
                  : "arbitrated";

        await db
          .update(contributions)
          .set({ reviewStatus })
          .where(eq(contributions.id, contributionId));

        // Update appeal status if applicable
        if (appealId) {
          await db
            .update(appeals)
            .set({ status: outcome === "human_review" ? "pending_human" : "resolved" })
            .where(eq(appeals.id, appealId));
        }

        // An overturned rejection restores the contributor (#71): reputation
        // penalties are compensated in the ledger, a bad-faith flag and its
        // must-pay standing are cleared, an auto-suspension lifts, and the
        // now-accepted contribution earns owls (with a survived-scrutiny
        // bonus). False-positive flags must not leave lasting damage.
        //
        // An escalated case has no penalties to reverse — an 'escalate'
        // review applies nothing — so when there is nothing to restore the
        // final decision is applied directly (#179): acceptance credit and
        // owls on an overturn, the ordinary rejection outcome on an uphold.
        // Both service calls are idempotent no-ops when the outcome was
        // already applied at review time or by a prior arbitration.
        let restoration = null;
        let resolution = null;
        if (outcome === "overturn") {
          restoration = await reverseReviewOutcome({ contributionId });
          if (!restoration) {
            resolution = await applyArbitrationOutcome({
              contributionId,
              finalDecision: "accept",
            });
          }

          // The second instance disagreed with the first — the strongest
          // routine signal the review was made badly. Request a decision
          // audit of the overturned review (#180); at most one per
          // contribution, and a failure to enqueue must not fail the
          // arbitration that was already recorded.
          try {
            await requestAudit({
              auditType: "decision_audit",
              context:
                `An appeal overturned the review of contribution ` +
                `${contributionId}. Audit the overturned decision: was it an ` +
                `isolated error, or part of a pattern across similar cases?`,
              triggeredBy: "arbitration_overturn",
              dedupeKey: `overturn:${contributionId}`,
            });
          } catch (auditErr) {
            console.error(
              "Failed to request overturn audit:",
              auditErr instanceof Error ? auditErr.message : auditErr
            );
          }
        } else if (outcome === "uphold_original") {
          resolution = await applyArbitrationOutcome({
            contributionId,
            finalDecision: "reject",
            suspectedBadFaith,
          });
        }

        return JSON.stringify({
          success: true,
          message: `Arbitration decision recorded: ${outcome} for contribution ${contributionId}`,
          ...(input.suspected_bad_faith === true && !suspectedBadFaith
            ? {
                note: "suspected_bad_faith was ignored because the outcome is not 'uphold_original'",
              }
            : {}),
          ...(suspectedBadFaith && !resolution
            ? {
                note:
                  "The bad-faith finding is recorded, but its consequences " +
                  "were not applied: the rejection's outcome was already " +
                  "applied at review time, and a late flag is not stacked on " +
                  "top of it.",
              }
            : {}),
          ...(materialization ? { materialization } : {}),
          ...(restoration
            ? {
                contributor_restored: {
                  reputation: restoration.newScore,
                  standing_restored: restoration.standingRestored,
                  unsuspended: restoration.unsuspended,
                  owls_awarded: restoration.owlsAwarded,
                },
              }
            : {}),
          ...(resolution
            ? {
                contributor_outcome_applied: {
                  reputation: resolution.newScore,
                  standing: resolution.standing,
                  suspended: resolution.suspended,
                  owls_awarded: resolution.owlsAwarded,
                },
              }
            : {}),
        });
      }

      case "notify_claim_steward": {
        const claimId = input.claim_id as string;
        const changeType = input.change_type as string;
        const details = input.details as string;

        // Not contribution_accepted (#182): an arbitration can overturn as
        // well as uphold, and the Steward should know it is integrating a
        // ruling, not an acceptance.
        await enqueueSteward({
          claimId,
          trigger: "arbitration_outcome",
          context: `Arbitration outcome - ${changeType}: ${details}`,
        });

        return JSON.stringify({
          success: true,
          message: `Claim steward notified about claim ${claimId}`,
        });
      }

      case "lift_suspension": {
        const contributorId = input.contributor_id as string;
        const reasoning = input.reasoning as string;

        const db = getDb();
        const [contributor] = await db
          .select({
            id: contributors.id,
            isSuspended: contributors.isSuspended,
            suspensionReason: contributors.suspensionReason,
          })
          .from(contributors)
          .where(eq(contributors.id, contributorId))
          .limit(1);

        if (!contributor) {
          return JSON.stringify({
            success: false,
            message: `Contributor ${contributorId} not found.`,
          });
        }
        if (!contributor.isSuspended) {
          return JSON.stringify({
            success: false,
            message: `Contributor ${contributorId} is not suspended.`,
          });
        }

        const previousReason = contributor.suspensionReason ?? "";
        await db
          .update(contributors)
          .set({ isSuspended: false, suspensionReason: null, suspendedAt: null })
          .where(eq(contributors.id, contributorId));

        // An audit suspension carries "audit:<finding_id> …" (#180); lifting
        // it resolves the finding it rested on, so the audit's records agree
        // with the contributor's standing.
        let resolvedFindingId: string | null = null;
        if (previousReason.startsWith(AUDIT_SUSPENSION_PREFIX)) {
          const findingId = previousReason
            .slice(AUDIT_SUSPENSION_PREFIX.length)
            .split(/\s/)[0];
          if (findingId) {
            const resolved = await rawQuery<{ id: string }>(
              `UPDATE audit_findings
               SET status = 'resolved', resolution_note = $1,
                   resolved_by = 'dispute_arbitrator', resolved_at = now()
               WHERE id = $2
               RETURNING id`,
              [`Suspension lifted by arbitration: ${reasoning}`, findingId]
            );
            resolvedFindingId = resolved[0]?.id ?? null;
          }
        }

        return JSON.stringify({
          success: true,
          message: `Suspension lifted for contributor ${contributorId}.`,
          ...(resolvedFindingId
            ? { resolved_finding_id: resolvedFindingId }
            : {}),
        });
      }

      case "flag_for_human_review": {
        const contributionId = input.contribution_id as string;
        const reason = input.reason as string;

        const db = getDb();
        await db
          .update(contributions)
          .set({ reviewStatus: "human_review" })
          .where(eq(contributions.id, contributionId));

        return JSON.stringify({
          success: true,
          message: `Contribution ${contributionId} flagged for human review: ${reason}`,
        });
      }

      default:
        return `Error: Unknown arbitrator tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
