/**
 * Action tools for the Audit Agent.
 *
 * The finding is the unit of record (#180): flag_issue persists it, and every
 * consequence tool (re-review, reputation adjustment, suspension) requires a
 * finding_id, so consequences trace to their decision the same way reputation
 * changes trace to reputation_events. get_audit_findings gives runs memory
 * across invocations; resolve_finding closes the loop.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { eq } from "drizzle-orm";
import { getDb, rawQuery } from "../../db/client.js";
import { contributors, contributions } from "../../db/schema.js";
import {
  enqueueContribution,
} from "../../services/queue-service.js";
import {
  adjustReputation,
  neutralizeReviewOutcome,
  AUDIT_SUSPENSION_PREFIX,
} from "../../services/reputation-service.js";

/** Everything a run's tool executions need to know about the run itself. */
export interface AuditToolContext {
  runId?: string;
}

export function getAuditToolDefinitions(): Tool[] {
  return [
    {
      name: "flag_issue",
      description:
        "Record a finding: a durable, persisted record of a quality issue, " +
        "with severity, category, evidence, and a recommended action. " +
        "Returns a finding_id; the consequence tools (recommend_re_review, " +
        "adjust_contributor_reputation, suspend_contributor) each require " +
        "one, so flag the issue before acting on it. Name what the finding " +
        "is about via the typed id fields when known.",
      input_schema: {
        type: "object" as const,
        properties: {
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
            description: "Severity of the issue",
          },
          category: {
            type: "string",
            description:
              "Category: decision_quality, consistency, process_compliance, " +
              "bias_detected, manipulation_suspected",
          },
          description: {
            type: "string",
            description: "Description of the issue",
          },
          evidence: {
            type: "string",
            description: "Evidence supporting the finding",
          },
          recommendation: {
            type: "string",
            description: "Recommended action",
          },
          claim_id: {
            type: "string",
            description: "UUID of the affected claim, if any",
          },
          contribution_id: {
            type: "string",
            description: "UUID of the affected contribution, if any",
          },
          review_id: {
            type: "string",
            description: "UUID of the affected review decision, if any",
          },
          contributor_id: {
            type: "string",
            description: "UUID of the affected contributor, if any",
          },
        },
        required: [
          "severity",
          "category",
          "description",
          "evidence",
          "recommendation",
        ],
      },
    },
    {
      name: "get_audit_findings",
      description:
        "List prior audit findings, optionally filtered by status, " +
        "contributor, or claim. Read these before flagging: a pattern " +
        "already found and acted on must not be punished twice, and an " +
        "open finding may be the thread to pick up.",
      input_schema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: ["open", "resolved", "dismissed"],
            description: "Filter by finding status",
          },
          contributor_id: {
            type: "string",
            description: "Filter by affected contributor",
          },
          claim_id: {
            type: "string",
            description: "Filter by affected claim",
          },
          limit: {
            type: "integer",
            description: "Maximum number of results (default 20)",
          },
        },
      },
    },
    {
      name: "resolve_finding",
      description:
        "Close a finding: 'resolved' when the issue was addressed (or its " +
        "consequence applied and completed), 'dismissed' when re-examination " +
        "shows it no longer holds or never did.",
      input_schema: {
        type: "object" as const,
        properties: {
          finding_id: {
            type: "string",
            description: "The UUID of the finding to close",
          },
          resolution: {
            type: "string",
            enum: ["resolved", "dismissed"],
            description: "How the finding closes",
          },
          note: {
            type: "string",
            description: "What was done, or why it no longer holds",
          },
        },
        required: ["finding_id", "resolution", "note"],
      },
    },
    {
      name: "recommend_re_review",
      description:
        "Send a decision back through the normal process: neutralizes the " +
        "original review's consequences (reputation, counters, owl awards, a " +
        "still-active bad-faith flag), marks it superseded, and returns the " +
        "contribution to the review queue for a fresh decision. Prefer this " +
        "to correcting outcomes yourself. Requires the finding_id from " +
        "flag_issue documenting why.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the contribution to re-review",
          },
          finding_id: {
            type: "string",
            description: "The finding documenting why re-review is warranted",
          },
          reason: {
            type: "string",
            description: "Why re-review is warranted",
          },
        },
        required: ["contribution_id", "finding_id", "reason"],
      },
    },
    {
      name: "adjust_contributor_reputation",
      description:
        "Adjust a contributor's reputation score through the reputation " +
        "ledger. Use positive delta for good patterns, negative for issues " +
        "found. Requires the finding_id from flag_issue documenting the " +
        "evidence; the change lands as a reputation event, auditable and " +
        "reversible like every other.",
      input_schema: {
        type: "object" as const,
        properties: {
          contributor_id: {
            type: "string",
            description: "The UUID of the contributor",
          },
          finding_id: {
            type: "string",
            description: "The finding documenting the evidence for this change",
          },
          delta: {
            type: "number",
            description: "Reputation change (positive or negative, typically -10 to +10)",
          },
          reason: {
            type: "string",
            description: "Reason for the adjustment",
          },
        },
        required: ["contributor_id", "finding_id", "delta", "reason"],
      },
    },
    {
      name: "suspend_contributor",
      description:
        "Suspend a contributor, preventing them from submitting new " +
        "contributions. Requires the finding_id from flag_issue holding the " +
        "evidence. The contributor can still appeal their own contributions, " +
        "and the Dispute Arbitrator can lift the suspension if an appeal " +
        "shows the basis was wrong; stale suspensions come back to you for " +
        "re-examination.",
      input_schema: {
        type: "object" as const,
        properties: {
          contributor_id: {
            type: "string",
            description: "The ID of the contributor to suspend",
          },
          finding_id: {
            type: "string",
            description: "The finding holding the evidence for this suspension",
          },
          reason: {
            type: "string",
            description: "Reason for suspension",
          },
        },
        required: ["contributor_id", "finding_id", "reason"],
      },
    },
    {
      name: "unsuspend_contributor",
      description:
        "Unsuspend a contributor, restoring their ability to submit " +
        "contributions and appeals",
      input_schema: {
        type: "object" as const,
        properties: {
          contributor_id: {
            type: "string",
            description: "The ID of the contributor to unsuspend",
          },
        },
        required: ["contributor_id"],
      },
    },
  ];
}

/** A consequence tool must point at a persisted finding; verify it exists. */
async function findingExists(findingId: string): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT id FROM audit_findings WHERE id = $1`,
    [findingId]
  );
  return rows.length > 0;
}

export async function executeAuditTool(
  toolName: string,
  input: Record<string, unknown>,
  context: AuditToolContext = {}
): Promise<string> {
  try {
    switch (toolName) {
      case "flag_issue": {
        const severity = input.severity as string;
        const category = input.category as string;
        const description = input.description as string;
        const evidence = input.evidence as string;
        const recommendation = input.recommendation as string;

        const rows = await rawQuery<{ id: string }>(
          `INSERT INTO audit_findings
             (run_id, severity, category, description, evidence,
              recommendation, claim_id, contribution_id, review_id, contributor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            context.runId ?? null,
            severity,
            category,
            description,
            evidence,
            recommendation,
            (input.claim_id as string | undefined) ?? null,
            (input.contribution_id as string | undefined) ?? null,
            (input.review_id as string | undefined) ?? null,
            (input.contributor_id as string | undefined) ?? null,
          ]
        );

        return JSON.stringify({
          success: true,
          finding_id: rows[0]?.id,
          message: `Issue flagged: [${severity}] ${category}. Use this finding_id for any consequence tools.`,
        });
      }

      case "get_audit_findings": {
        const status = input.status as string | undefined;
        const contributorId = input.contributor_id as string | undefined;
        const claimId = input.claim_id as string | undefined;
        const limit = (input.limit as number) ?? 20;

        const conditions: string[] = [];
        const params: unknown[] = [];
        if (status) {
          params.push(status);
          conditions.push(`status = $${params.length}`);
        }
        if (contributorId) {
          params.push(contributorId);
          conditions.push(`contributor_id = $${params.length}`);
        }
        if (claimId) {
          params.push(claimId);
          conditions.push(`claim_id = $${params.length}`);
        }
        params.push(limit);
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const rows = await rawQuery<{
          id: string;
          severity: string;
          category: string;
          description: string;
          evidence: string;
          recommendation: string;
          status: string;
          resolution_note: string | null;
          claim_id: string | null;
          contribution_id: string | null;
          review_id: string | null;
          contributor_id: string | null;
          created_at: Date;
        }>(
          `SELECT id, severity, category, description, evidence, recommendation,
                  status, resolution_note, claim_id, contribution_id, review_id,
                  contributor_id, created_at
           FROM audit_findings ${where}
           ORDER BY created_at DESC
           LIMIT $${params.length}`,
          params
        );

        return JSON.stringify({
          findings: rows.map((r) => ({
            finding_id: r.id,
            severity: r.severity,
            category: r.category,
            description: r.description,
            evidence: r.evidence,
            recommendation: r.recommendation,
            status: r.status,
            resolution_note: r.resolution_note,
            claim_id: r.claim_id,
            contribution_id: r.contribution_id,
            review_id: r.review_id,
            contributor_id: r.contributor_id,
            created_at:
              r.created_at instanceof Date
                ? r.created_at.toISOString()
                : r.created_at,
          })),
          count: rows.length,
        });
      }

      case "resolve_finding": {
        const findingId = input.finding_id as string;
        const resolution = input.resolution as string;
        const note = input.note as string;

        const rows = await rawQuery<{ id: string }>(
          `UPDATE audit_findings
           SET status = $1, resolution_note = $2, resolved_by = 'audit_agent',
               resolved_at = now()
           WHERE id = $3
           RETURNING id`,
          [resolution, note, findingId]
        );
        if (rows.length === 0) {
          return JSON.stringify({
            success: false,
            message: `Finding ${findingId} not found.`,
          });
        }

        return JSON.stringify({
          success: true,
          message: `Finding ${findingId} ${resolution}.`,
        });
      }

      case "recommend_re_review": {
        const contributionId = input.contribution_id as string;
        const findingId = input.finding_id as string;
        const reason = input.reason as string;

        if (!(await findingExists(findingId))) {
          return `Error: finding ${findingId} does not exist — flag_issue first, then act on its finding_id.`;
        }

        // Undo the original decision's consequences before the fresh review
        // applies its own — otherwise reputation, counters, and owl awards stack
        // twice for one contribution (#180).
        const neutralization = await neutralizeReviewOutcome({ contributionId });

        const db = getDb();
        await db
          .update(contributions)
          .set({ reviewStatus: "pending" })
          .where(eq(contributions.id, contributionId));

        await enqueueContribution({ contributionId });

        return JSON.stringify({
          success: true,
          message: `Contribution ${contributionId} queued for re-review. Reason: ${reason}`,
          ...(neutralization
            ? {
                neutralized: {
                  superseded_review_id: neutralization.supersededReviewId,
                  contributor_reputation: neutralization.newScore,
                  bad_faith_flag_cleared: neutralization.badFaithFlagCleared,
                  owls_reversed: neutralization.owlsReversed,
                },
              }
            : { note: "no live review existed; contribution re-enqueued as-is" }),
        });
      }

      case "adjust_contributor_reputation": {
        const contributorId = input.contributor_id as string;
        const findingId = input.finding_id as string;
        const delta = input.delta as number;
        const reason = input.reason as string;

        if (!(await findingExists(findingId))) {
          return `Error: finding ${findingId} does not exist — flag_issue first, then act on its finding_id.`;
        }

        const summary = await adjustReputation({ contributorId, delta });
        if (!summary) {
          return JSON.stringify({
            success: false,
            message: `Contributor ${contributorId} not found.`,
          });
        }

        return JSON.stringify({
          success: true,
          message: `Reputation adjusted by ${delta > 0 ? "+" : ""}${delta} for contributor ${contributorId}. Reason: ${reason}`,
          new_score: summary.newScore,
          ...(summary.suspended
            ? { note: "the contributor is now below the suspension threshold and is suspended" }
            : {}),
        });
      }

      case "suspend_contributor": {
        const contributorId = input.contributor_id as string;
        const findingId = input.finding_id as string;
        const reason = input.reason as string;

        if (!(await findingExists(findingId))) {
          return `Error: finding ${findingId} does not exist — flag_issue first, then act on its finding_id.`;
        }

        const db = getDb();
        const suspended = await db
          .update(contributors)
          .set({
            isSuspended: true,
            // The prefix + finding id make the suspension traceable to its
            // evidence and recognizable to the lift paths (#180).
            suspensionReason: `${AUDIT_SUSPENSION_PREFIX}${findingId} ${reason}`,
            suspendedAt: new Date(),
          })
          .where(eq(contributors.id, contributorId))
          .returning({ id: contributors.id });

        if (suspended.length === 0) {
          return JSON.stringify({
            success: false,
            message: `Contributor ${contributorId} not found.`,
          });
        }

        return JSON.stringify({
          success: true,
          message: `Contributor ${contributorId} has been suspended. Reason: ${reason}`,
        });
      }

      case "unsuspend_contributor": {
        const contributorId = input.contributor_id as string;

        const db = getDb();
        const unsuspended = await db
          .update(contributors)
          .set({ isSuspended: false, suspensionReason: null, suspendedAt: null })
          .where(eq(contributors.id, contributorId))
          .returning({ id: contributors.id });

        if (unsuspended.length === 0) {
          return JSON.stringify({
            success: false,
            message: `Contributor ${contributorId} not found.`,
          });
        }

        return JSON.stringify({
          success: true,
          message: `Contributor ${contributorId} has been unsuspended.`,
        });
      }

      default:
        return `Error: Unknown audit tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
