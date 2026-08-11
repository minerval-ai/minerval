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
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";

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
 * Everything this grant's escrow is already good for: consumed + outstanding
 * allocation shares, NON-LEDGER metered spend on its job (management
 * conversations etc. — llm_usage minus what ledger runs already consumed as
 * shares, so a self-funded run isn't counted twice), and regrants out.
 * Headroom for any new commitment is budget minus this. One statement, so
 * the snapshot is consistent.
 */
export async function grantCommittedMicroUsd(
  grant: {
    id: string;
    budgetJobId: string;
  },
  tx?: TxQuery
): Promise<number> {
  const query = <T,>(text: string, params?: unknown[]) =>
    tx ? tx.query<T>(text, params) : rawQuery<T>(text, params);
  const [row] = await query<{
    shares: number;
    outstanding: number;
    nonledger: number;
    regrants: number;
  }>(
    `SELECT
       COALESCE((SELECT SUM(spent_micro_usd) FROM action_allocations
                  WHERE grant_id = $1), 0)::bigint AS shares,
       COALESCE((SELECT SUM(amount_micro_usd - spent_micro_usd)
                   FROM action_allocations
                  WHERE grant_id = $1 AND released_at IS NULL), 0)::bigint
         AS outstanding,
       -- Metered spend on this job that NO allocation share accounts for.
       --
       -- This used to subtract actions.metered_cost_micro_usd — the full cost
       -- of every ledger run — when what it means to subtract is what those
       -- runs consumed AS SHARES. The two differ by exactly the overage on
       -- runs that cost more than they were allocated, so the old form
       -- cancelled that overage out and left it in no term at all (23.57 owls
       -- on the General mandate's first epoch, invisible to its own escrow).
       -- Subtracting shares means anything spent and not shared counts here.
       GREATEST(0,
         COALESCE((SELECT SUM(cost_micro_usd) FROM llm_usage
                    WHERE job_id = $2), 0)
         - COALESCE((SELECT SUM(spent_micro_usd) FROM action_allocations
                      WHERE grant_id = $1), 0))::bigint AS nonledger,
       COALESCE((SELECT SUM(amount_micro_usd - refunded_micro_usd)
                   FROM regrants WHERE from_grant_id = $1), 0)::bigint
         AS regrants`,
    [grant.id, grant.budgetJobId]
  );
  return (
    Number(row?.shares ?? 0) +
    Number(row?.outstanding ?? 0) +
    Number(row?.nonledger ?? 0) +
    Number(row?.regrants ?? 0)
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
  // One transaction under a per-source advisory lock: concurrent regrants
  // from the same mandate serialize on the headroom check, and the regrant
  // row and the target's budget credit land (or roll back) together.
  return withTransaction(async (tx) => {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('regrant:' || $1, 0))`,
      [input.fromGrantId]
    );
    const [source] = await tx.query<{
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
        ok: false as const,
        code: "SOURCE_NOT_FOUND" as const,
        message: "Source mandate not found or not active",
      };
    }

    const amountMicro = owlsToMicroUsd(input.owls);
    const committed = await grantCommittedMicroUsd(
      { id: source.id, budgetJobId: source.budget_job_id },
      tx
    );
    const headroom = Number(source.budget_micro_usd) - committed;
    if (amountMicro > headroom) {
      return {
        ok: false as const,
        code: "INSUFFICIENT_BUDGET" as const,
        message:
          `Regranting ${input.owls} owls exceeds the mandate's uncommitted ` +
          `budget (${microUsdToOwls(Math.max(0, headroom))} owls free)`,
      };
    }

    // Credit the target's job first, guarded on the grant still being live:
    // zero rows means no regrant happens at all (no orphan row counting
    // against the source for money that never reached anyone).
    const credited = await tx.query<{ grant_id: string }>(
      `UPDATE budget_jobs j
          SET budget_micro_usd = j.budget_micro_usd + $2,
              status = CASE WHEN j.status = 'paused_budget' THEN 'running'
                            ELSE j.status END,
              updated_at = now()
         FROM grants g
        WHERE g.id = $1 AND j.id = g.budget_job_id
          AND g.status IN ('planning', 'pending_approval', 'active')
          AND j.status IN ('running', 'paused_budget')
        RETURNING g.id AS grant_id`,
      [input.toGrantId, amountMicro]
    );
    if (credited.length === 0) {
      return {
        ok: false as const,
        code: "TARGET_NOT_FOUND" as const,
        message: "Target mandate not found or no longer live",
      };
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [source.id, input.toGrantId, amountMicro, input.note ?? null]
    );
    return {
      ok: true as const,
      regrantId: row!.id,
      amountOwls: input.owls,
      toGrantId: input.toGrantId,
    };
  });
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
