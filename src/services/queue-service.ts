import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { refreshQueuePriority } from "./priority-service.js";
import { ensureAssessActions, ensureAuditAction } from "./action-service.js";
import { recordEnqueueEvent } from "./enqueue-events-service.js";

let _sqsClient: SQSClient | null = null;

function getSqsClient(): SQSClient {
  if (_sqsClient) return _sqsClient;
  const config = loadConfig();
  _sqsClient = new SQSClient({ region: config.awsRegion });
  return _sqsClient;
}

export interface ClaimPipelineMessage {
  claimId: string;
  jobId: string;
}

export interface UrlExtractionMessage {
  sourceId: string;
  jobId: string;
  url: string;
  /**
   * When set, the extraction's LLM calls are metered against this budget
   * job instead of the extraction job — how a grant-funded ingestion spends
   * the grant's escrow rather than the submitter's balance.
   */
  meterJobId?: string;
}

export interface ContributionMessage {
  contributionId: string;
}

export interface ArbitrationMessage {
  contributionId: string;
  trigger: "escalated_review" | "appeal" | "conflict_resolution";
  appealId?: string;
}

export interface StewardMessage {
  claimId: string;
  trigger:
    // First pass for a newly onboarded claim: STRUCTURE it (decompose, matching
    // each dependency) and ASSESS it.
    | "structure_and_assess"
    // Re-triggers: re-assess (and adjust structure only if a genuinely missing
    // dependency is found).
    | "subclaim_change"
    | "contribution_accepted"
    // A Dispute Arbitrator ruled on a dispute touching this claim. Distinct
    // from contribution_accepted because the ruling may be an overturn — the
    // Steward may need to unwind a change, not integrate one.
    | "arbitration_outcome"
    | "staleness_check"
    // A mandate's plan asked for a pass on this claim (an assess, reassess
    // or deepen item, materialized by the reconcile sweep or by the
    // Grantmaker's extend_plan in the same turn, #416). The context carries
    // the mandate's name and the item's rationale.
    | "mandate_plan"
    // A mandate's lookout (docs/allocation.md, "Lookouts") reports a
    // development bearing on this claim — a retraction, a new result, a
    // moved dependency — and asks for a fresh look. The context carries
    // what it saw; the ledger row it valued decides whether the pass runs.
    | "lookout_flag"
    // The Consistency Checker (#330) finds this claim's assessment cannot
    // stand with its neighbors' as the edges between them read. The context
    // names the neighbors, their verdicts, and the checker's reading; the
    // ledger row it valued decides whether the pass runs.
    | "consistency_flag"
    // A user paid for a (re)assessment (assessment_orders, express lane).
    | "user_order"
    // The Curator merged/split this claim, or suggests a structural edge — review
    // and reconcile (re-assess; adopt the suggested edge if apt).
    | "curator_change"
    // Another claim's Steward proposes that this claim adopt it as a subclaim
    // (propose_parent_edge): the claim it stewards is an argument for, about,
    // or a special case of this one. Review and adopt the edge if apt.
    | "edge_proposal"
    // One-shot backfill (issue #129): named arguments predating write_argument
    // lack a written form — write one for each.
    | "argument_written_form_backfill"
    // One-shot backfill (issue #173): named arguments predating
    // evaluate_argument lack an evaluation — evaluate each.
    | "argument_evaluation_backfill";
  context: string;
}

/**
 * An Audit Agent run's type and context. Audits are no longer queue
 * messages (#363): requestAudit opens an `audit` ledger action for the
 * audit_runs row, and the engine executor runs it once it is funded. The
 * shape survives as the vocabulary every trigger speaks.
 */
export interface AuditMessage {
  auditType:
    | "decision_audit"
    | "pattern_analysis"
    | "contributor_review"
    | "anomaly_investigation"
    // Triage of the agents' own reports (#366): cluster, rank, set status.
    | "report_triage";
  context: string;
  // The audit_runs row this message executes (#180): findings attach to it,
  // and completion is recorded on it. Absent only for hand-crafted messages.
  runId?: string;
}

// In-memory queue for local development.
// NOTE: the Steward is intentionally absent — it is no longer a message queue at
// all. A claim's `steward_state` column IS its queue (see enqueueSteward below),
// drained highest-importance-first by the DB-backed drain in steward-pipeline.ts.
// This is the single mechanism in both dev and prod (no SQS/in-memory drift).
const localQueues = {
  claimPipeline: [] as ClaimPipelineMessage[],
  urlExtraction: [] as UrlExtractionMessage[],
  contribution: [] as ContributionMessage[],
  arbitration: [] as ArbitrationMessage[],
};

export function getLocalQueue<T extends keyof typeof localQueues>(
  name: T
): (typeof localQueues)[T] {
  return localQueues[name];
}

export async function enqueueClaimPipeline(
  message: ClaimPipelineMessage
): Promise<void> {
  const config = loadConfig();

  if (!config.sqsClaimPipelineQueue) {
    // Local dev: push to in-memory queue
    localQueues.claimPipeline.push(message);
  } else {
    const client = getSqsClient();
    await client.send(
      new SendMessageCommand({
        QueueUrl: config.sqsClaimPipelineQueue,
        MessageBody: JSON.stringify(message),
      })
    );
  }
  recordEnqueueEvent({
    queue: "claim_pipeline",
    claimId: message.claimId,
    jobId: message.jobId,
  });
}

export async function enqueueUrlExtraction(
  message: UrlExtractionMessage
): Promise<void> {
  const config = loadConfig();

  if (!config.sqsUrlExtractionQueue) {
    // Local dev: push to in-memory queue
    localQueues.urlExtraction.push(message);
  } else {
    const client = getSqsClient();
    await client.send(
      new SendMessageCommand({
        QueueUrl: config.sqsUrlExtractionQueue,
        MessageBody: JSON.stringify(message),
      })
    );
  }
  recordEnqueueEvent({ queue: "url_extraction", jobId: message.jobId });
}

export async function enqueueContribution(
  message: ContributionMessage
): Promise<void> {
  const config = loadConfig();
  if (!config.sqsContributionQueue) {
    localQueues.contribution.push(message);
  } else {
    const client = getSqsClient();
    await client.send(
      new SendMessageCommand({
        QueueUrl: config.sqsContributionQueue,
        MessageBody: JSON.stringify(message),
      })
    );
  }
  recordEnqueueEvent({
    queue: "contribution",
    contributionId: message.contributionId,
  });
}

export async function enqueueArbitration(
  message: ArbitrationMessage
): Promise<void> {
  const config = loadConfig();
  if (!config.sqsArbitrationQueue) {
    localQueues.arbitration.push(message);
  } else {
    const client = getSqsClient();
    await client.send(
      new SendMessageCommand({
        QueueUrl: config.sqsArbitrationQueue,
        MessageBody: JSON.stringify(message),
      })
    );
  }
  recordEnqueueEvent({
    queue: "arbitration",
    trigger: message.trigger,
    contributionId: message.contributionId,
  });
}

// Backstop against a propagation storm growing a pending slot without bound:
// keep the NEWEST chunks up to this many characters (roughly 4k tokens). The
// oldest context is what gets dropped, marked so the Steward knows it is
// working from a partial batch.
export const STEWARD_CONTEXT_MAX_CHARS = 16000;

/**
 * "Enqueue" a Steward run by marking the claim pending in the DB — the claim row
 * IS the work queue. Re-triggers still coalesce into the single pending slot
 * (taming the propagation storm where one assessment notifies many dependents),
 * but losslessly (#182): while the claim is already pending, the new context is
 * APPENDED rather than clobbering the earlier message, so everything that
 * arrived before the drain reaches the Steward as one batched run. Each chunk
 * is labeled `[trigger]` since the row holds a single trigger column; for that
 * column, `structure_and_assess` outranks any re-trigger (the first pass
 * subsumes a re-assessment), otherwise the pending value is kept. Once the slot
 * is consumed (running/done/error), the next message starts a fresh context.
 * A message for a claim that is mid-run does NOT flip it to 'pending' (#482):
 * every lane treats 'pending' as free to claim, so that handed the claim to a
 * second Steward while the first was still writing. The row stays 'running'
 * with `steward_requeued` set, later messages coalesce into that slot as they
 * would into a pending one, and the run's release (steward-lease.ts) turns it
 * into 'pending' for the next pass.
 * The whole update is one statement, so concurrent enqueues cannot interleave.
 * Ordering is by the persisted `claims.importance` column, so the message
 * carries no importance of its own. Works identically in dev and prod — there
 * is no SQS path for the Steward.
 */
export async function enqueueSteward(
  message: StewardMessage
): Promise<void> {
  const chunk = `[${message.trigger}] ${message.context}`.trim();
  // The FROM subquery locks the row and carries its PRE-update state out
  // through RETURNING (SET expressions always read old values, so the CASE
  // semantics are unchanged) — that's how the enqueue event below can tell
  // "created the pending slot" from "appended to one" (#217, the coalescing
  // absorption #182 was built on but never measured). Still one statement:
  // concurrent enqueues serialize on the row lock and each sees the true
  // prior state.
  // "Queued" means pending, or running with a message already waiting: both
  // are one open slot that new messages coalesce into.
  const queued = `(steward_state = 'pending'
                   OR (steward_state = 'running' AND steward_requeued))`;
  const rows = await rawQuery<{ prev_state: string; prev_requeued: boolean }>(
    `UPDATE claims
        SET steward_state = CASE
              WHEN steward_state = 'running' THEN 'running'
              ELSE 'pending'
            END,
            steward_requeued = (steward_state = 'running'),
            steward_trigger = CASE
              WHEN ${queued}
                   AND (steward_trigger = 'structure_and_assess'
                        OR $2 <> 'structure_and_assess')
                THEN COALESCE(steward_trigger, $2)
              ELSE $2
            END,
            steward_context = CASE
              WHEN ${queued} AND COALESCE(steward_context, '') <> ''
                THEN CASE
                  WHEN length(steward_context || E'\\n\\n' || $3) > ${STEWARD_CONTEXT_MAX_CHARS}
                    THEN '[earlier context truncated]' || E'\\n'
                         || right(steward_context || E'\\n\\n' || $3, ${STEWARD_CONTEXT_MAX_CHARS})
                  ELSE steward_context || E'\\n\\n' || $3
                END
              ELSE $3
            END,
            updated_at = now()
       FROM (SELECT id, steward_state AS prev_state,
                    steward_requeued AS prev_requeued
               FROM claims WHERE id = $1 FOR UPDATE) prev
      WHERE claims.id = prev.id
        AND state = 'active'
      RETURNING prev.prev_state AS prev_state,
                prev.prev_requeued AS prev_requeued`,
    [message.claimId, message.trigger, chunk]
  );

  // No row = the claim is missing or inactive; nothing was enqueued, so
  // there is no event to record.
  if (rows.length > 0) {
    recordEnqueueEvent({
      queue: "steward",
      trigger: message.trigger,
      claimId: message.claimId,
      coalesced:
        rows[0]!.prev_state === "pending" ||
        (rows[0]!.prev_state === "running" && rows[0]!.prev_requeued),
    });
  }

  // Stamp the composite queue priority as the claim enters the lane, so the
  // drain's ordering is current the moment the slot exists. (Refreshed again
  // by the allocation scheduler's sweep while it waits.) Best-effort: a
  // priority hiccup must not lose the enqueue itself.
  try {
    await refreshQueuePriority(message.claimId);
  } catch (err) {
    console.warn(
      `[queue] priority refresh failed for ${message.claimId}:`,
      err instanceof Error ? err.message : err
    );
  }

  // Materialize the claim's assess/reassess action rows the moment it
  // becomes a candidate — the ledger is what mandates value and fund, so
  // it should never lag the candidate set behind the reconcile sweep.
  // Best-effort for the same reason as above.
  try {
    await ensureAssessActions(message.claimId);
  } catch (err) {
    console.warn(
      `[queue] action-ledger refresh failed for ${message.claimId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Request an Audit Agent run (#180): the single entry point every trigger
 * uses. Creates the audit_runs row FIRST — the run's identity, which findings
 * attach to — and then opens its `audit` ledger action (#363), which runs
 * once it is funded. When dedupeKey is set, the row's partial unique index
 * makes the request at-most-once ('sweep:<date>',
 * 'bad-faith:<contribution_id>'), safe across concurrent processes: the
 * loser's INSERT inserts nothing and no duplicate action is opened.
 *
 * Who pays: a prize audit (bountyId) is funded at once from the bounty's
 * prize-review reserve, like the prize review itself; every other audit is
 * valued and funded by the Governance mandate, which never funds an audit
 * whose subject it is (subjectGrantId), and whose own audits the General
 * mandate funds instead (mandate-valuer-service.refreshAuditValuations).
 *
 * Returns the run id, or null when an earlier request already claimed the
 * dedupe key.
 */
export async function requestAudit(input: {
  auditType: AuditMessage["auditType"];
  context: string;
  triggeredBy:
    | "arbitration_overturn"
    | "bad_faith_flag"
    | "scheduled_sweep"
    | "suspension_review"
    | "report_triage"
    | "manual"
    // A production monitor's candidate detector (#334 S9): a performed-
    // settling or empty-chairs hit handed over as anomaly_investigation
    // INPUT, deduped per claim per reflag period (monitor-scheduler.ts).
    | "monitor_signal"
    // The prize triggers (docs/mathematics.md §8.1, §8.4, §8.5): a bounty
    // opened at or above the sign-off threshold, a Steward's acceptance of
    // a prize claim, and a checker failure that holds a statement's queue.
    | "bounty_posted"
    | "prize_acceptance"
    | "prize_check_error";
  dedupeKey?: string;
  /** The mandate the audit examines, if any: it may not fund its own audit. */
  subjectGrantId?: string | null;
  /** A prize audit: funded from this bounty's prize-review reserve. */
  bountyId?: string | null;
  /** The claim the audit is about, when there is one (shown on the row). */
  claimId?: string | null;
}): Promise<string | null> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO audit_runs
       (audit_type, context, triggered_by, dedupe_key, subject_grant_id, bounty_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.auditType,
      input.context,
      input.triggeredBy,
      input.dedupeKey ?? null,
      input.subjectGrantId ?? null,
      input.bountyId ?? null,
    ]
  );
  const runId = rows[0]?.id;
  if (!runId) return null;

  const actionId = await ensureAuditAction({
    auditRunId: runId,
    auditType: input.auditType,
    triggeredBy: input.triggeredBy,
    claimId: input.claimId ?? null,
  });
  recordEnqueueEvent({ queue: "audit", trigger: input.auditType });
  if (input.bountyId) {
    // Imported lazily: bounty-service requests audits through this module.
    const { fundPrizeAuditFromReserve } = await import("./bounty-service.js");
    await fundPrizeAuditFromReserve(input.bountyId, actionId).catch((err) =>
      console.error(
        `[audit] reserve funding failed for audit ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    );
  } else {
    // Priced and offered to the Governance mandate now, not at the next
    // sweep (lazily: the allocator imports this module).
    const { fundAuditNow } = await import("./maintenance-funding.js");
    await fundAuditNow(actionId);
  }
  return runId;
}
