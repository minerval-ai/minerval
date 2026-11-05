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
import { requestAudit } from "../../services/queue-service.js";
import {
  executeNotifyClaimSteward,
  getNotifyClaimStewardToolDefinition,
  NOTIFY_CLAIM_STEWARD,
} from "./notify-claim-steward.js";
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
        "applied directly. On a challenge to a prize claim, challenge_upheld " +
        "is required and must agree with the outcome. Results are reported " +
        "in the tool result.",
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
            description:
              "Constitution sections the decision rests on, e.g. \"§13\", " +
              "\"§14\", \"§24\"",
          },
          suspected_bad_faith: {
            type: "boolean",
            description:
              "Only with 'uphold_original': a finding of deliberate abuse " +
              "under §13, as your role prompt sets out. Its consequences apply " +
              "on an escalated case; on an appeal of a rejection already " +
              "applied it is recorded without a late penalty. Requires " +
              "bad_faith_category.",
          },
          bad_faith_category: {
            type: "string",
            enum: [...BAD_FAITH_CATEGORIES],
            description:
              "Required when suspected_bad_faith is true: which kind of abuse.",
          },
          challenge_upheld: {
            type: "boolean",
            description:
              "Only for a challenge to a prize claim, and required there with " +
              "overturn or uphold_original: whether the challenge succeeds on " +
              "its named ground. true goes with overturn (the prize claim is " +
              "voided on that ground); false with uphold_original (the " +
              "challenge fails and the prize claim's window runs on). A " +
              "mismatch is refused, so the words cannot invert.",
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
    getNotifyClaimStewardToolDefinition("dispute_arbitrator"),
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
        "Send a contribution to human review without recording an " +
        "arbitration. The reason is stored on the contribution for the " +
        "humans who pick it up. Once you have reached a judgment, prefer " +
        "record_arbitration_decision with the human_review outcome, so " +
        "your reasoning is on the record.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the contribution to flag for human review",
          },
          reason: {
            type: "string",
            description:
              "Why human review is needed, written for the person who will " +
              "take the case up.",
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

        // A challenge to a prize claim arrives with the Reviewer's ADMISSION
        // as the decision under review, so "uphold the original" reads as
        // "the challenge stands" while the tools take it as "the challenge
        // fails" (#710). The Arbitrator names the substance with
        // challenge_upheld and the tool refuses any outcome that disagrees.
        // Money moves on this: overturn voids the prize claim at the window
        // closer's next pass (prize-window-closer.ts).
        const target = await getContributionById(contributionId);
        const challengedPrizeClaimId =
          target?.contributionType === "challenge" ? (target.challengedPrizeClaimId ?? null) : null;
        let prizeNote: string | null = null;
        if (challengedPrizeClaimId) {
          const refusal = (why: string) =>
            JSON.stringify({ success: false, error: `${why} Nothing was recorded.` });
          if (outcome === "modify" || outcome === "mark_contested") {
            return refusal(
              `This is a challenge to prize claim ${challengedPrizeClaimId}, and it succeeds or ` +
                `it does not: overturn with challenge_upheld true, uphold_original with ` +
                `challenge_upheld false, or human_review.`
            );
          }
          if (outcome === "overturn" || outcome === "uphold_original") {
            if (typeof input.challenge_upheld !== "boolean") {
              return refusal(
                `This is a challenge to prize claim ${challengedPrizeClaimId}: say whether it ` +
                  `succeeds with challenge_upheld (true with overturn, false with uphold_original).`
              );
            }
            const expected = input.challenge_upheld ? "overturn" : "uphold_original";
            if (outcome !== expected) {
              return refusal(
                `challenge_upheld ${input.challenge_upheld} goes with outcome ${expected}, not ${outcome}. ` +
                  `overturn upholds the challenge and voids the prize claim; uphold_original rejects ` +
                  `the challenge and lets the window run on.`
              );
            }
            prizeNote = input.challenge_upheld
              ? `The challenge is upheld: prize claim ${challengedPrizeClaimId} is voided on its ground at the window closer's next pass, and its Steward reassesses.`
              : `The challenge is rejected: prize claim ${challengedPrizeClaimId}'s window runs on.`;
          }
        }

        // An overturn that ACCEPTS an intake contribution (#157) must
        // materialize it, exactly as the reviewer's accept does — otherwise
        // an escalated proposal arbitrated in the contributor's favor would
        // read 'accepted' with nothing in the graph. Runs first so a failure
        // surfaces to the arbitrator; the call is idempotent.
        let materialization: IntakeMaterializationResult | null = null;
        if (outcome === "overturn") {
          const contribution = target;
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
            ? `${reasoning}\n\nCites: ${policyCitations.join(", ")}`
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

        // A bad-faith finding gets a decision audit whichever instance made
        // it (#696): the Reviewer's flag already requests one, and the
        // second instance's is no less consequential. Keyed apart from the
        // review's so both can stand; a failure to enqueue must not fail
        // the arbitration that was already recorded.
        if (suspectedBadFaith) {
          try {
            await requestAudit({
              auditType: "decision_audit",
              context:
                `An arbitration recorded a bad-faith finding ` +
                `(${badFaithCategory}) on contribution ${contributionId}. ` +
                `Audit the arbitration fully: does the evidence clear the ` +
                `deliberate-abuse bar, and is the contributor's wider record ` +
                `consistent with it?`,
              triggeredBy: "bad_faith_flag",
              dedupeKey: `bad-faith-arb:${contributionId}`,
            });
          } catch (auditErr) {
            console.error(
              "Failed to request arbitration bad-faith audit:",
              auditErr instanceof Error ? auditErr.message : auditErr
            );
          }
        }

        return JSON.stringify({
          success: true,
          message: `Arbitration decision recorded: ${outcome} for contribution ${contributionId}`,
          ...(prizeNote ? { prize_claim: prizeNote } : {}),
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

      case NOTIFY_CLAIM_STEWARD:
        return executeNotifyClaimSteward(input, "dispute_arbitrator");

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

        if (!reason?.trim()) {
          return JSON.stringify({
            success: false,
            error: "reason is required: the humans who take the case up read it. Nothing was recorded.",
          });
        }

        // The reason is stored (#713): a human opening the case reads why,
        // and no action on a contribution is a quiet one (§11, §15).
        const db = getDb();
        await db
          .update(contributions)
          .set({ reviewStatus: "human_review", humanReviewReason: reason.trim() })
          .where(eq(contributions.id, contributionId));

        return JSON.stringify({
          success: true,
          message: `Contribution ${contributionId} flagged for human review; the reason is recorded on it.`,
        });
      }

      default:
        return `Error: Unknown arbitrator tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
