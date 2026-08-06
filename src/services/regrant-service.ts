/**
 * Regrants — grants funding grants, as peers.
 *
 * All grants live on the same level: any mandate can be funded separately
 * (user contributions) AND put its own budget behind other mandates. That
 * is how a mandate carves ingestion out to another Grantmaker, or splits
 * basic research from applications — not by nesting sub-grants, but by
 * funding a sibling it doesn't control.
 *
 * The mechanics are escrow-to-escrow: a regrant increases the target's
 * budget job and counts against the source's committed money (the same
 * headroom that bounds its allocations), and when the target settles with
 * unspent budget the source's share returns to its escrow, pro rata with
 * the target's user contributors (budget-job-service.refundUnspentBudget).
 * A regrant is money, not command: it buys the target mandate more reach
 * and gives the source no say over the target's judgment.
 */
import { rawQuery } from "../db/client.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { getJobSpentMicroUsd } from "./budget-job-service.js";
import { grantAllocationExposureMicroUsd } from "./allocation-service.js";

/** Total this grant has regranted to others (net of returned shares). */
export async function regrantsOutMicroUsd(grantId: string): Promise<number> {
  const [row] = await rawQuery<{ total: number }>(
    `SELECT COALESCE(SUM(amount_micro_usd - refunded_micro_usd), 0)::bigint
       AS total
       FROM regrants WHERE from_grant_id = $1`,
    [grantId]
  );
  return Number(row?.total ?? 0);
}

/**
 * Everything this grant's escrow is already good for: metered spend on its
 * own job, consumed + outstanding allocation shares, and regrants out.
 * Headroom for any new commitment is budget minus this.
 */
export async function grantCommittedMicroUsd(grant: {
  id: string;
  budgetJobId: string;
}): Promise<number> {
  const [jobSpent, exposure, regranted] = await Promise.all([
    getJobSpentMicroUsd(grant.budgetJobId),
    grantAllocationExposureMicroUsd(grant.id),
    regrantsOutMicroUsd(grant.id),
  ]);
  return (
    jobSpent +
    exposure.spentMicroUsd +
    exposure.outstandingMicroUsd +
    regranted
  );
}

export interface RegrantEdge {
  grant_id: string;
  title: string;
  owls: number;
  note: string | null;
}

/** The mandates funding this one, and the ones it funds — for dashboards. */
export async function regrantEdges(grantId: string): Promise<{
  fundedBy: RegrantEdge[];
  fundsOut: RegrantEdge[];
}> {
  const rows = await rawQuery<{
    direction: string;
    grant_id: string;
    title: string;
    amount: number;
    note: string | null;
  }>(
    `SELECT 'in' AS direction, g.id AS grant_id,
            COALESCE(g.mandate->>'title', g.name) AS title,
            SUM(r.amount_micro_usd)::bigint AS amount,
            MIN(r.note) AS note
       FROM regrants r JOIN grants g ON g.id = r.from_grant_id
      WHERE r.to_grant_id = $1
      GROUP BY g.id, g.mandate->>'title', g.name
     UNION ALL
     SELECT 'out', g.id, COALESCE(g.mandate->>'title', g.name),
            SUM(r.amount_micro_usd)::bigint, MIN(r.note)
       FROM regrants r JOIN grants g ON g.id = r.to_grant_id
      WHERE r.from_grant_id = $1
      GROUP BY g.id, g.mandate->>'title', g.name`,
    [grantId]
  );
  const edge = (r: (typeof rows)[number]): RegrantEdge => ({
    grant_id: r.grant_id,
    title: r.title,
    owls: microUsdToOwls(Number(r.amount)),
    note: r.note,
  });
  return {
    fundedBy: rows.filter((r) => r.direction === "in").map(edge),
    fundsOut: rows.filter((r) => r.direction === "out").map(edge),
  };
}

export type RegrantResult =
  | { ok: true; regrantId: string; amountOwls: number; toGrantId: string }
  | {
      ok: false;
      code:
        | "SOURCE_NOT_FOUND"
        | "TARGET_NOT_FOUND"
        | "SELF_REGRANT"
        | "INSUFFICIENT_BUDGET"
        | "BAD_AMOUNT";
      message: string;
    };

/**
 * Move escrowed budget from one grant to another. The source must be
 * active with headroom; the target must be live (planning through active —
 * regranting into a mandate still being designed is the normal way to
 * spawn one). The target's budget job grows and resumes if it was paused
 * at its floor.
 */
export async function createRegrant(input: {
  fromGrantId: string;
  toGrantId: string;
  owls: number;
  note?: string;
}): Promise<RegrantResult> {
  if (!(input.owls > 0)) {
    return {
      ok: false,
      code: "BAD_AMOUNT",
      message: "Regrant a positive number of owls",
    };
  }
  if (input.fromGrantId === input.toGrantId) {
    return {
      ok: false,
      code: "SELF_REGRANT",
      message: "A mandate cannot regrant to itself",
    };
  }
  const [source] = await rawQuery<{
    id: string;
    budget_job_id: string;
    budget_micro_usd: number;
  }>(
    `SELECT g.id, g.budget_job_id, j.budget_micro_usd
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1 AND g.status = 'active'`,
    [input.fromGrantId]
  );
  if (!source) {
    return {
      ok: false,
      code: "SOURCE_NOT_FOUND",
      message: "Source mandate not found or not active",
    };
  }
  const [target] = await rawQuery<{ id: string; budget_job_id: string }>(
    `SELECT id, budget_job_id FROM grants
      WHERE id = $1 AND status IN ('planning', 'pending_approval', 'active')`,
    [input.toGrantId]
  );
  if (!target) {
    return {
      ok: false,
      code: "TARGET_NOT_FOUND",
      message: "Target mandate not found or no longer live",
    };
  }

  const amountMicro = owlsToMicroUsd(input.owls);
  const committed = await grantCommittedMicroUsd({
    id: source.id,
    budgetJobId: source.budget_job_id,
  });
  const headroom = Number(source.budget_micro_usd) - committed;
  if (amountMicro > headroom) {
    return {
      ok: false,
      code: "INSUFFICIENT_BUDGET",
      message:
        `Regranting ${input.owls} owls exceeds the mandate's uncommitted ` +
        `budget (${microUsdToOwls(Math.max(0, headroom))} owls free)`,
    };
  }

  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [source.id, target.id, amountMicro, input.note ?? null]
  );
  await rawQuery(
    `UPDATE budget_jobs
        SET budget_micro_usd = budget_micro_usd + $2,
            status = CASE WHEN status = 'paused_budget' THEN 'running'
                          ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [target.budget_job_id, amountMicro]
  );
  return {
    ok: true,
    regrantId: row!.id,
    amountOwls: input.owls,
    toGrantId: target.id,
  };
}

export type SpawnMandateResult =
  | { ok: true; grantId: string; regrantId: string }
  | Extract<RegrantResult, { ok: false }>;

/**
 * Spawn a NEW mandate funded by an existing one: a fresh grant in
 * 'planning', with its own budget job and its own Grantmaker (the
 * planning action the ledger opens for it), seeded entirely by a regrant.
 * This is how a mandate puts another agent in charge of a slice of its
 * work — the new mandate is a peer, separately fundable by anyone,
 * not a sub-unit.
 */
export async function spawnFundedMandate(input: {
  fromGrantId: string;
  title: string;
  objective: string;
  owls: number;
  note?: string;
}): Promise<SpawnMandateResult> {
  const [source] = await rawQuery<{ id: string; funder_user_id: string }>(
    `SELECT id, funder_user_id FROM grants WHERE id = $1 AND status = 'active'`,
    [input.fromGrantId]
  );
  if (!source) {
    return {
      ok: false,
      code: "SOURCE_NOT_FOUND",
      message: "Source mandate not found or not active",
    };
  }
  // The new grant starts with an EMPTY budget job; the regrant below is
  // its entire initial funding, so a failed regrant leaves nothing live.
  const [job] = await rawQuery<{ id: string }>(
    `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status)
     VALUES ($1, 'grant', 0, 'running')
     RETURNING id`,
    [source.funder_user_id]
  );
  const mandate = {
    title: input.title,
    objective: input.objective,
    scope_claim_id: null,
    scope_query: null,
    plan: null,
    expected_cost_owls: input.owls,
    notes: input.note ?? null,
  };
  const [grant] = await rawQuery<{ id: string }>(
    `INSERT INTO grants
       (funder_user_id, budget_job_id, name, policy, status, mandate)
     VALUES ($1, $2, $3, 'agent', 'planning', $4::jsonb)
     RETURNING id`,
    [source.funder_user_id, job!.id, input.title, JSON.stringify(mandate)]
  );
  const regranted = await createRegrant({
    fromGrantId: source.id,
    toGrantId: grant!.id,
    owls: input.owls,
    note: input.note,
  });
  if (!regranted.ok) {
    await rawQuery(`DELETE FROM grants WHERE id = $1`, [grant!.id]);
    await rawQuery(`DELETE FROM budget_jobs WHERE id = $1`, [job!.id]);
    return regranted;
  }
  return { ok: true, grantId: grant!.id, regrantId: regranted.regrantId };
}
