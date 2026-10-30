/**
 * Action tools for the Contribution Reviewer agent.
 *
 * These let the reviewer record decisions, provide feedback, escalate disputes,
 * and notify the claim steward -- all through tool calls.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { eq } from "drizzle-orm";
import { getDb, rawQuery } from "../../db/client.js";
import {
  fileRequest,
  getRequest,
  notifyRequestKeeper,
  recordWork,
} from "../../services/request-service.js";
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
import { getContributionById, MANDATE_LABEL } from "../../services/contribution-service.js";
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
        "status. Accepting an intake contribution (propose_claim, " +
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
          request: {
            type: "object",
            description:
              "Required to accept a propose_request: the request as it will be filed, in your " +
              "words from the contributor's (Part VIII). ask, why (what the judgments it bears " +
              "on would become under its outcomes), satisfied_by; who_could and addressed_to " +
              "where known. A request that asks for a particular result is restated to ask for " +
              "what would decide the matter either way. budget_usd: what doing it should cost, " +
              "when the contributor stated one you judge plausible for the work (the costing skill " +
              "says how to check one); omit it otherwise, and a scoping pass will quote it.",
            properties: {
              ask: { type: "string" },
              why: { type: "string" },
              satisfied_by: { type: "string" },
              who_could: { type: "string" },
              addressed_to: { type: "string" },
              budget_usd: { type: "number" },
            },
            required: ["ask", "why", "satisfied_by"],
          },
          request_id: {
            type: "string",
            description:
              "Required to accept an answer_request: the request the material is offered for.",
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

        // Intake contributions (#157): an accept is what admits the content
        // into the graph, so materialize FIRST — the Matcher decides identity
        // (dedup/canonicalization), then the claim goes live or the source is
        // extracted. Deliberately mechanical: the reviewer judged the
        // suggestion; code applies it. Runs before the review is recorded so
        // a failure surfaces to the reviewer instead of stranding an
        // "accepted" contribution that never materialized (the call is
        // idempotent, so a retry after partial failure is safe).
        let materialization: IntakeMaterializationResult | null = null;
        // A request a contributor proposes is filed in the request's own
        // form, and material offered to meet one is recorded as work on it
        // for its keeper (Part VIII). Checked before anything is written.
        let requestNote = "";
        if (decision === "accept" && reviewed?.contributionType === "propose_request") {
          const r = (input.request ?? null) as Record<string, unknown> | null;
          const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
          if (!r || !text(r.ask) || !text(r.why) || !text(r.satisfied_by)) {
            return JSON.stringify({
              success: false,
              error:
                "Accepting a propose_request needs request: {ask, why, satisfied_by}, the request as " +
                "it will be filed. Nothing was recorded.",
            });
          }
          const filed = await fileRequest({
            ask: text(r.ask),
            why: text(r.why),
            satisfiedBy: text(r.satisfied_by),
            budgetUsd: typeof r.budget_usd === "number" && r.budget_usd > 0 ? r.budget_usd : null,
            whoCould: text(r.who_could) || null,
            addressedTo: text(r.addressed_to) || null,
            claimIds: reviewed.claimId ? [reviewed.claimId] : [],
            bearsOnText: reviewed.claimId ? null : reviewed.content.slice(0, 1000),
            // A mandate's research proposes under the mandate (Part VIII).
            filer: reviewed.grantId
              ? { kind: "mandate", grantId: reviewed.grantId }
              : { kind: "contributor", contributorId: reviewed.contributorId },
          });
          requestNote = ` Request ${filed.id} filed.`;
        }
        if (decision === "accept" && reviewed?.contributionType === "answer_request") {
          const requestId = typeof input.request_id === "string" ? input.request_id.trim() : "";
          const request = requestId ? await getRequest(requestId) : null;
          if (!request) {
            return JSON.stringify({
              success: false,
              error: "Accepting an answer_request needs request_id, the request the material is offered for. Nothing was recorded.",
            });
          }
          const [contributor] = await rawQuery<{ display_name: string }>(
            `SELECT display_name FROM contributors WHERE id = $1`,
            [reviewed.contributorId]
          );
          await recordWork({
            requestId,
            byLabel: reviewed.grantId ? MANDATE_LABEL : (contributor?.display_name ?? "a contributor"),
            contributorId: reviewed.grantId ? null : reviewed.contributorId,
            fundedByJobId: reviewed.fundedByJobId ?? null,
            outcome: null,
            summary: reviewed.content.slice(0, 4000),
          });
          await notifyRequestKeeper(requestId, `a contributor offered material for it (contribution ${contributionId}).`);
          requestNote = ` Recorded as work on request ${requestId}; its keeper is notified.`;
        }
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
