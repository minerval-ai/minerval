/**
 * Tagging pipeline (#272): the drain over the claim-row tagging queue.
 *
 * The queue is `claims.tagged_at IS NULL` on active, embedded claims — the
 * same "the row is the queue" construction as the Steward drain, and for the
 * same reasons: no message to lose on a restart, identical in dev and prod,
 * safe for several tasks to drain at once (`FOR UPDATE SKIP LOCKED`), and
 * the backfill of the existing graph is not a separate mechanism but the
 * same drain run until the queue is empty. New claims land with tagged_at
 * NULL and are picked up by the next tick, most important first; a Steward's
 * canonical-form change resets the column so the claim is re-read.
 *
 * Each task: claim the row, run the tagger, apply its decision through the
 * tag service (which resolves slugs, dedups by meaning, and writes the
 * taggings with provenance), and stamp tagged_at. Failure handling follows
 * the Steward (#97): budget and transient API failures return the row to
 * the queue uncounted; a genuine error counts an attempt, and the row parks
 * out of the drain at MAX_TAGGING_ATTEMPTS so a poison claim stops spinning.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { tagClaim, type TaggingDecision } from "../llm/agents/tagger.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import { getUsageContext, runWithUsageContext } from "../llm/usage-context.js";
import {
  getTagsForSubject,
  MAX_TAGGING_ATTEMPTS,
  setSubjectTags,
  type TagAssignment,
  resolveTagBySlug,
} from "../services/tag-service.js";

/** The provenance stamp the tagger's taggings carry. */
export const TAGGER_SOURCE = "tagger";

/** A leased row whose worker has not settled in this long is retaken. */
export const LEASE_RECLAIM_MINUTES = 15;

export interface TaggingTaskRow {
  id: string;
  text: string;
  claim_type: string;
  domains: string[];
  tagging_attempts: number;
}

export type TaggingTaskResult =
  | { status: "empty" }
  | { status: "processed"; claimId: string; attached: string[]; ok: true }
  | { status: "budget"; claimId: string }
  | { status: "transient"; claimId: string; error: string }
  | { status: "failed"; claimId: string; error: string; parked: boolean };

/**
 * Atomically lease the next untagged claim: highest importance first among
 * the live, embedded rows nobody holds a fresh lease on and that have not
 * parked. A lease older than LEASE_RECLAIM_MINUTES belongs to a worker that
 * died mid-run and is retaken.
 */
async function leaseNextClaim(): Promise<TaggingTaskRow | null> {
  const rows = await rawQuery<TaggingTaskRow>(
    `UPDATE claims
        SET tagging_leased_at = now()
      WHERE id = (
        SELECT id FROM claims
         WHERE state = 'active'
           AND merged_into IS NULL
           AND embedding IS NOT NULL
           AND tagged_at IS NULL
           AND tagging_attempts < $1
           AND (tagging_leased_at IS NULL
                OR tagging_leased_at < now() - interval '${LEASE_RECLAIM_MINUTES} minutes')
         ORDER BY importance DESC, updated_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, text, claim_type, domains, tagging_attempts`,
    [MAX_TAGGING_ATTEMPTS]
  );
  return rows[0] ?? null;
}

/** Turn the tagger's decision into tag-service assignments. */
export async function assignmentsFromDecision(
  decision: TaggingDecision
): Promise<TagAssignment[]> {
  const out: TagAssignment[] = [];
  for (const t of decision.tags) {
    if (t.slug) {
      const existing = await resolveTagBySlug(t.slug);
      if (existing) {
        out.push({ tagId: existing.id, confidence: t.confidence, reasoning: decision.reasoning });
        continue;
      }
      // The model wrote a slug that does not exist (it invented one instead
      // of a name). Treat the slug as a name: find-or-create resolves it.
      if (!t.name) {
        out.push({
          name: t.slug.replace(/-+/g, " "),
          description: t.description,
          confidence: t.confidence,
          reasoning: decision.reasoning,
        });
        continue;
      }
    }
    if (t.name) {
      out.push({
        name: t.name,
        description: t.description,
        confidence: t.confidence,
        reasoning: decision.reasoning,
      });
    }
  }
  return out;
}

/**
 * Run the tagger on one claim row and apply the result. Exported so a script
 * or a test can tag a specific claim outside the drain.
 */
export async function tagOneClaim(
  task: TaggingTaskRow,
  opts: { model?: string } = {}
): Promise<TaggingTaskResult> {
  try {
    const existing = (await getTagsForSubject("claim", task.id)).filter(
      (t) => t.source !== TAGGER_SOURCE
    );
    const decision = await runWithUsageContext({ claimId: task.id }, () =>
      tagClaim({
        claimId: task.id,
        text: task.text,
        claimType: task.claim_type,
        domains: task.domains ?? [],
        existing: existing.map((t) => ({ name: t.name, source: t.source })),
        model: opts.model,
      })
    );

    if (!decision.submitted) {
      throw new Error(decision.reasoning || "tagger submitted no decision");
    }

    const assignments = await assignmentsFromDecision(decision);
    const applied = await setSubjectTags({
      kind: "claim",
      subjectId: task.id,
      source: TAGGER_SOURCE,
      assignments,
      runId: getUsageContext().runId ?? null,
    });

    await rawQuery(
      `UPDATE claims
          SET tagged_at = now(), tagging_leased_at = NULL, tagging_attempts = 0
        WHERE id = $1`,
      [task.id]
    );
    return {
      status: "processed",
      claimId: task.id,
      attached: applied.attached.map((t) => t.slug),
      ok: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof LlmBudgetExceededError) {
      await rawQuery(`UPDATE claims SET tagging_leased_at = NULL WHERE id = $1`, [task.id]);
      return { status: "budget", claimId: task.id };
    }
    if (isTransientApiError(err)) {
      await rawQuery(`UPDATE claims SET tagging_leased_at = NULL WHERE id = $1`, [task.id]);
      console.warn(`[tagger] transient failure on claim ${task.id}; requeued (not counted): ${msg}`);
      return { status: "transient", claimId: task.id, error: msg };
    }
    const nextAttempts = (task.tagging_attempts ?? 0) + 1;
    await rawQuery(
      `UPDATE claims SET tagging_leased_at = NULL, tagging_attempts = $2 WHERE id = $1`,
      [task.id, nextAttempts]
    );
    const parked = nextAttempts >= MAX_TAGGING_ATTEMPTS;
    console.error(
      `[tagger] failed on claim ${task.id} (attempt ${nextAttempts}${parked ? ", parked" : ""}): ${msg}`
    );
    return { status: "failed", claimId: task.id, error: msg, parked };
  }
}

/** Lease and tag the next claim in the queue; "empty" when there is none. */
export async function processNextTaggingTask(
  opts: { model?: string } = {}
): Promise<TaggingTaskResult> {
  const task = await leaseNextClaim();
  if (!task) return { status: "empty" };
  return tagOneClaim(task, opts);
}

export interface TaggingTickResult {
  processed: number;
  attached: number;
  failed: number;
  /** The drain stopped early: the LLM budget tracker tripped. */
  budget: boolean;
  /** The queue ran dry before the batch cap. */
  drained: boolean;
}

/**
 * One scheduler pass: up to `batch` claims (config.taggingBatchSize by
 * default). Stops at the first budget error so a credit outage does not burn
 * attempts, and at the end of the queue.
 */
export async function taggingTick(
  opts: { batch?: number; model?: string } = {}
): Promise<TaggingTickResult> {
  const config = loadConfig();
  const batch = opts.batch ?? config.taggingBatchSize;
  const result: TaggingTickResult = {
    processed: 0,
    attached: 0,
    failed: 0,
    budget: false,
    drained: false,
  };
  for (let i = 0; i < batch; i++) {
    const r = await processNextTaggingTask({ model: opts.model });
    if (r.status === "empty") {
      result.drained = true;
      break;
    }
    if (r.status === "budget") {
      result.budget = true;
      break;
    }
    result.processed++;
    if (r.status === "processed") result.attached += r.attached.length;
    else result.failed++;
  }
  return result;
}

/**
 * Run the drain on an interval. Every task in a deployment may run it: the
 * lease makes each claim row exclusive. Disabled entirely by
 * TAGGING_INTERVAL_SECONDS=0.
 */
export function startTaggingScheduler(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const config = loadConfig();
  const seconds = config.taggingIntervalSeconds;
  if (seconds <= 0 && options.intervalMs === undefined) {
    options.logger.info("Tagging scheduler disabled (TAGGING_INTERVAL_SECONDS=0)");
    return { stop: () => {} };
  }
  const interval = options.intervalMs ?? seconds * 1000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await taggingTick();
      if (result.processed > 0 || result.budget) {
        options.logger.info(
          `Tagging: ${result.processed} claim(s) tagged (${result.attached} tags, ` +
            `${result.failed} failed)${result.budget ? "; stopped on budget" : ""}` +
            `${result.drained ? "; queue drained" : ""}`
        );
      }
    } catch (err) {
      options.logger.error("Tagging scheduler error", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info(`Tagging scheduler started (every ${Math.round(interval / 1000)}s)`);
  return { stop: () => clearInterval(timer) };
}
