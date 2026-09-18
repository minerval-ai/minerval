/**
 * Loaders for the cascade and history instruments: the telemetry and
 * assessment history of one database, as the pure libraries want it.
 *
 * URL-parameterized and free of lib.js (no env pinning), like
 * snapshot-core.ts, so the DB test suite can exercise them against its
 * scratch database and cascade.ts / history.ts / score.ts can point them at
 * the corpus DB or a snapshot. The main 'episteme' database is refused by
 * name, as everywhere in the harness.
 */
import pg from "pg";
import { dbNameOf } from "./snapshot-core.js";
import type { CascadeInput } from "./cascade-lib.js";
import type { HistoryInput } from "./history-lib.js";

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  if (dbNameOf(url) === "episteme") throw new Error("Refusing to read the main 'episteme' database.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const iso = (d: Date | string | null): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

export async function loadCascadeInput(url: string, opts: { since?: string | null } = {}): Promise<CascadeInput> {
  const since = opts.since ?? null;
  return withClient(url, async (c) => {
    const runs = await c.query<{
      id: string;
      claim_id: string | null;
      started_at: Date;
      finished_at: Date | null;
      outcome: string | null;
    }>(
      `SELECT id, claim_id, started_at, finished_at, outcome
         FROM agent_runs
        WHERE agent = 'steward' AND ($1::timestamptz IS NULL OR started_at >= $1)
        ORDER BY started_at`,
      [since]
    );
    const events = await c.query<{
      id: string;
      claim_id: string | null;
      trigger: string | null;
      source_run_id: string | null;
      source_agent: string | null;
      coalesced: boolean | null;
      created_at: Date;
    }>(
      `SELECT id, claim_id, trigger, source_run_id, source_agent, coalesced, created_at
         FROM enqueue_events
        WHERE queue = 'steward' AND ($1::timestamptz IS NULL OR created_at >= $1)
        ORDER BY created_at`,
      [since]
    );
    const assessments = await c.query<{
      claim_id: string;
      status: string;
      claim_credence: number | null;
      assessed_at: Date;
      trigger: string | null;
    }>(
      `SELECT claim_id, status, claim_credence, assessed_at, trigger
         FROM assessments
        WHERE ($1::timestamptz IS NULL OR assessed_at >= $1)
        ORDER BY assessed_at`,
      [since]
    );
    const samples = await c.query<{ created_at: Date; steward_pending: number }>(
      `SELECT created_at, steward_pending
         FROM queue_depth_snapshots
        WHERE ($1::timestamptz IS NULL OR created_at >= $1)
        ORDER BY created_at`,
      [since]
    );
    return {
      since,
      runs: runs.rows.map((r) => ({
        id: r.id,
        claimId: r.claim_id,
        startedAt: iso(r.started_at)!,
        finishedAt: iso(r.finished_at),
        outcome: r.outcome,
      })),
      events: events.rows.map((e) => ({
        id: e.id,
        claimId: e.claim_id,
        trigger: e.trigger,
        sourceRunId: e.source_run_id,
        sourceAgent: e.source_agent,
        coalesced: e.coalesced,
        createdAt: iso(e.created_at)!,
      })),
      assessments: assessments.rows.map((a) => ({
        claimId: a.claim_id,
        status: a.status,
        credence: a.claim_credence,
        assessedAt: iso(a.assessed_at)!,
        trigger: a.trigger,
      })),
      depthSamples: samples.rows.map((s) => ({ at: iso(s.created_at)!, stewardPending: s.steward_pending })),
    };
  });
}

export async function loadHistoryInput(url: string, opts: { since?: string | null } = {}): Promise<HistoryInput> {
  const since = opts.since ?? null;
  return withClient(url, async (c) => {
    // The whole history of every claim assessed in the window: a reversal
    // is judged against the claim's FIRST assessment, which may predate it.
    const assessments = await c.query<{
      claim_id: string;
      status: string;
      claim_credence: number | null;
      assessed_at: Date;
      trigger: string | null;
    }>(
      `SELECT claim_id, status, claim_credence, assessed_at, trigger
         FROM assessments
        WHERE claim_id IN (SELECT claim_id FROM assessments WHERE $1::timestamptz IS NULL OR assessed_at >= $1)
        ORDER BY assessed_at`,
      [since]
    );
    const contributions = await c.query<{
      id: string;
      claim_id: string | null;
      contribution_type: string;
      review_status: string;
      submitted_at: Date;
      reviewed_at: Date | null;
      decision: string | null;
    }>(
      `SELECT k.id, k.claim_id, k.contribution_type, k.review_status, k.submitted_at,
              r.reviewed_at, r.decision
         FROM contributions k
         LEFT JOIN LATERAL (
           SELECT reviewed_at, decision FROM contribution_reviews cr
            WHERE cr.contribution_id = k.id AND cr.superseded = false
            ORDER BY reviewed_at DESC LIMIT 1
         ) r ON true
        WHERE ($1::timestamptz IS NULL OR k.submitted_at >= $1)
        ORDER BY k.submitted_at`,
      [since]
    );
    return {
      since,
      assessments: assessments.rows.map((a) => ({
        claimId: a.claim_id,
        status: a.status,
        credence: a.claim_credence,
        assessedAt: iso(a.assessed_at)!,
        trigger: a.trigger,
      })),
      contributions: contributions.rows.map((k) => ({
        id: k.id,
        claimId: k.claim_id,
        type: k.contribution_type,
        reviewStatus: k.review_status,
        submittedAt: iso(k.submitted_at)!,
        reviewedAt: iso(k.reviewed_at),
        decision: k.decision,
      })),
    };
  });
}
