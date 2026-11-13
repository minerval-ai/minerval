/**
 * What a mandate has done, kind by kind, for its public page.
 *
 * The page used to list one kind of result, the assessments of claims, read
 * from one table and cut at a hundred rows; the count it showed was the
 * length of that list. A mandate pays for more than that: questions answered
 * and quantities estimated (each judged in a table of its own), sources read,
 * work on requests, research, nodes proposed to the graph, and the findings
 * its agents noted on the way. This module counts each kind whole and lists
 * each a page at a time, so the page can say what a mandate bought without
 * loading all of it.
 *
 * Everything here is a read of records other services write. Nothing is
 * computed about a judgment: a verdict is shown as its pass recorded it.
 */
import { rawQuery } from "../db/client.js";
import { microUsdToOwls } from "./owl.js";
import { getMandatePipeline } from "./mandate-service.js";

/** The kinds of completed work a mandate's page lists. */
export const MANDATE_WORK_KINDS = [
  "assessments",
  "sources",
  "requests",
  "research",
  "proposals",
] as const;
export type MandateWorkKind = (typeof MANDATE_WORK_KINDS)[number];

/** The kinds of node a judgment is of. */
export const JUDGED_NODE_KINDS = ["claim", "question", "quantity"] as const;
export type JudgedNodeKind = (typeof JUDGED_NODE_KINDS)[number];

/** A mandate as this module needs it: its id and the budget job its work is stamped with. */
export interface MandateRef {
  id: string;
  budgetJobId: string;
}

export interface MandateWorkCounts {
  /** Nodes the mandate has had judged, by kind, and the passes that judged them. */
  assessments: { nodes: number; claims: number; questions: number; quantities: number; passes: number };
  sources: number;
  requests: number;
  research: number;
  proposals: number;
  findings: number;
}

// Every judgment a mandate paid for, of whichever kind of node, in one shape.
// A claim's verdict is its status, a question's its standing; a quantity has
// an estimate and no verdict word, so the page shows its current estimate.
const JUDGED = `
  SELECT a.claim_id, 'claim'::text AS kind, a.status AS verdict, a.confidence, a.assessed_at
    FROM assessments a WHERE a.funded_by_job_id = $1
  UNION ALL
  SELECT qa.claim_id, 'question', qa.standing, qa.confidence, qa.assessed_at
    FROM question_assessments qa WHERE qa.funded_by_job_id = $1
  UNION ALL
  SELECT qe.claim_id, 'quantity', NULL, NULL, qe.assessed_at
    FROM quantity_estimates qe WHERE qe.funded_by_job_id = $1`;

export async function mandateWorkCounts(m: MandateRef): Promise<MandateWorkCounts> {
  const [judged, sources, requests, research, proposals, findings] = await Promise.all([
    rawQuery<{ kind: string; nodes: string; passes: string }>(
      `SELECT kind, count(DISTINCT claim_id) AS nodes, count(*) AS passes
         FROM (${JUDGED}) j GROUP BY kind`,
      [m.budgetJobId]
    ),
    rawQuery<{ n: string }>(`SELECT count(*) AS n FROM grant_sources WHERE grant_id = $1`, [m.id]),
    rawQuery<{ n: string }>(
      `SELECT count(DISTINCT request_id) AS n FROM request_work WHERE funded_by_job_id = $1`,
      [m.budgetJobId]
    ),
    rawQuery<{ n: string }>(`SELECT count(*) AS n FROM research_runs WHERE grant_id = $1`, [m.id]),
    rawQuery<{ n: string }>(
      `SELECT count(*) AS n FROM contributions
        WHERE funded_by_job_id = $1 AND contribution_type LIKE 'propose\\_%'`,
      [m.budgetJobId]
    ),
    rawQuery<{ n: string }>(
      `SELECT count(*) AS n FROM agent_findings WHERE job_id = $1 AND status = 'published'`,
      [m.budgetJobId]
    ),
  ]);
  const of = (kind: string) => judged.find((r) => r.kind === kind);
  const nodes = (kind: string) => Number(of(kind)?.nodes ?? 0);
  const one = (rows: Array<{ n: string }>) => Number(rows[0]?.n ?? 0);
  return {
    assessments: {
      nodes: nodes("claim") + nodes("question") + nodes("quantity"),
      claims: nodes("claim"),
      questions: nodes("question"),
      quantities: nodes("quantity"),
      passes: judged.reduce((n, r) => n + Number(r.passes), 0),
    },
    sources: one(sources),
    requests: one(requests),
    research: one(research),
    proposals: one(proposals),
    findings: one(findings),
  };
}

export interface MandateWorkQuery {
  kind: MandateWorkKind;
  /** For assessments: only nodes of this kind. */
  node?: JudgedNodeKind;
  /** For assessments: newest judgment first (the default), or the node's importance. */
  order?: "recent" | "importance";
  limit?: number;
  offset?: number;
}

export interface MandateWorkPage {
  kind: MandateWorkKind;
  total: number;
  items: Array<Record<string, unknown>>;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : d ? String(d) : null;

/** One page of one kind of a mandate's completed work, with the kind's total. */
export async function listMandateWork(m: MandateRef, q: MandateWorkQuery): Promise<MandateWorkPage> {
  const limit = Math.max(1, Math.min(100, q.limit ?? 25));
  const offset = Math.max(0, q.offset ?? 0);

  if (q.kind === "assessments") {
    // One row a node: the mandate's latest judgment of it, and how many
    // passes it has paid for on it. A node judged twice is one result that
    // was looked at twice, not two results.
    const node = q.node ?? null;
    const order =
      q.order === "importance"
        ? "c.importance DESC NULLS LAST, l.assessed_at DESC"
        : "l.assessed_at DESC";
    const latest = `
      WITH judged AS (${JUDGED}),
      latest AS (
        SELECT DISTINCT ON (claim_id) claim_id, kind, verdict, confidence, assessed_at,
               count(*) OVER (PARTITION BY claim_id) AS passes
          FROM judged
         ORDER BY claim_id, assessed_at DESC
      )`;
    const [rows, totals] = await Promise.all([
      rawQuery<{
        claim_id: string;
        kind: string;
        verdict: string | null;
        confidence: number | null;
        assessed_at: Date | null;
        passes: string;
        text: string;
        importance: number | null;
      }>(
        `${latest}
         SELECT l.claim_id, l.kind, l.verdict, l.confidence, l.assessed_at, l.passes,
                c.text, c.importance
           FROM latest l JOIN claims c ON c.id = l.claim_id
          WHERE ($2::text IS NULL OR l.kind = $2)
          ORDER BY ${order}
          LIMIT $3 OFFSET $4`,
        [m.budgetJobId, node, limit, offset]
      ),
      rawQuery<{ n: string }>(
        `${latest} SELECT count(*) AS n FROM latest l WHERE ($2::text IS NULL OR l.kind = $2)`,
        [m.budgetJobId, node]
      ),
    ]);
    return {
      kind: q.kind,
      total: Number(totals[0]?.n ?? 0),
      items: rows.map((r) => ({
        claim_id: r.claim_id,
        node_kind: r.kind,
        text: r.text,
        verdict: r.verdict,
        confidence: r.confidence == null ? null : Number(r.confidence),
        importance: r.importance == null ? null : Number(r.importance),
        assessed_at: iso(r.assessed_at),
        passes: Number(r.passes),
      })),
    };
  }

  if (q.kind === "sources") {
    // The pipeline is read whole (it is one row a source, with what became
    // of its claims) and served a page at a time.
    const pipeline = await getMandatePipeline(m.id);
    return {
      kind: q.kind,
      total: pipeline.length,
      items: pipeline.slice(offset, offset + limit) as unknown as Array<Record<string, unknown>>,
    };
  }

  if (q.kind === "requests") {
    // One row a request, with the latest run this mandate paid for on it.
    const rows = await rawQuery<{
      request_id: string;
      ask: string;
      state: string;
      by_label: string;
      outcome: string | null;
      summary: string;
      budget_micro_usd: string | null;
      created_at: Date;
      runs: string;
    }>(
      `SELECT DISTINCT ON (rw.request_id)
              rw.request_id, r.ask, r.state, rw.by_label, rw.outcome, rw.summary,
              rw.budget_micro_usd, rw.created_at,
              count(*) OVER (PARTITION BY rw.request_id) AS runs
         FROM request_work rw JOIN requests r ON r.id = rw.request_id
        WHERE rw.funded_by_job_id = $1
        ORDER BY rw.request_id, rw.created_at DESC`,
      [m.budgetJobId]
    );
    const sorted = rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return {
      kind: q.kind,
      total: sorted.length,
      items: sorted.slice(offset, offset + limit).map((r) => ({
        request_id: r.request_id,
        ask: r.ask,
        state: r.state,
        by: r.by_label,
        outcome: r.outcome,
        summary: r.summary,
        budget_owls: r.budget_micro_usd == null ? null : microUsdToOwls(Number(r.budget_micro_usd)),
        at: iso(r.created_at),
        runs: Number(r.runs),
      })),
    };
  }

  if (q.kind === "research") {
    const [rows, totals] = await Promise.all([
      rawQuery<{
        id: string;
        run_id: string | null;
        claim_id: string | null;
        request_id: string | null;
        task: string;
        status: string;
        spent_micro_usd: string | null;
        started_at: Date | null;
        finished_at: Date | null;
      }>(
        `SELECT id, run_id, claim_id, request_id, task, status, spent_micro_usd,
                started_at, finished_at
           FROM research_runs
          WHERE grant_id = $1
          ORDER BY started_at DESC NULLS LAST
          LIMIT $2 OFFSET $3`,
        [m.id, limit, offset]
      ),
      rawQuery<{ n: string }>(`SELECT count(*) AS n FROM research_runs WHERE grant_id = $1`, [m.id]),
    ]);
    return {
      kind: q.kind,
      total: Number(totals[0]?.n ?? 0),
      items: rows.map((r) => ({
        id: r.id,
        run_id: r.run_id,
        claim_id: r.claim_id,
        request_id: r.request_id,
        task: r.task,
        status: r.status,
        spent_owls: r.spent_micro_usd == null ? null : microUsdToOwls(Number(r.spent_micro_usd)),
        started_at: iso(r.started_at),
        finished_at: iso(r.finished_at),
      })),
    };
  }

  // proposals: the nodes the mandate put to the graph through the
  // Contribution Reviewer, like anyone's.
  const [rows, totals] = await Promise.all([
    rawQuery<{
      id: string;
      claim_id: string | null;
      contribution_type: string;
      content: string;
      review_status: string;
      submitted_at: Date;
    }>(
      `SELECT id, claim_id, contribution_type, content, review_status, submitted_at
         FROM contributions
        WHERE funded_by_job_id = $1 AND contribution_type LIKE 'propose\\_%'
        ORDER BY submitted_at DESC
        LIMIT $2 OFFSET $3`,
      [m.budgetJobId, limit, offset]
    ),
    rawQuery<{ n: string }>(
      `SELECT count(*) AS n FROM contributions
        WHERE funded_by_job_id = $1 AND contribution_type LIKE 'propose\\_%'`,
      [m.budgetJobId]
    ),
  ]);
  return {
    kind: "proposals",
    total: Number(totals[0]?.n ?? 0),
    items: rows.map((r) => ({
      contribution_id: r.id,
      claim_id: r.claim_id,
      type: r.contribution_type,
      text: r.content,
      review_status: r.review_status,
      submitted_at: iso(r.submitted_at),
    })),
  };
}

/** The findings a mandate's agents noted, most important first, for the page's side column. */
export async function mandateFindings(
  m: MandateRef,
  limit = 5
): Promise<Array<{ id: string; headline: string; importance: number; first_noted_at: string | null }>> {
  const rows = await rawQuery<{
    id: string;
    headline: string;
    importance: number;
    first_noted_at: Date;
  }>(
    `SELECT id, headline, importance, first_noted_at
       FROM agent_findings
      WHERE job_id = $1 AND status = 'published'
      ORDER BY importance DESC, first_noted_at DESC
      LIMIT $2`,
    [m.budgetJobId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    headline: r.headline,
    importance: Number(r.importance),
    first_noted_at: iso(r.first_noted_at),
  }));
}

// ---------------------------------------------------------------------------
// Where its Grantmaker stands
// ---------------------------------------------------------------------------

/**
 * Whether a mandate's Grantmaker is at work or waiting, and what it has asked
 * to be told of (docs/allocation.md, "The Grantmaker's session"). A reader
 * asking "what is it doing now" is owed this: a mandate with nothing running
 * is not idle if its Grantmaker is waiting on fifteen passes and a check-in
 * tomorrow.
 *
 * Only counts and times are given. A subscription's reason is its run's own
 * words and carries that run's label; what it watches (so many runs, so many
 * nodes) and when it next checks in are facts about the mandate.
 */
export interface GrantmakerStanding {
  /** working: in a turn now. waiting: paused until woken. none: no live session. */
  state: "working" | "waiting" | "none";
  /** Its next check-in, when it holds one. */
  check_in_at: string | null;
  /** Runs it asked to be told of that have not yet settled. */
  runs_awaited: number;
  /** Nodes or subtrees it asked to be told of movement on. */
  nodes_watched: number;
  /** Whether it asked to be woken once so much more is committed. */
  spend_threshold: boolean;
}

export async function grantmakerStanding(grantId: string): Promise<GrantmakerStanding> {
  const none: GrantmakerStanding = {
    state: "none",
    check_in_at: null,
    runs_awaited: 0,
    nodes_watched: 0,
    spend_threshold: false,
  };
  const [session] = await rawQuery<{ id: string; status: string }>(
    `SELECT s.id, s.status
       FROM grants g JOIN agent_sessions s ON s.id = g.grantmaker_session_id
      WHERE g.id = $1`,
    [grantId]
  );
  if (!session || !["running", "waiting", "ready"].includes(session.status)) return none;

  const subs = await rawQuery<{
    filter: { action_ids?: string[]; node_ids?: string[]; under?: string[]; over?: string[] } | null;
    condition: { kind?: string } | null;
    due_at: Date | null;
  }>(
    `SELECT filter, condition, due_at FROM subscriptions
      WHERE subscriber_kind = 'session' AND subscriber_ref = $1 AND active`,
    [session.id]
  );
  const actionIds = [...new Set(subs.flatMap((s) => s.filter?.action_ids ?? []))];
  // A subscription to a run ends when the run settles only if it was made
  // `once`; count the runs still open, whichever way it was made.
  const open =
    actionIds.length > 0
      ? await rawQuery<{ n: string }>(
          `SELECT count(*) AS n FROM actions
            WHERE id = ANY($1::uuid[]) AND status IN ('open', 'running')`,
          [actionIds]
        ).catch(() => [{ n: String(actionIds.length) }])
      : [{ n: "0" }];
  const checkIns = subs.map((s) => s.due_at).filter((d): d is Date => d instanceof Date);
  const nodes = new Set(
    subs.flatMap((s) => [...(s.filter?.node_ids ?? []), ...(s.filter?.under ?? []), ...(s.filter?.over ?? [])])
  );
  return {
    state: session.status === "running" ? "working" : "waiting",
    check_in_at:
      checkIns.length > 0
        ? new Date(Math.min(...checkIns.map((d) => d.getTime()))).toISOString()
        : null,
    runs_awaited: Number(open[0]?.n ?? 0),
    nodes_watched: nodes.size,
    spend_threshold: subs.some((s) => s.condition?.kind === "committed_owls"),
  };
}

// ---------------------------------------------------------------------------
// Its Grantmaker's updates
// ---------------------------------------------------------------------------

/**
 * How many of a Grantmaker's notes a mandate keeps (`grants.mandate.updates`).
 * A note is a few paragraphs, and a mandate that has run for months writes
 * hundreds; the page shows the latest and lets a reader go back through
 * these. Older ones are in the run log.
 */
export const MANDATE_UPDATES_KEPT = 100;

export interface MandateUpdate {
  at: string;
  note: string;
}

/**
 * Append a Grantmaker's note to the mandate's record and make it the latest
 * (`last_review`, which the page and the Grantmaker's own briefing read).
 * Before this only the latest was kept, so each note overwrote the one
 * before it and a mandate's page could not show how it got where it is.
 */
export async function recordMandateUpdate(grantId: string, note: string): Promise<void> {
  await rawQuery(
    `UPDATE grants
        SET mandate = jsonb_set(
              jsonb_set(
                COALESCE(mandate, '{}'::jsonb), '{last_review}',
                jsonb_build_object('at', to_jsonb(now()), 'note', $2::text)),
              '{updates}',
              (SELECT COALESCE(jsonb_agg(u ORDER BY ord), '[]'::jsonb)
                 FROM (
                   SELECT u, ord FROM jsonb_array_elements(
                            COALESCE(mandate->'updates', '[]'::jsonb)
                            || jsonb_build_array(jsonb_build_object('at', to_jsonb(now()), 'note', $2::text))
                          ) WITH ORDINALITY AS t(u, ord)
                    ORDER BY ord DESC
                    LIMIT $3
                 ) kept)),
            updated_at = now()
      WHERE id = $1`,
    [grantId, note, MANDATE_UPDATES_KEPT]
  );
}

/** A mandate's kept updates, newest first, a page at a time. */
export async function listMandateUpdates(
  grantId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<{ total: number; updates: MandateUpdate[] }> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const offset = Math.max(0, opts.offset ?? 0);
  const [row] = await rawQuery<{
    updates: MandateUpdate[] | null;
    last_review: MandateUpdate | null;
  }>(
    `SELECT mandate->'updates' AS updates, mandate->'last_review' AS last_review
       FROM grants WHERE id = $1`,
    [grantId]
  );
  // A mandate whose notes predate the kept list has its latest alone.
  const all =
    Array.isArray(row?.updates) && row.updates.length > 0
      ? [...row.updates].reverse()
      : row?.last_review
        ? [row.last_review]
        : [];
  return { total: all.length, updates: all.slice(offset, offset + limit) };
}
