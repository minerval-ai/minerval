import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { refreshQueuePriority } from "./priority-service.js";
import { ensureAssessActions, ensureAuditAction } from "./action-service.js";
import { recordEnqueueEvent } from "./enqueue-events-service.js";
import { postMessage, type MessageSender } from "./inbox-service.js";
import { currentLabel } from "../llm/usage-context.js";
import { stewardSlot } from "./steward-lease.js";
import { mirroredNode } from "./mirrored-node-service.js";

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
  /**
   * The label of the work that enqueued this (src/labels.ts), stamped by
   * enqueueClaimPipeline; the worker onboards the claim at it. The other
   * queues' messages point at a row that carries the label (a job, a
   * contribution, an appeal). This one has to carry it, because a Steward
   * that mints a subclaim enqueues with no job row behind it, and between
   * the enqueue and the worker the message is all that stands for the work.
   */
  label: string;
}

/**
 * A claim pipeline message written before the label field existed: the same
 * message with no `label` key. Nothing enqueues one now (enqueueClaimPipeline
 * always stamps the label), but the queue outlives a deploy, so the worker
 * can still be handed one that the earlier code wrote. Only the worker's
 * side of the queue uses this type, and it says there what it does with
 * such a message and when the type can go (workers/claim-pipeline.ts).
 */
export type PreLabelClaimPipelineMessage = Omit<ClaimPipelineMessage, "label">;

/** What the claim pipeline's worker may find in the queue. */
export type QueuedClaimPipelineMessage = ClaimPipelineMessage | PreLabelClaimPipelineMessage;

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
  /**
   * A scoped ingest: extract only the claims bearing on this subject
   * (ingest-focus-service.ts). Absent = the whole document.
   */
  focus?: string;
  /** The ledger ingest group this extraction executes, when not the URL's own. */
  ingestGroup?: string;
  /** The mandate whose ingest this is, for the extraction record. */
  grantId?: string;
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
    // The Steward of a node that depends on this one (has it beneath it)
    // thinks this node's assessment may be mistaken, and says why
    // (notify_steward). The receiver decides.
    | "dependent_note"
    // The Steward of a node not joined to this one by an edge has written
    // to it with its reasons (notify_steward). The receiver decides.
    | "steward_note"
    | "contribution_accepted"
    // A Dispute Arbitrator ruled on a dispute touching this claim. Distinct
    // from contribution_accepted because the ruling may be an overturn — the
    // Steward may need to unwind a change, not integrate one.
    | "arbitration_outcome"
    | "staleness_check"
    // A node carries a version of its judgment at more than one label, and a
    // version this label's was made beside has been replaced, retired or
    // first recorded (version-upkeep.ts). The context names the labels and
    // nothing else; whether it matters is the Steward's judgment.
    | "version_beside_changed"
    // A version at this label on a node that carries another label rested
    // on material at this label, and that material has since been detached
    // or removed (version-upkeep.ts). The context says so in fixed words.
    | "version_material_gone"
    // The public graph merged or withdrew a node that work at this label
    // rests on, and the batch of the mirror that says so is in
    // (mirror-upkeep.ts). The context says what happened and what of this
    // label's is where; what to make of it is the Steward's judgment.
    | "public_graph_changed"
    // A merge made at another label moved what this label had recorded on
    // the merged node onto this one, or its undo moved it back
    // (reconciliation-service.ts, carryMergeToOtherLabels). The context is
    // composed at this label: what moved, and this label's own version.
    | "merge_carried"
    // A mandate's plan asked for a pass on this claim (an assess, reassess
    // or deepen item, materialized by the reconcile sweep or by the
    // Grantmaker's extend_plan in the same turn, #416). The context names
    // only the kind of pass: never the mandate, its funder, or the item's
    // rationale.
    | "mandate_plan"
    // A mandate's lookout (docs/allocation.md, "Lookouts") reports a
    // development bearing on this claim — a retraction, a new result, a
    // moved dependency — and asks for a fresh look. The context carries
    // what it saw; the ledger row it valued decides whether the pass runs.
    | "lookout_flag"
    // A watcher recorded something that happened to a document this node
    // asserts or rests on through recorded provenance (#507): a retraction,
    // correction or expression of concern, found by the Crossref poll or by
    // the facts fetch's DOI check (source-notice-service.ts). The context
    // names the notice and how it reaches the node; the Steward decides
    // what it means, and the ledger whether the pass runs.
    | "source_event"
    // The Consistency Checker (#330) finds this claim's assessment cannot
    // stand with its neighbors' as the edges between them read. The context
    // names the neighbors, their verdicts, and the checker's reading; the
    // ledger row it valued decides whether the pass runs.
    | "consistency_flag"
    // The Audit sends this claim's assessment back for a fresh pass
    // (recommend_reassessment, #693). The context carries the audit finding
    // in its own words and what to look at again; the Steward decides.
    | "audit_send_back"
    // Work on a request bearing on this claim has come back (Part VIII,
    // Requests): the context names the request, the outcome, the research
    // run holding the full report, and whether this Steward keeps it. The
    // keeper decides whether the request has been met; every bears-on
    // Steward weighs what it found for its node (#718).
    | "request_returned"
    // A user paid for a (re)assessment (assessment_orders, express lane).
    | "user_order"
    // A paused session on this node got back what it asked for (research it
    // commissioned, an answer from another node's Steward): this pass
    // resumes that session, with its transcript (session-service.ts).
    | "session_resume"
    // Research commissioned from this node finished, and no session of the
    // node waits for it: the report is a message for the next pass.
    | "research_report"
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
    | "argument_evaluation_backfill"
    // One-shot backfill (#541): sources attached to one of the node's
    // arguments with no passage or stance (the old evidence_urls). Read
    // each and record an instance where it makes, attacks or mentions it.
    | "argument_evidence_backfill";
  /** The message itself, kept whole in the node's inbox. */
  context: string;
  /** Who is writing; defaults to what the trigger implies (inbox-service.ts). */
  sender?: MessageSender;
  /** True when the pass this message asks for was commissioned with it. */
  paid?: boolean;
  /**
   * Return a parked node ('error') to the queue. Only a commission sets it
   * (commission-service.ts): a park is not retried on its own (#846), so any
   * other message reaches a parked node's inbox and leaves it parked, to be
   * read by the pass someone later commissions. A paid message un-parks too.
   */
  unpark?: boolean;
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
  work: Omit<ClaimPipelineMessage, "label">
): Promise<void> {
  const config = loadConfig();
  const message: ClaimPipelineMessage = { ...work, label: currentLabel() };

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

/**
 * "Enqueue" a Steward run by marking the claim pending in the DB — the claim row
 * IS the work queue — and keeping the message in the node's inbox
 * (inbox-service.ts), whole. Re-triggers coalesce into the single pending slot
 * (taming the propagation storm where one assessment notifies many dependents):
 * the next pass reads every unread message, however many arrived. For the
 * single trigger column, `structure_and_assess` outranks any re-trigger (the
 * first pass subsumes a re-assessment), otherwise the pending value is kept.
 * A message for a claim that is mid-run does NOT flip it to 'pending' (#482):
 * every lane treats 'pending' as free to claim, so that handed the claim to a
 * second Steward while the first was still writing. The row stays 'running'
 * with `steward_requeued` set, and the run's release (steward-lease.ts) turns
 * it into 'pending' for the next pass, which reads what arrived meanwhile.
 * A message for a PARKED claim ('error') does not flip it to 'pending' either,
 * unless it comes with a commission (`paid` or `unpark`, #846). It used to:
 * every note, propagation and flag un-parked the node for one more attempt
 * that nobody had decided to buy, and the node then read as merely waiting,
 * its failures invisible to the parent resting on it. The message is still
 * kept, for the pass a commission later buys.
 * The claim update is one statement, so concurrent enqueues cannot interleave.
 * Ordering is by the persisted `claims.importance` column, so the message
 * carries no importance of its own. Works identically in dev and prod — there
 * is no SQS path for the Steward.
 */
export async function enqueueSteward(
  message: StewardMessage
): Promise<void> {
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
  // The slot is the node's own row for a message at the node's label, and
  // this label's row in steward_slots for a message at another label that
  // reads the node (steward-lease.ts): the message waits for a pass at its
  // own label, and work at one label does not mark another's as pending.
  const slot = await stewardSlot(message.claimId, { ensure: true });
  // A mirrored node's Steward at the node's own label is the public
  // graph's, and no pass at that label is opened here
  // (mirrored-node-service.ts): nothing is queued and no message is kept,
  // as for a node that is not active.
  if (slot.own && (await mirroredNode(message.claimId))) return;
  const rows = await rawQuery<{ prev_state: string; prev_requeued: boolean; new_state: string }>(
    `UPDATE ${slot.rel}
        SET steward_state = CASE
              WHEN steward_state = 'running' THEN 'running'
              WHEN steward_state = 'error' AND NOT $3::boolean THEN 'error'
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
            updated_at = now()
       FROM (SELECT ${slot.key} AS id, steward_state AS prev_state,
                    steward_requeued AS prev_requeued
               FROM ${slot.rel} WHERE ${slot.is("$1")} FOR UPDATE) prev
      WHERE ${slot.is("prev.id", slot.rel)}
        AND ${slot.active(slot.own ? undefined : slot.rel)}
      RETURNING prev.prev_state AS prev_state,
                prev.prev_requeued AS prev_requeued,
                ${slot.rel}.steward_state AS new_state`,
    [message.claimId, message.trigger, message.paid === true || message.unpark === true]
  );
  // Still parked: the message is kept below, but the node is not a candidate,
  // so its priority and ledger rows are left as the park left them.
  const stillParked = rows[0]?.new_state === "error";

  // No row = the claim is missing or inactive; nothing was enqueued, so
  // there is no event to record and no message to keep.
  if (rows.length > 0) {
    // The message itself goes to the node's inbox, whole (inbox-service.ts).
    await postMessage({
      nodeId: message.claimId,
      trigger: message.trigger,
      body: message.context,
      sender: message.sender,
      paid: message.paid,
    });
    // An enqueue event is an arrival in the queue; a message that left the
    // node parked is not one.
    if (!stillParked) {
      recordEnqueueEvent({
        queue: "steward",
        trigger: message.trigger,
        claimId: message.claimId,
        coalesced:
          rows[0]!.prev_state === "pending" ||
          (rows[0]!.prev_state === "running" && rows[0]!.prev_requeued),
      });
    }
  }

  if (stillParked) return;

  // Stamp the composite queue priority as the claim enters the lane, so the
  // drain's ordering is current the moment the slot exists. (Refreshed again
  // by the allocation scheduler's sweep while it waits.) Best-effort: a
  // priority hiccup must not lose the enqueue itself.
  try {
    // The priority is a column of the node's own row and orders the drain
    // of its own slot. A pass at another label runs when its ledger row is
    // funded, and writes nothing to a row its label does not own.
    if (slot.own) await refreshQueuePriority(message.claimId);
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
 * raised to the Governance mandates' program officers, who never fund an
 * audit whose subject is their own mandate (subjectGrantId); an audit of a
 * Governance mandate goes to the General mandate instead
 * (maintenance-funding.ts, fundAuditNow).
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
    | "prize_check_error"
    // The Extractor reported text addressed to the agents rather than to a
    // source's readers (#740): deduped per source.
    | "injected_source";
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
       (audit_type, context, triggered_by, dedupe_key, subject_grant_id, bounty_id, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.auditType,
      input.context,
      input.triggeredBy,
      input.dedupeKey ?? null,
      input.subjectGrantId ?? null,
      input.bountyId ?? null,
      // The label the audit is asked for at, the same one its ledger row
      // takes below (src/labels.ts).
      currentLabel(),
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
    // Put in front of the Governance mandates' officers now (lazily:
    // maintenance-funding reaches this module through its imports).
    const { fundAuditNow } = await import("./maintenance-funding.js");
    await fundAuditNow(actionId);
  }
  return runId;
}
