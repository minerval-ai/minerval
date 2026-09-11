/**
 * The action ledger — the mechanical layer of the allocation engine.
 *
 * One row per potential action (src/db/schema.ts `actions`). Alternative
 * ways of doing the same thing share an exclusion_group; at most one
 * sibling runs. Everything here is MECHANISM — pure functions of the
 * ledger and the allocations on it. Judgment (what is valuable, which
 * variant to back, how much) lives upstream in mandate_valuations and in
 * each mandate's allocator.
 *
 * The rules, in full:
 *  - coverage(action) = SUM(unspent, unreleased allocations on its group
 *    that are unpinned or pinned to it) ≥ cost_est → the action is
 *    RUNNABLE.
 *  - Among runnable siblings, the most-backed wins (tie → cheapest).
 *  - When a winner finishes: it is `done`; its siblings are `superseded`;
 *    pinned allocations on losers are RELEASED back to their funders (a
 *    vote for a losing way of doing it is returned, not spent); the
 *    metered cost is consumed pro rata from the winner's covering
 *    allocations.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { stewardTierCostEstimates } from "./cost-estimate-service.js";
import { getMandateAllocationPolicy } from "./allocation-policy-service.js";
import { capMicroUsd } from "./owl.js";

export type ActionKind =
  | "assess"
  | "reassess"
  | "ingest"
  | "grant_planning"
  // A mandate's periodic review pass: its Grantmaker acting with the
  // discretion of anyone entrusted with a mandate — surveying its
  // territory (the graph and the open web), valuing the open ledger,
  // growing its own plan, and moving money (regrants). Bounded by its
  // metered cap and the mandate's escrow, never by narrowed affordances.
  | "mandate_review"
  // Write a claim's formal statement (docs/mathematics.md §5.4): the Steward
  // drafts, elaborates against the checker, and records `reviewed`; a
  // fresh-context Steward pass on the strong model then publishes or sends
  // it back. Two passes per statement, because "every line correct, wrong
  // theorem" is the failure no checker catches.
  | "formalize"
  // A solver attempt on a published statement (§7.2): group
  // `attempt:<formalization_id>:<n>`, variants `standard` and `max`. A
  // closed attempt never reopens; a later attempt is a new group. Bounded
  // by its dollar ceiling, the claim's lifetime cap, and the solver's daily
  // breaker, never selected by them.
  | "attempt_proof"
  // The review of one prize claim (§8.6): the cold-lane check, the Reviewer
  // run, the Steward's `prize_claim` run, and the audit — self-funded from
  // the platform-owned prize-review reserve minted when the bounty opened,
  // outside any mandate's day room, so a claim never waits on a paused
  // escrow and the claimant is never charged.
  | "prize_review";

export const ASSESS_GROUP = (claimId: string) => `assess:${claimId}`;
export const PLANNING_GROUP = (grantId: string) => `plan:${grantId}`;
export const INGEST_GROUP = (url: string) => `ingest:${url}`;
export const REVIEW_GROUP = (grantId: string) => `review:${grantId}`;
/** One statement per claim at a time: one group, one variant (§5.4). */
export const FORMALIZE_GROUP = (claimId: string) => `formalize:${claimId}`;
/** `attempt:<formalization_id>:<n>` — a closed attempt never reopens (§7.2). */
export const ATTEMPT_GROUP = (formalizationId: string, n: number) =>
  `attempt:${formalizationId}:${n}`;

/** The two solver variants every attempt group carries as siblings (§7.2). */
export const ATTEMPT_VARIANTS = ["standard", "max"] as const;

/** How often a mandate's Grantmaker takes a review pass. */
const REVIEW_CADENCE_HOURS = 24;

/**
 * A formalize item whose claim still has no published statement is wanted
 * again after this long: the same pacing as the mandate's review pass, so
 * a returned-to-draft statement is retried without a hot loop.
 */
const FORMALIZE_RETRY_HOURS = 24;

/** A live attempt stamps updated_at every turn; only a dead worker trips this. */
const ATTEMPT_REOPEN_HOURS = 3;

/** Coverage subquery for one actions row `a` (SQL fragment). */
export const COVERAGE_SQL = `
  COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
              FROM action_allocations al
             WHERE al.exclusion_group = a.exclusion_group
               AND al.released_at IS NULL
               AND (al.action_id IS NULL OR al.action_id = a.id)), 0)`;

// ---------------------------------------------------------------------------
// Producers: keep the ledger's open rows in sync with the graph's state.
// Idempotent upserts, called from enqueue paths and the scheduler sweep.
// ---------------------------------------------------------------------------

/**
 * Ensure the assess/reassess exclusion group for one claim exists with a
 * row per variant (standard always; strong when a strong model is
 * configured). Kind is 'assess' for a first pass, 'reassess' when a
 * current assessment exists. Refreshes cost estimates on existing rows.
 */
export async function ensureAssessActions(claimId: string): Promise<void> {
  const config = loadConfig();
  const tiers = await stewardTierCostEstimates();
  const [claim] = await rawQuery<{ text: string; assessed: boolean }>(
    `SELECT c.text,
            EXISTS (SELECT 1 FROM assessments x
                     WHERE x.claim_id = c.id AND x.is_current = true)
              AS assessed
       FROM claims c
      WHERE c.id = $1 AND c.state = 'active'`,
    [claimId]
  );
  if (!claim) return;
  const kind = claim.assessed ? "reassess" : "assess";
  const group = ASSESS_GROUP(claimId);
  const label = claim.text.slice(0, 300);
  const variants: Array<[string, number]> = [
    ["standard", tiers.standardMicroUsd],
  ];
  if (config.stewardStrongModel) {
    variants.push(["strong", tiers.strongMicroUsd]);
  }
  for (const [variant, cost] of variants) {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (exclusion_group, variant) DO UPDATE
         SET cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
             kind = EXCLUDED.kind,
             -- One row per (group, variant), holding the claim's CURRENT
             -- potential action: a done/superseded/cancelled row reopens
             -- when fresh work is wanted (the next pass), a running row is
             -- left alone. History lives in assessments and llm_usage.
             status = CASE WHEN actions.status = 'running'
                           THEN actions.status ELSE 'open' END,
             updated_at = now()`,
      [kind, group, variant, claimId, label, Math.round(cost)]
    );
  }
}

/**
 * Sweep the whole ledger into sync:
 *  - open assess/reassess groups for every pending claim;
 *  - open ingest actions for unexecuted grant-plan ingest items, and
 *    advance plan cursors past ingest items whose action is done;
 *  - open grant_planning actions for grants awaiting their planning run;
 *  - open valuation actions for mandates whose Grantmaker is due to
 *    re-judge the open ledger (VALUATION_CADENCE_HOURS);
 *  - cancel assess groups whose claim is no longer pending/active;
 *  - release actions stuck 'running' by a crashed worker.
 * Bounded work per sweep; returns counts for the scheduler's log line.
 */
export async function reconcileActions(): Promise<{
  assessEnsured: number;
  cancelled: number;
  /** Mandates whose plan could not be materialized this sweep (logged). */
  plansFailed: number;
}> {
  const pending = await rawQuery<{ id: string }>(
    `SELECT c.id FROM claims c
      WHERE c.state = 'active' AND c.steward_state = 'pending'
        AND NOT EXISTS (SELECT 1 FROM actions a
                         WHERE a.exclusion_group = 'assess:' || c.id::text
                           AND a.status IN ('open', 'running'))
      LIMIT 500`
  );
  for (const row of pending) {
    // One claim's failure (a bad row, a transient DB error) must not take
    // the rest of the sweep with it: log and move on (#416).
    try {
      await ensureAssessActions(row.id);
    } catch (err) {
      console.error(
        `[reconcile] ensureAssessActions failed for claim ${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Ingest + planning + valuation actions from live grants.
  const grants = await rawQuery<PlanGrantRow>(
    `SELECT id, name, status, policy, plan, plan_cursor FROM grants
      WHERE status IN ('active', 'planning')`
  );
  const ctx = newMaterializeContext();
  let plansFailed = 0;
  for (const g of grants) {
    if (g.status === "planning") {
      await rawQuery(
        `INSERT INTO actions
           (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd)
         VALUES ('grant_planning', $1, 'standard', $2, $3, $4)
         ON CONFLICT (exclusion_group, variant) DO UPDATE
           SET status = 'open', updated_at = now()
           -- A grant still in 'planning' with a closed planning action
           -- wants a fresh run (a failed write, a pushed-back plan).
           WHERE actions.status NOT IN ('open', 'running')`,
        [
          PLANNING_GROUP(g.id),
          g.id,
          `Planning run for the mandate "${g.name}"`,
          capMicroUsd("assessment"),
        ]
      );
    }

    // The mandate's periodic review pass — its Grantmaker stewarding the
    // mandate with discretion. Every active mandate gets one, the General
    // mandate included: its valuations come from a formula rather than from
    // per-action judgment, but the formula's knobs are exactly the kind of
    // thing a steward should revise as evidence about allocation itself
    // accumulates, and it has the same pacing, regranting and scope
    // decisions to make as any other. Exempting it left the platform's own
    // lane as the one mandate no agent was ever asked to think about.
    if (g.status === "active") {
      await rawQuery(
        `INSERT INTO actions
           (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd)
         VALUES ('mandate_review', $1, 'standard', $2, $3, $4)
         ON CONFLICT (exclusion_group, variant) DO UPDATE
           SET status = 'open', updated_at = now()
           WHERE actions.status IN ('done', 'superseded', 'cancelled')
             AND actions.updated_at < now() - make_interval(hours => ${REVIEW_CADENCE_HOURS})`,
        [
          REVIEW_GROUP(g.id),
          g.id,
          `Mandate review for "${g.name}"`,
          capMicroUsd("assessment"),
        ]
      );
    }

    // The plan itself: every item becomes a ledger row or carries a stated
    // reason why it cannot (materializeGrantPlan). One mandate's failure is
    // logged and reported, never allowed to abort the other mandates' plans
    // (#416: a silent abort here left plan items "queued" for days).
    try {
      await materializeGrantPlan(g, ctx);
    } catch (err) {
      plansFailed++;
      await reportPlanFailure(g, err);
    }
  }

  // A formalize row is pointless once the claim carries a published
  // statement (an ordinary pass may have published one); an attempt row is
  // pointless once its statement is no longer published (§7.2).
  await rawQuery(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.status = 'open' AND a.kind = 'formalize'
        AND EXISTS (SELECT 1 FROM claim_formalizations f
                     WHERE f.claim_id = a.claim_id AND f.status = 'published')`
  );
  await rawQuery(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.status = 'open' AND a.kind = 'attempt_proof'
        AND NOT EXISTS (SELECT 1 FROM claim_formalizations f
                         WHERE f.id::text = split_part(a.exclusion_group, ':', 2)
                           AND f.status = 'published')`
  );

  // Close groups whose claim left the candidate set (assessed elsewhere,
  // archived, or mid-run on the express lane long enough to have finished).
  const cancelled = await rawQuery<{ id: string }>(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.status = 'open' AND a.kind IN ('assess', 'reassess')
        AND NOT EXISTS (SELECT 1 FROM claims c
                         WHERE c.id = a.claim_id AND c.state = 'active'
                           AND c.steward_state IN ('pending', 'running'))
      RETURNING a.id`
  );

  // A worker that died mid-run leaves its action 'running' forever;
  // return it to open so coverage can send it again. Generous window —
  // real runs (a deep steward pass) can be long. Ingest actions get a much
  // longer window: they legitimately stay 'running' while the async
  // extraction worker holds them (which completes or cancels them itself),
  // and reopening one early re-submits the source — a second metered
  // extraction charged to the same funders. A solver attempt stamps
  // updated_at every turn (§7.9), so three untouched hours means a dead
  // worker, not a long proof.
  await rawQuery(
    `UPDATE actions SET status = 'open', updated_at = now()
      WHERE status = 'running'
        AND ((kind NOT IN ('ingest', 'attempt_proof') AND updated_at < now() - interval '60 minutes')
             OR (kind = 'ingest' AND updated_at < now() - interval '24 hours')
             OR (kind = 'attempt_proof' AND updated_at < now() - make_interval(hours => ${ATTEMPT_REOPEN_HOURS})))`
  );

  return { assessEnsured: pending.length, cancelled: cancelled.length, plansFailed };
}

/**
 * Open (or keep) the formalize row for a claim that has no published
 * statement: group `formalize:<claim_id>`, one variant. A closed row is
 * wanted again after FORMALIZE_RETRY_HOURS while the claim still lacks a
 * published statement (a returned-to-draft statement retried on the
 * review cadence); a claim with a published statement opens nothing.
 */
export async function ensureFormalizeAction(
  claimId: string,
  costEstMicroUsd: number
): Promise<void> {
  await rawQuery(
    `INSERT INTO actions
       (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd)
     SELECT 'formalize', $1, 'standard', c.id,
            'Formalize: ' || left(c.text, 280), $3
       FROM claims c
      WHERE c.id = $2 AND c.state = 'active'
        AND NOT EXISTS (SELECT 1 FROM claim_formalizations f
                         WHERE f.claim_id = c.id AND f.status = 'published')
     ON CONFLICT (exclusion_group, variant) DO UPDATE
       SET cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
           status = 'open', updated_at = now()
       WHERE actions.status IN ('done', 'cancelled', 'superseded')
         AND actions.updated_at < now() - make_interval(hours => ${FORMALIZE_RETRY_HOURS})`,
    [FORMALIZE_GROUP(claimId), claimId, Math.round(costEstMicroUsd)]
  );
}

/**
 * A plan item's rationale waives the attempt cooldown only when it says
 * something: at least this many characters (a new lemma in the subtree was
 * formalized; a prior report names a route it could not pursue for budget).
 */
export const ATTEMPT_COOLDOWN_RATIONALE_MIN_CHARS = 20;

/**
 * Open the next attempt group on a claim's published statement when the
 * plan asks for more attempts than the ledger has opened: group
 * `attempt:<formalization_id>:<n>` with `n` one more than the closed
 * attempts on that statement, and the two variants as sibling rows. Each
 * plan item entitles one group; a group still open or running blocks the
 * next; a claim without a published statement opens nothing; and the next
 * group waits out the mandate's `attempt_cooldown_days` after the last
 * closed attempt unless the item entitling it states a reason (§7.2).
 */
export interface EnsureAttemptResult {
  /** The published statement the groups hang off, when there is one. */
  formalizationId: string | null;
  /** Attempt groups on that statement after this call. */
  groups: number;
  /** True when this call opened a new group. */
  opened: boolean;
  /** Why no group was opened, in words the plan's author can act on. */
  reason: string | null;
}

export async function ensureAttemptActions(
  claimId: string,
  wantedGroups: number,
  costs: { standard: number; max: number },
  opts: { cooldownDays?: number; rationales?: readonly string[] } = {}
): Promise<EnsureAttemptResult> {
  const [formalization] = await rawQuery<{ id: string }>(
    `SELECT id FROM claim_formalizations
      WHERE claim_id = $1 AND status = 'published'`,
    [claimId]
  );
  if (!formalization) {
    return {
      formalizationId: null,
      groups: 0,
      opened: false,
      reason:
        "the claim has no published formal statement; an attempt opens only " +
        "once a formalize item has published one (docs/mathematics.md §7.2)",
    };
  }
  const [state] = await rawQuery<{ groups: number; live: number }>(
    `SELECT COUNT(DISTINCT exclusion_group)::int AS groups,
            COUNT(*) FILTER (WHERE status IN ('open', 'running'))::int AS live
       FROM actions
      WHERE kind = 'attempt_proof' AND exclusion_group LIKE $1`,
    [`attempt:${formalization.id}:%`]
  );
  const groups = Number(state?.groups ?? 0);
  const live = Number(state?.live ?? 0);
  const base = { formalizationId: formalization.id, groups, opened: false };
  if (live > 0) {
    return {
      ...base,
      reason: "an earlier attempt on this statement is still open or running; the next group opens when it closes",
    };
  }
  if (groups >= wantedGroups) return { ...base, reason: null };
  const cooldownDays = Math.max(0, Number(opts.cooldownDays ?? 0));
  if (cooldownDays > 0) {
    const [last] = await rawQuery<{ finished_at: Date }>(
      `SELECT finished_at FROM proof_attempts
        WHERE formalization_id = $1 AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
      [formalization.id]
    );
    const withinCooldown =
      !!last && new Date(last.finished_at).getTime() > Date.now() - cooldownDays * 86_400_000;
    if (withinCooldown) {
      const rationales = opts.rationales ?? [];
      const rationale = rationales[groups] ?? rationales[rationales.length - 1] ?? "";
      if (rationale.trim().length < ATTEMPT_COOLDOWN_RATIONALE_MIN_CHARS) {
        return {
          ...base,
          reason:
            `the last attempt closed within the mandate's ${cooldownDays}-day cooldown; ` +
            `the entitling item's rationale must state at least ${ATTEMPT_COOLDOWN_RATIONALE_MIN_CHARS} ` +
            "characters of reason (a new lemma formalized, a route the prior report could not pursue) to waive it",
        };
      }
    }
  }
  const n = groups + 1;
  for (const variant of ATTEMPT_VARIANTS) {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, claim_id, target_ref, label, cost_est_micro_usd)
       SELECT 'attempt_proof', $1, $2, c.id, $3,
              'Attempt ' || $4::text || ' (' || $2 || '): ' || left(c.text, 260), $5
         FROM claims c
        WHERE c.id = $6 AND c.state = 'active'
       ON CONFLICT (exclusion_group, variant) DO NOTHING`,
      [
        ATTEMPT_GROUP(formalization.id, n),
        variant,
        formalization.id,
        String(n),
        Math.round(costs[variant]),
        claimId,
      ]
    );
  }
  return { formalizationId: formalization.id, groups: n, opened: true, reason: null };
}

// ---------------------------------------------------------------------------
// Plan-to-ledger materialization: every plan item becomes a ledger row or
// carries a stated reason why it cannot, written back onto the item itself
// (`ledger`) so the mandate's Grantmaker, the dashboard, and the Audit
// Agent all read the same state (#416).
// ---------------------------------------------------------------------------

/**
 * A plan item's standing on the ledger, as stored on the item:
 *  - open / running / done / cancelled mirror the row (superseded reads as
 *    done: a sibling won);
 *  - waiting: a precondition the platform satisfies on its own (a statement
 *    still to be published, a live earlier attempt, a cooldown);
 *  - blocked: something the plan's author must change (a claim that is not
 *    active, a formalize item on a claim whose domains carry no
 *    publish_formalization tool, a materializer error).
 */
export type PlanItemLedgerStatus =
  | "open"
  | "running"
  | "done"
  | "cancelled"
  | "waiting"
  | "blocked";

export interface PlanItemLedger {
  status: PlanItemLedgerStatus;
  /** For waiting/blocked (always) and closed rows (when useful): why. */
  reason?: string;
  action_id?: string;
  exclusion_group?: string;
  /** ISO timestamp of the sweep or call that last wrote this. */
  checked_at: string;
}

/** The plan item shape the materializer reads (a loose PlanItem). */
export interface MaterializablePlanItem {
  action: string;
  url?: string;
  claim_id?: string;
  variant?: string;
  rationale?: string;
  ledger?: PlanItemLedger;
  [key: string]: unknown;
}

export interface PlanGrantRow {
  id: string;
  name: string;
  status: string;
  policy: string;
  plan: { strategy?: string; items?: MaterializablePlanItem[] } | null;
  plan_cursor: number;
}

export interface PlanItemOutcome {
  index: number;
  action: string;
  claim_id?: string;
  url?: string;
  ledger: PlanItemLedger;
}

/** Per-sweep memo of the cost estimates the rows carry. */
interface MaterializeContext {
  ingestCostMicroUsd: number;
  formalizeCostMicroUsd: () => Promise<number>;
}

function newMaterializeContext(): MaterializeContext {
  // The strong-tier estimate the formalize rows carry (two strong passes),
  // computed once per sweep and only when some plan asks for one.
  let strongPassMicroUsd: number | null = null;
  return {
    ingestCostMicroUsd: capMicroUsd("source_ingest"),
    formalizeCostMicroUsd: async () => {
      if (strongPassMicroUsd === null) {
        strongPassMicroUsd = (await stewardTierCostEstimates()).strongMicroUsd;
      }
      return Math.round(strongPassMicroUsd * 2);
    },
  };
}

/** How far the Steward's publishing tool is from a claim: the formalize gate. */
async function formalizeToolGap(claimId: string): Promise<string | null> {
  // Lazy: steward-direct pulls the LLM tool registry in, which this
  // mechanism module must not load at import time (queue-service imports
  // us; the registry imports the services).
  const { missingTriggerTools } = await import("../workers/steward-direct.js");
  const { skills, missing } = await missingTriggerTools("formalize", claimId);
  if (missing.length === 0) return null;
  return (
    `the claim's recorded domains activate ${
      skills.length > 0 ? `the skill(s) ${skills.join(", ")}` : "no skill"
    }, none of which carries ${missing.join(", ")} for the Steward; a formalize ` +
    "run would be refused. Tag the claim with the domain whose skill declares " +
    "the tool (mathematics; a Steward pass with set_claim_domains) or drop the item"
  );
}

/** The ledger status one exclusion group (or one row) reads as. */
async function groupLedger(
  where: { group: string } | { actionId: string }
): Promise<{ status: "open" | "running" | "done" | "cancelled"; action_id: string; exclusion_group: string } | null> {
  const rows =
    "group" in where
      ? await rawQuery<{ id: string; status: string; exclusion_group: string }>(
          `SELECT id, status, exclusion_group FROM actions
            WHERE exclusion_group = $1
            ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'open' THEN 1
                                 WHEN 'done' THEN 2 WHEN 'superseded' THEN 3
                                 ELSE 4 END, updated_at DESC
            LIMIT 1`,
          [where.group]
        )
      : await rawQuery<{ id: string; status: string; exclusion_group: string }>(
          `SELECT id, status, exclusion_group FROM actions WHERE id = $1`,
          [where.actionId]
        );
  const row = rows[0];
  if (!row) return null;
  const status =
    row.status === "running" || row.status === "open" || row.status === "cancelled"
      ? row.status
      : "done";
  return { status, action_id: row.id, exclusion_group: row.exclusion_group };
}

interface ClaimStanding {
  id: string;
  state: string;
  steward_state: string;
  published: boolean;
}

async function claimStanding(claimId: string): Promise<ClaimStanding | null> {
  const [row] = await rawQuery<ClaimStanding>(
    `SELECT c.id, c.state, c.steward_state,
            EXISTS (SELECT 1 FROM claim_formalizations f
                     WHERE f.claim_id = c.id AND f.status = 'published') AS published
       FROM claims c WHERE c.id = $1`,
    [claimId]
  );
  return row ?? null;
}

const nowIso = () => new Date().toISOString();
const waiting = (reason: string): PlanItemLedger => ({ status: "waiting", reason, checked_at: nowIso() });
const blocked = (reason: string): PlanItemLedger => ({ status: "blocked", reason, checked_at: nowIso() });
const fromRow = (
  row: { status: PlanItemLedgerStatus; action_id: string; exclusion_group: string },
  reason?: string
): PlanItemLedger => ({
  status: row.status,
  action_id: row.action_id,
  exclusion_group: row.exclusion_group,
  ...(reason ? { reason } : {}),
  checked_at: nowIso(),
});

/**
 * Materialize one mandate's whole plan: cursor bookkeeping and ingest rows
 * (any live grant), and the stewarding, formal-statement and attempt rows
 * (an active mandate only, since they cost strong-tier money), then write
 * each item's ledger standing back onto the plan. Returns every item's
 * outcome in plan order. Throws only on a failure outside any one item
 * (loading the grant, the plan write); a single item's error becomes that
 * item's `blocked` reason.
 */
export async function materializeGrantPlan(
  g: PlanGrantRow,
  ctx: MaterializeContext = newMaterializeContext()
): Promise<PlanItemOutcome[]> {
  const items = g.plan?.items ?? [];
  const outcomes: PlanItemOutcome[] = [];

  // Plan cursor bookkeeping. An ingest item whose ledger action is DONE is
  // finished work: the cursor moves past it. Done AND cancelled both move
  // the cursor: a cancelled ingest (a poison URL the executor retired) must
  // not wedge the plan forever behind it. A group with only open/running
  // rows still blocks. Only ingest items are cursor-driven: every other
  // kind reports through its own ledger standing below.
  let cursor = g.plan_cursor;
  while (cursor < items.length) {
    const item = items[cursor]!;
    if (item.action !== "ingest" || !item.url) break;
    const [closed] = await rawQuery<{ id: string }>(
      `SELECT id FROM actions
        WHERE exclusion_group = $1 AND status IN ('done', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM actions o
                           WHERE o.exclusion_group = $1
                             AND o.status IN ('open', 'running'))
        LIMIT 1`,
      [INGEST_GROUP(item.url)]
    );
    if (!closed) break;
    cursor++;
  }
  if (cursor !== g.plan_cursor) {
    await rawQuery(
      `UPDATE grants SET plan_cursor = $2, updated_at = now()
        WHERE id = $1 AND plan_cursor = $3`,
      [g.id, cursor, g.plan_cursor]
    );
  }

  const active = g.status === "active";
  const notActive = waiting(
    `the mandate is ${g.status}, not active; this work opens once it is`
  );

  // attempt_proof entitlement is per claim across items: the n-th item on a
  // claim entitles the n-th group, and its rationale is what may waive the
  // cooldown (§7.2). Resolve each claim once, then read every item's group.
  const attemptItems = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.action !== "attempt_proof" || !it.claim_id) continue;
    const list = attemptItems.get(it.claim_id) ?? [];
    list.push(i);
    attemptItems.set(it.claim_id, list);
  }
  const attemptResults = new Map<string, EnsureAttemptResult>();
  if (active && attemptItems.size > 0) {
    const policy = await getMandateAllocationPolicy(g.id);
    const owl = loadConfig().owlCostMicroUsd;
    const costs = {
      standard: Math.round(policy.est_attempt_standard_cost_owls * owl),
      max: Math.round(policy.est_attempt_max_cost_owls * owl),
    };
    for (const [claimId, indices] of attemptItems) {
      try {
        attemptResults.set(
          claimId,
          await ensureAttemptActions(claimId, indices.length, costs, {
            cooldownDays: Number(policy.attempt_cooldown_days ?? 0),
            rationales: indices.map((i) => String(items[i]!.rationale ?? "")),
          })
        );
      } catch (err) {
        console.error(
          `[reconcile] ensureAttemptActions failed for claim ${claimId} (mandate ${g.id}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  const ensuredFormalize = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    let ledger: PlanItemLedger;
    try {
      ledger = await materializePlanItem(g, item, i, {
        ctx,
        cursor,
        active,
        notActive,
        ensuredFormalize,
        attemptOrdinal: attemptItems.get(item.claim_id ?? "")?.indexOf(i) ?? -1,
        attemptResult: attemptResults.get(item.claim_id ?? "") ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[reconcile] plan item ${i} (${item.action}) of mandate ${g.id} failed: ${msg}`);
      ledger = blocked(`the materializer failed on this item: ${msg}`);
    }
    outcomes.push({
      index: i,
      action: item.action,
      ...(item.claim_id ? { claim_id: item.claim_id } : {}),
      ...(item.url ? { url: item.url } : {}),
      ledger,
    });
    if (!sameLedger(item.ledger, ledger)) {
      // One item at a time, by path: an extend_plan append racing this
      // sweep must not be overwritten by a whole-array write.
      await rawQuery(
        `UPDATE grants
            SET plan = jsonb_set(plan, $2::text[], $3::jsonb)
          WHERE id = $1 AND jsonb_array_length(COALESCE(plan->'items', '[]'::jsonb)) > $4`,
        [g.id, ["items", String(i), "ledger"], JSON.stringify(ledger), i]
      );
    }
  }
  return outcomes;
}

function sameLedger(a: PlanItemLedger | undefined, b: PlanItemLedger): boolean {
  if (!a) return false;
  return (
    a.status === b.status &&
    (a.reason ?? null) === (b.reason ?? null) &&
    (a.action_id ?? null) === (b.action_id ?? null) &&
    (a.exclusion_group ?? null) === (b.exclusion_group ?? null)
  );
}

async function materializePlanItem(
  g: PlanGrantRow,
  item: MaterializablePlanItem,
  index: number,
  o: {
    ctx: MaterializeContext;
    cursor: number;
    active: boolean;
    notActive: PlanItemLedger;
    attemptOrdinal: number;
    attemptResult: EnsureAttemptResult | null;
    ensuredFormalize: Set<string>;
  }
): Promise<PlanItemLedger> {
  const kind = item.action;

  if (kind === "ingest") {
    if (!item.url) return blocked("an ingest item needs a url");
    if (index < o.cursor) {
      const row = await groupLedger({ group: INGEST_GROUP(item.url) });
      return row ? fromRow({ ...row, status: "done" }) : { status: "done", checked_at: nowIso() };
    }
    // An unexecuted one gets (or keeps) its open row, funded by the grant's
    // own escrow (fundGrantSelfActions).
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd)
       VALUES ('ingest', $1, 'standard', $2, $3, $4)
       ON CONFLICT (exclusion_group, variant) DO NOTHING`,
      [INGEST_GROUP(item.url), item.url, `Ingest ${item.url}`, o.ctx.ingestCostMicroUsd]
    );
    const row = await groupLedger({ group: INGEST_GROUP(item.url) });
    return row ? fromRow(row) : blocked("no ingest row could be opened for this url");
  }

  if (!item.claim_id) return blocked(`a ${kind} item needs a claim_id`);
  const claim = await claimStanding(item.claim_id);
  if (!claim) return blocked(`claim ${item.claim_id} does not exist`);
  if (claim.state !== "active") {
    return blocked(`claim ${item.claim_id} is ${claim.state}, not active; the ledger only carries work on active claims`);
  }

  if (kind === "assess" || kind === "reassess" || kind === "deepen") {
    // A stewarding item is consumed once its pass has run: a finished row
    // stays finished (re-enqueueing on every sweep would loop the claim
    // through the Steward forever). Otherwise the claim's steward_state IS
    // the queue: not pending → enqueue, then mirror the assess group's row.
    if (item.ledger?.action_id) {
      const prior = await groupLedger({ actionId: item.ledger.action_id });
      if (prior && (prior.status === "done" || prior.status === "cancelled")) {
        return fromRow(prior);
      }
    }
    if (!o.active) return o.notActive;
    if (kind === "deepen") {
      // The claim plus its deferred subtree: promote the held-out
      // subclaims so the drain reaches them too (#98's brake, released for
      // this subtree by a funder's say-so). Idempotent, so it runs whether
      // or not the claim itself still needs queueing (an earlier item on
      // the same claim may have queued it already).
      await rawQuery(
        `UPDATE claims SET steward_state = 'pending', updated_at = now()
          WHERE state = 'active' AND steward_state = 'deferred'
            AND id IN (SELECT child_claim_id FROM claim_relationships
                        WHERE parent_claim_id = $1)`,
        [claim.id]
      );
    }
    if (claim.steward_state !== "pending" && claim.steward_state !== "running") {
      const { enqueueSteward } = await import("./queue-service.js");
      await enqueueSteward({
        claimId: claim.id,
        trigger: "mandate_plan",
        context:
          `${kind} requested by the mandate "${g.name}": ` +
          `${String(item.rationale ?? "").trim() || "no rationale given"}`,
      });
    }
    await ensureAssessActions(claim.id);
    const row = await groupLedger({ group: ASSESS_GROUP(claim.id) });
    return row ? fromRow(row) : blocked("no assess row could be opened for this claim");
  }

  if (kind === "formalize") {
    if (claim.published) {
      const row = await groupLedger({ group: FORMALIZE_GROUP(claim.id) });
      const reason = "the claim already carries a published formal statement";
      return row
        ? fromRow({ ...row, status: "done" }, reason)
        : { status: "done", reason, checked_at: nowIso() };
    }
    if (!o.active) return o.notActive;
    const gap = await formalizeToolGap(claim.id);
    if (gap) return blocked(gap);
    // One statement per claim at a time (§5.4): a second formalize item on
    // the same claim reads the same row rather than upserting it again.
    if (!o.ensuredFormalize.has(claim.id)) {
      await ensureFormalizeAction(claim.id, await o.ctx.formalizeCostMicroUsd());
      o.ensuredFormalize.add(claim.id);
    }
    const row = await groupLedger({ group: FORMALIZE_GROUP(claim.id) });
    if (!row) return blocked("no formalize row could be opened for this claim");
    if (row.status === "done" || row.status === "cancelled") {
      return fromRow(
        row,
        `the last formalize run ended ${row.status} without a published statement; ` +
          `the sweep reopens the row ${FORMALIZE_RETRY_HOURS} hours after it closed while the claim still lacks one`
      );
    }
    return fromRow(row);
  }

  if (kind === "attempt_proof") {
    if (!o.active) return o.notActive;
    const res = o.attemptResult;
    if (!res || !res.formalizationId) {
      return waiting(
        res?.reason ??
          "the claim has no published formal statement; an attempt opens only " +
            "once a formalize item has published one (docs/mathematics.md §7.2)"
      );
    }
    const n = o.attemptOrdinal + 1;
    if (n <= res.groups) {
      const row = await groupLedger({ group: ATTEMPT_GROUP(res.formalizationId, n) });
      if (row) return fromRow(row);
    }
    return waiting(
      res.reason ??
        "this item's attempt group opens when the earlier groups on the statement have closed"
    );
  }

  return blocked(`unknown plan item kind "${kind}"`);
}

/**
 * Materialize one mandate's plan now, outside the sweep: the extend_plan
 * and adjust_plan tools call this so the Grantmaker learns, in the same
 * turn, whether each item became work and if not why. Returns the outcomes
 * for the requested item indices (all items when none are given).
 */
export async function materializePlanItems(
  grantId: string,
  indices?: readonly number[]
): Promise<PlanItemOutcome[]> {
  const [g] = await rawQuery<PlanGrantRow>(
    `SELECT id, name, status, policy, plan, plan_cursor FROM grants WHERE id = $1`,
    [grantId]
  );
  if (!g) return [];
  const outcomes = await materializeGrantPlan(g);
  if (!indices) return outcomes;
  const wanted = new Set(indices);
  return outcomes.filter((o) => wanted.has(o.index));
}

/** A mandate whose plan failed to materialize: log it and file a report. */
async function reportPlanFailure(g: PlanGrantRow, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[reconcile] plan materialization failed for mandate ${g.id} ("${g.name}"): ${msg}`);
  try {
    // The agents' own channel (#366), used by the machinery for itself:
    // repeats collapse onto one row, so a sweep failing every six hours is
    // one issue with a rising count, not a flood.
    const { raiseIssue } = await import("./report-service.js");
    await raiseIssue({
      agent: "allocation_scheduler",
      origin: "internal",
      kind: "system_failure",
      severity: "degraded",
      surface: "reconcileActions / plan-to-ledger materialization",
      title: `plan materialization failed for mandate ${g.id}`,
      body:
        `The reconcile sweep could not materialize the plan of the mandate "${g.name}" ` +
        `(${g.id}); its items keep whatever ledger standing they last had. Error: ${msg.slice(0, 2000)}`,
      contextRefs: { grant_id: g.id },
    });
  } catch (reportErr) {
    console.error(
      `[reconcile] could not file the report for mandate ${g.id}: ${
        reportErr instanceof Error ? reportErr.message : String(reportErr)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution and execution bookkeeping.
// ---------------------------------------------------------------------------

export interface RunnableAction {
  id: string;
  kind: ActionKind;
  exclusion_group: string;
  variant: string;
  claim_id: string | null;
  target_ref: string | null;
  cost_est_micro_usd: number;
  coverage_micro_usd: number;
  updated_at: Date;
}

/**
 * The next action the mechanism says to run, for the given kinds: among
 * covered open actions, resolve each exclusion group to its winner (most
 * backing, tie → cheapest), then take the winner with the most backing
 * overall. Pure function of allocations; no valuations involved.
 */
export async function nextRunnableAction(
  kinds: ActionKind[]
): Promise<RunnableAction | null> {
  const rows = await rawQuery<RunnableAction>(
    `SELECT a.id, a.kind, a.exclusion_group, a.variant, a.claim_id,
            a.target_ref, a.cost_est_micro_usd, a.updated_at,
            ${COVERAGE_SQL} AS coverage_micro_usd
       FROM actions a
      WHERE a.status = 'open' AND a.kind = ANY($1)
        AND ${COVERAGE_SQL} >= a.cost_est_micro_usd
      ORDER BY coverage_micro_usd DESC, a.updated_at ASC
      LIMIT 20`,
    [kinds]
  );
  if (rows.length === 0) return null;
  // Resolve groups: one winner per group, most backing then cheapest.
  const byGroup = new Map<string, RunnableAction[]>();
  for (const row of rows) {
    const list = byGroup.get(row.exclusion_group) ?? [];
    list.push(row);
    byGroup.set(row.exclusion_group, list);
  }
  const winners: RunnableAction[] = [];
  for (const siblings of byGroup.values()) {
    siblings.sort(
      (x, y) =>
        Number(y.coverage_micro_usd) - Number(x.coverage_micro_usd) ||
        Number(x.cost_est_micro_usd) - Number(y.cost_est_micro_usd)
    );
    winners.push(siblings[0]!);
  }
  // Most backing first; coverage ties go to the STALEST action, so a
  // freshly reopened row (a chaining review pass) queues behind work that
  // hasn't had a turn — no starvation by enthusiasm.
  winners.sort(
    (x, y) =>
      Number(y.coverage_micro_usd) - Number(x.coverage_micro_usd) ||
      new Date(x.updated_at).getTime() - new Date(y.updated_at).getTime()
  );
  return winners[0]!;
}

/** Atomically move an open action to running. False if someone else won. */
export async function claimAction(actionId: string): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE actions SET status = 'running', updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING id`,
    [actionId]
  );
  return rows.length > 0;
}

/** Return a running action to open (transient failure; not its fault). */
export async function releaseAction(actionId: string): Promise<void> {
  await rawQuery(
    `UPDATE actions SET status = 'open', updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [actionId]
  );
}

/**
 * Complete a run: the winner is done with its metered cost recorded, its
 * siblings are superseded, losing pinned allocations are released back to
 * their funders (users get a ledger credit; mandate exposure simply
 * drops), the metered cost is consumed pro rata from the winner's
 * covering allocations — and the covering allocations then SETTLE: their
 * unspent remainders release too, exactly like a cap-charge settling to
 * the metered actual. Cost estimates deliberately run high, so without
 * settlement every completed action would strand (estimate − actual) as
 * outstanding exposure forever, silently eating its funders' headroom.
 * Returns the consumed total.
 *
 * The whole close runs in ONE transaction: the done-transition is guarded
 * (a second completer for the same action is a no-op, so two settlements
 * can never both consume the same unspent coverage), and the covering
 * allocations are locked with a held `FOR UPDATE` until commit.
 * `meteredJobId` records which budget job the run's llm_usage metering was
 * attributed to, so escrow accounting can de-duplicate the pro-rata shares
 * against that job's metered total (regrant-service.grantEscrowSpend).
 */
export async function completeAction(
  actionId: string,
  meteredMicroUsd: number,
  opts: { meteredJobId?: string | null } = {}
): Promise<number> {
  return withTransaction(async (tx) => {
    // Guarded transition: only a live (running, or reconcile-reopened)
    // action completes; a done/superseded/cancelled row is already closed
    // and its coverage already consumed — return 0 and touch nothing.
    const [action] = await tx.query<{
      id: string;
      exclusion_group: string;
    }>(
      `UPDATE actions SET status = 'done', metered_cost_micro_usd = $2,
              metered_job_id = $3, updated_at = now()
        WHERE id = $1 AND status IN ('running', 'open')
        RETURNING id, exclusion_group`,
      [actionId, Math.round(meteredMicroUsd), opts.meteredJobId ?? null]
    );
    if (!action) return 0;

    await tx.query(
      `UPDATE actions SET status = 'superseded', updated_at = now()
        WHERE exclusion_group = $1 AND id <> $2 AND status IN ('open', 'running')`,
      [action.exclusion_group, actionId]
    );

    // Lock every live allocation on the group for the duration of the
    // close (plain FOR UPDATE: wait, don't skip — a skipped row would be
    // silently exempted from consumption).
    const allocations = await tx.query<{
      id: string;
      grant_id: string | null;
      user_id: string | null;
      claim_id: string | null;
      action_id: string | null;
      amount: number;
      unspent: number;
    }>(
      `SELECT id, grant_id, user_id, claim_id, action_id,
              amount_micro_usd::bigint AS amount,
              (amount_micro_usd - spent_micro_usd)::bigint AS unspent
         FROM action_allocations
        WHERE exclusion_group = $1 AND released_at IS NULL
          AND spent_micro_usd < amount_micro_usd
        ORDER BY created_at ASC
        FOR UPDATE`,
      [action.exclusion_group]
    );

    const refundUser = async (r: {
      id: string;
      user_id: string | null;
      claim_id: string | null;
      unspent: number;
      key: string;
    }) => {
      if (r.user_id && Number(r.unspent) > 0) {
        await tx.query(
          `INSERT INTO owl_ledger
             (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
           VALUES ($1, $2, 'refund', $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [r.user_id, Number(r.unspent), r.claim_id, r.key]
        );
      }
    };

    // Release losing pinned allocations: returned, not spent. User-funded
    // ones get their unspent remainder back on the owl ledger.
    const losers = allocations.filter(
      (a) => a.action_id !== null && a.action_id !== actionId
    );
    for (const r of losers) {
      await tx.query(
        `UPDATE action_allocations SET released_at = now() WHERE id = $1`,
        [r.id]
      );
      await refundUser({ ...r, key: `release:${r.id}` });
    }

    // Consume the metered cost pro rata from the winner's covering
    // allocations (pinned to it, or unpinned on the group).
    const covering = allocations.filter(
      (a) => a.action_id === null || a.action_id === actionId
    );
    let consumed = 0;
    if (meteredMicroUsd > 0) {
      const totalUnspent = covering.reduce((s, r) => s + Number(r.unspent), 0);
      const toConsume = Math.min(Math.round(meteredMicroUsd), totalUnspent);
      for (const [i, row] of covering.entries()) {
        const share =
          i === covering.length - 1
            ? toConsume - consumed
            : Math.floor((toConsume * Number(row.unspent)) / totalUnspent);
        const take = Math.min(Number(row.unspent), Math.max(0, share));
        if (take <= 0) continue;
        await tx.query(
          `UPDATE action_allocations
              SET spent_micro_usd = spent_micro_usd + $2
            WHERE id = $1`,
          [row.id, take]
        );
        consumed += take;
        row.unspent = Number(row.unspent) - take;
      }
    }

    // OVERAGE: the run cost more than its funders had promised. The money is
    // already gone — the LLM calls happened and are metered against the
    // funder's job — so the only question is whether the ledger admits it.
    //
    // It used to not. Consumption is clamped at `totalUnspent` above, so a run
    // metering 5.76 owls against a 1.93 allocation recorded 1.93 and the rest
    // vanished: absent from allocation shares, and cancelled out of the
    // non-ledger term (which subtracts actions.metered_cost, so the very row
    // recording the overspend erased it). Measured on the General mandate's
    // first epoch: 23.57 owls of real spend counted in NO term of
    // grantCommittedMicroUsd, which is why the escrow read 112 owls left when
    // 79 was the truth. An escrow that cannot see a third of its own spend is
    // not the hard ceiling the design leans on.
    //
    // So a MANDATE's overage is recorded as what it actually is: an
    // allocation, already spent. A settled row (spent = amount) sits outside
    // the live-placement unique index, so this never collides with a future
    // placement on the same group. Two things follow for free — the escrow's
    // committed total includes it, and because day room sums the amounts
    // placed today, an expensive run draws down TODAY's room by its own
    // overspend rather than leaving the pace target to describe fiction.
    //
    // A USER's overage stays absorbed by the platform: their cap is a promise
    // ("the ceiling was theirs to rely on"), and a buyer must never be billed
    // past the number on the button. Only grant-funded allocations are
    // extended, and when a group has none, the shortfall stays off-ledger —
    // where the corrected non-ledger term now counts it instead of hiding it.
    const shortfall = Math.round(meteredMicroUsd) - consumed;
    if (shortfall > 0) {
      const byGrant = new Map<string, number>();
      for (const r of covering) {
        if (!r.grant_id) continue;
        byGrant.set(r.grant_id, (byGrant.get(r.grant_id) ?? 0) + Number(r.amount));
      }
      const totalWeight = [...byGrant.values()].reduce((s, n) => s + n, 0);
      if (totalWeight > 0) {
        // Pro rata by what each mandate had promised: the funder that backed
        // most of the work carries most of the overspend.
        const entries = [...byGrant.entries()];
        let assigned = 0;
        for (const [i, [grantId, weight]] of entries.entries()) {
          const share =
            i === entries.length - 1
              ? shortfall - assigned
              : Math.floor((shortfall * weight) / totalWeight);
          if (share <= 0) continue;
          const claimId =
            covering.find((r) => r.grant_id === grantId)?.claim_id ?? null;
          await tx.query(
            `INSERT INTO action_allocations
               (exclusion_group, action_id, claim_id, grant_id,
                amount_micro_usd, spent_micro_usd, released_at)
             VALUES ($1, $2, $3, $4, $5, $5, now())`,
            [action.exclusion_group, actionId, claimId, grantId, share]
          );
          assigned += share;
          consumed += share;
        }
      }
    }

    // SETTLEMENT: whatever the covering allocations still hold beyond the
    // metered cost releases back to its funders — a mandate's headroom
    // returns, a person's owls return to their balance. The ceiling was
    // theirs to rely on; the meter is what they pay.
    for (const r of covering) {
      if (Number(r.unspent) <= 0) continue;
      await tx.query(
        `UPDATE action_allocations SET released_at = now() WHERE id = $1`,
        [r.id]
      );
      await refundUser({ ...r, key: `settle:${r.id}` });
    }
    return consumed;
  });
}

/**
 * Metering attribution for a covered run: the largest covering allocator.
 * A mandate yields its budget-job id (which also stamps the funding
 * disclosure); a person yields their user id.
 */
export async function largestActionFunder(
  actionId: string
): Promise<{ jobId?: string; userId?: string; grantId?: string }> {
  const [row] = await rawQuery<{
    grant_id: string | null;
    user_id: string | null;
    budget_job_id: string | null;
  }>(
    `SELECT al.grant_id, al.user_id, g.budget_job_id
       FROM action_allocations al
       JOIN actions a ON a.id = $1
       LEFT JOIN grants g ON g.id = al.grant_id
      WHERE al.exclusion_group = a.exclusion_group
        AND al.released_at IS NULL
        AND (al.action_id IS NULL OR al.action_id = a.id)
      GROUP BY al.grant_id, al.user_id, g.budget_job_id
      ORDER BY SUM(al.amount_micro_usd - al.spent_micro_usd) DESC
      LIMIT 1`,
    [actionId]
  );
  if (!row) return {};
  if (row.budget_job_id) {
    return { jobId: row.budget_job_id, grantId: row.grant_id ?? undefined };
  }
  if (row.user_id) return { userId: row.user_id };
  return {};
}
