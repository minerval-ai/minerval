import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { refreshQueuePriority } from "./priority-service.js";
import { ensureAssessActions } from "./action-service.js";
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
    // A user paid for a (re)assessment (assessment_orders, express lane).
    | "user_order"
    // The Curator merged/split this claim, or suggests a structural edge — review
    // and reconcile (re-assess; adopt the suggested edge if apt).
    | "curator_change"
    // One-shot backfill (issue #129): named arguments predating write_argument
    // lack a written form — write one for each.
    | "argument_written_form_backfill"
    // One-shot backfill (issue #173): named arguments predating
    // evaluate_argument lack an evaluation — evaluate each.
    | "argument_evaluation_backfill";
  context: string;
}

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

export interface CuratorMessage {
  trigger:
    // A Steward flagged something structural (likely duplicate, needs split, …).
    | "steward_escalation"
    // Look across a new claim's neighborhood for duplicates / missing edges.
    // No longer produced: the unconditional post-extraction sweep was removed
    // (it wrote nothing across 122 runs). Kept so an in-flight message from
    // before that change still deserializes.
    | "neighborhood_sweep";
  // The claim whose neighborhood to reconcile (the escalating/anchor claim).
  claimId: string;
  context: string;
  /**
   * Who the curation is FOR, carried from the run that asked for it, so the
   * Curator's spend lands on a row with an owner instead of a null user and a
   * null job. A Steward escalation happens inside a funded assessment, and
   * that funder is the honest answer to "who induced this".
   *
   * Attribution only — it makes the money visible, it does not decide whose
   * escrow pays. Curation becoming a funded ledger action the General
   * mandate's Grantmaker chooses to buy is tracked separately.
   */
  userId?: string | null;
  jobId?: string | null;
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
  curator: [] as CuratorMessage[],
  audit: [] as AuditMessage[],
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
  const rows = await rawQuery<{ prev_state: string }>(
    `UPDATE claims
        SET steward_state = 'pending',
            steward_trigger = CASE
              WHEN steward_state = 'pending'
                   AND (steward_trigger = 'structure_and_assess'
                        OR $2 <> 'structure_and_assess')
                THEN COALESCE(steward_trigger, $2)
              ELSE $2
            END,
            steward_context = CASE
              WHEN steward_state = 'pending' AND COALESCE(steward_context, '') <> ''
                THEN CASE
                  WHEN length(steward_context || E'\\n\\n' || $3) > ${STEWARD_CONTEXT_MAX_CHARS}
                    THEN '[earlier context truncated]' || E'\\n'
                         || right(steward_context || E'\\n\\n' || $3, ${STEWARD_CONTEXT_MAX_CHARS})
                  ELSE steward_context || E'\\n\\n' || $3
                END
              ELSE $3
            END,
            updated_at = now()
       FROM (SELECT id, steward_state AS prev_state
               FROM claims WHERE id = $1 FOR UPDATE) prev
      WHERE claims.id = prev.id
        AND state = 'active'
      RETURNING prev.prev_state AS prev_state`,
    [message.claimId, message.trigger, chunk]
  );

  // No row = the claim is missing or inactive; nothing was enqueued, so
  // there is no event to record.
  if (rows.length > 0) {
    recordEnqueueEvent({
      queue: "steward",
      trigger: message.trigger,
      claimId: message.claimId,
      coalesced: rows[0]!.prev_state === "pending",
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

export async function enqueueCurator(
  message: CuratorMessage
): Promise<void> {
  const config = loadConfig();
  if (!config.sqsCuratorQueue) {
    localQueues.curator.push(message);
  } else {
    const client = getSqsClient();
    await client.send(
      new SendMessageCommand({
        QueueUrl: config.sqsCuratorQueue,
        MessageBody: JSON.stringify(message),
      })
    );
  }
  recordEnqueueEvent({
    queue: "curator",
    trigger: message.trigger,
    claimId: message.claimId,
  });
}

export async function enqueueAudit(
  message: AuditMessage
): Promise<void> {
  const config = loadConfig();
  if (!config.sqsAuditQueue) {
    localQueues.audit.push(message);
  } else {
    const client = getSqsClient();
    await client.send(
      new SendMessageCommand({
        QueueUrl: config.sqsAuditQueue,
        MessageBody: JSON.stringify(message),
      })
    );
  }
  recordEnqueueEvent({ queue: "audit", trigger: message.auditType });
}

/**
 * Request an Audit Agent run (#180): the single entry point every trigger
 * uses. Creates the audit_runs row FIRST — the run's identity, which findings
 * attach to — and only then enqueues. When dedupeKey is set, the row's
 * partial unique index makes the request at-most-once ('sweep:<date>',
 * 'bad-faith:<contribution_id>'), safe across concurrent processes: the
 * loser's INSERT inserts nothing and no duplicate run is enqueued.
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
    // The prize triggers (docs/mathematics.md §8.1, §8.4, §8.5): a bounty
    // opened at or above the sign-off threshold, a Steward's acceptance of
    // a prize claim, and a checker failure that holds a statement's queue.
    | "bounty_posted"
    | "prize_acceptance"
    | "prize_check_error";
  dedupeKey?: string;
}): Promise<string | null> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO audit_runs (audit_type, context, triggered_by, dedupe_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.auditType, input.context, input.triggeredBy, input.dedupeKey ?? null]
  );
  const runId = rows[0]?.id;
  if (!runId) return null;

  await enqueueAudit({
    auditType: input.auditType,
    context: input.context,
    runId,
  });
  return runId;
}
