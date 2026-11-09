/**
 * Petitions: a running agent asking the mandate paying for it for more, and
 * getting the answer while it works.
 *
 * Routing. A petition goes to the mandate whose money the run is spending:
 * the mandate behind the allocations covering the run (a commission's money
 * keeps its payer as it moves down a chain of runs, so that is the mandate
 * that started the chain). A run a person paid for is answered by the
 * General mandate, which already covers the gap above a buyer's cap. The
 * chain of runs that led to the petitioner travels with it.
 *
 * Deciding. A program officer reads the mandate's pending petitions and
 * inbox under its operating policy and decides; what it can't settle, or
 * what is past its delegation limit, it escalates to the Grantmaker, which
 * decides in the same sitting when a run is waiting. One sitting at a time
 * per mandate (grants.officer_lease_until), after a short pause, so
 * petitions that arrive together are decided together.
 *
 * Applying. A grant of more budget to a run on the ledger is a commission
 * from the deciding mandate on the running row (the run settles it like any
 * other money it held); the waiting run's ceiling rises when it reads the
 * answer. A follow-up is commissioned once the petitioner's run has ended,
 * with its plan as the new pass's brief.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { getGeneralMandate } from "./allocation-policy-service.js";
import { commissionNodePass, placeCommission } from "./commission-service.js";
import { microUsdToOwls } from "./owl.js";
import type { RunFunding } from "../llm/usage-context.js";

export type PetitionKind = "more_budget" | "follow_up";
export type PetitionStatus = "pending" | "escalated" | "granted" | "refused" | "follow_up";

export interface ChainLink {
  action_id: string;
  kind: string;
  node_id: string | null;
  budget_micro_usd: number;
  spent_micro_usd?: number;
}

export interface PetitionRow {
  id: string;
  grant_id: string;
  kind: PetitionKind;
  asked_micro_usd: number;
  plan: string;
  why: string | null;
  if_refused: string | null;
  requester_agent: string | null;
  requester_action_id: string | null;
  requester_node_id: string | null;
  chain: ChainLink[];
  waiting: boolean;
  status: PetitionStatus;
  granted_micro_usd: number | null;
  decided_by: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

/** The chain of runs that led to `actionId`, root first. */
export async function runChain(actionId: string): Promise<ChainLink[]> {
  const chain: ChainLink[] = [];
  const seen = new Set<string>();
  let current: string | null = actionId;
  while (current && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    const [row]: Array<{ id: string; kind: string; claim_id: string | null; budget: number; parent: string | null }> =
      await rawQuery(
        `SELECT a.id, a.kind, a.claim_id,
                -- A row is reused pass after pass: its live allocations are
                -- the current pass's money.
                COALESCE((SELECT SUM(al.amount_micro_usd) FROM action_allocations al
                           WHERE al.exclusion_group = a.exclusion_group
                             AND (al.action_id IS NULL OR al.action_id = a.id)
                             AND al.released_at IS NULL), 0)::bigint AS budget,
                (SELECT al.parent_action_id FROM action_allocations al
                  WHERE al.exclusion_group = a.exclusion_group
                    AND (al.action_id IS NULL OR al.action_id = a.id)
                    AND al.released_at IS NULL
                    AND al.parent_action_id IS NOT NULL
                  ORDER BY al.created_at DESC LIMIT 1) AS parent
           FROM actions a WHERE a.id = $1`,
        [current]
      );
    if (!row) break;
    chain.unshift({ action_id: row.id, kind: row.kind, node_id: row.claim_id, budget_micro_usd: Number(row.budget) });
    current = row.parent;
  }
  return chain;
}

/** Which mandate decides a petition from a run funded this way, or null. */
export async function routePetition(funding: RunFunding | undefined | null): Promise<string | null> {
  if (!funding) return null;
  if (funding.actionId) {
    const [row] = await rawQuery<{ grant_id: string | null; user_id: string | null }>(
      `SELECT al.grant_id, al.user_id
         FROM action_allocations al
         JOIN actions a ON a.id = $1
        WHERE al.exclusion_group = a.exclusion_group
          AND (al.action_id IS NULL OR al.action_id = a.id)
          AND al.released_at IS NULL
        GROUP BY al.grant_id, al.user_id
        ORDER BY SUM(al.amount_micro_usd) DESC
        LIMIT 1`,
      [funding.actionId]
    );
    if (row?.grant_id) return row.grant_id;
    if (row?.user_id) return (await getGeneralMandate())?.grantId ?? null;
    return null;
  }
  if (funding.grantId) return funding.grantId;
  if (funding.userId) return (await getGeneralMandate())?.grantId ?? null;
  return null;
}

export async function filePetition(input: {
  grantId: string;
  kind: PetitionKind;
  askedMicroUsd: number;
  plan: string;
  why?: string | null;
  ifRefused?: string | null;
  requesterAgent?: string | null;
  requesterActionId?: string | null;
  requesterNodeId?: string | null;
  spentMicroUsd?: number;
  waiting: boolean;
}): Promise<string> {
  const chain = input.requesterActionId ? await runChain(input.requesterActionId) : [];
  if (chain.length > 0 && input.spentMicroUsd != null) {
    chain[chain.length - 1]!.spent_micro_usd = Math.round(input.spentMicroUsd);
  }
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO petitions
       (grant_id, kind, asked_micro_usd, plan, why, if_refused, requester_agent,
        requester_action_id, requester_node_id, chain, waiting)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     RETURNING id`,
    [
      input.grantId,
      input.kind,
      Math.round(input.askedMicroUsd),
      input.plan,
      input.why ?? null,
      input.ifRefused ?? null,
      input.requesterAgent ?? null,
      input.requesterActionId ?? null,
      input.requesterNodeId ?? null,
      JSON.stringify(chain),
      input.waiting,
    ]
  );
  return row!.id;
}

export async function getPetition(id: string): Promise<PetitionRow | null> {
  const [row] = await rawQuery<PetitionRow>(`SELECT * FROM petitions WHERE id = $1`, [id]);
  return row ?? null;
}

export type DecisionKind = "grant" | "refuse" | "follow_up";

/**
 * Record a decision on a petition and put its money where it goes. A grant
 * to a run on the ledger is a commission from the deciding mandate on the
 * running row, inside the mandate's rate and escrow like any of its
 * commissions; when that money isn't there, nothing is recorded and the
 * decider is told.
 */
export async function decidePetition(input: {
  petitionId: string;
  decision: DecisionKind;
  owlsMicroUsd?: number;
  reason: string;
  decidedBy: "officer" | "grantmaker";
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const p = await getPetition(input.petitionId);
  if (!p) return { ok: false, message: "No such petition." };
  if (p.status !== "pending" && p.status !== "escalated") {
    return { ok: false, message: `That petition was already decided (${p.status}).` };
  }
  const reason = input.reason.trim();
  if (!reason) return { ok: false, message: "reason is required: the petitioner and the public record read it." };
  let granted = 0;
  let status: PetitionStatus;
  if (input.decision === "refuse") {
    status = "refused";
  } else {
    // A grant is at most what was asked; a follow-up's budget is the decider's.
    const amount = input.owlsMicroUsd ?? Number(p.asked_micro_usd);
    granted = Math.round(input.decision === "grant" ? Math.min(amount, Number(p.asked_micro_usd)) : amount);
    if (!(granted > 0)) return { ok: false, message: "A grant or follow-up needs an amount above zero." };
    if (input.decision === "follow_up") {
      status = "follow_up";
    } else {
      status = "granted";
      if (p.kind === "follow_up") status = "follow_up";
      if (status === "granted" && p.requester_action_id) {
        const [row] = await rawQuery<{ exclusion_group: string; claim_id: string | null; status: string }>(
          `SELECT exclusion_group, claim_id, status FROM actions WHERE id = $1`,
          [p.requester_action_id]
        );
        if (row && row.status === "running") {
          const placed = await placeCommission({
            group: row.exclusion_group,
            actionId: p.requester_action_id,
            claimId: row.claim_id,
            payer: { kind: "grant", grantId: p.grant_id },
            budget: granted,
            commissionedBy: "petition",
            brief: p.plan,
            reason,
          });
          if (!placed.ok) return { ok: false, message: `The grant could not be placed: ${placed.message}` };
        } else {
          // The run has ended: what it asked for can only be a follow-up now.
          status = "follow_up";
        }
      }
    }
  }
  await rawQuery(
    `UPDATE petitions
        SET status = $2, granted_micro_usd = $3, decided_by = $4, reason = $5, decided_at = now()
      WHERE id = $1`,
    [p.id, status, granted || null, input.decidedBy, reason]
  );
  await rawQuery(
    `INSERT INTO mandate_decisions
       (grant_id, decided_by, item_kind, decision, target, owls_micro_usd, reason, petition_id, action_id)
     VALUES ($1, $2, 'petition', $3, $4, $5, $6, $7, $8)`,
    [p.grant_id, input.decidedBy, status, p.requester_node_id, granted || null, reason, p.id, p.requester_action_id]
  );
  if (status === "follow_up" && p.requester_action_id) {
    await commissionFollowUps(p.requester_action_id);
  } else if (status === "follow_up" && !p.requester_action_id) {
    await commissionFollowUp(p);
  }
  return {
    ok: true,
    message:
      status === "refused"
        ? "Refused."
        : status === "granted"
          ? `Granted ${microUsdToOwls(granted)} owls.`
          : `A follow-up pass of ${microUsdToOwls(granted)} owls, once the petitioner's run has ended.`,
  };
}

async function commissionFollowUp(p: PetitionRow): Promise<boolean> {
  if (!p.requester_node_id || !p.granted_micro_usd) return false;
  const res = await commissionNodePass({
    payer: { kind: "grant", grantId: p.grant_id },
    claimId: p.requester_node_id,
    budgetMicroUsd: Number(p.granted_micro_usd),
    brief:
      `A follow-up pass, funded because the last pass asked for more than it had: ${p.plan}`,
    reason: p.reason ?? undefined,
    commissionedBy: p.decided_by ?? "officer",
    message: { trigger: "mandate_plan", sender: { kind: "mandate" } },
  });
  if (res.ok && res.status === "commissioned") {
    await rawQuery(`UPDATE petitions SET follow_up_commissioned_at = now() WHERE id = $1`, [p.id]);
    return true;
  }
  return false;
}

/**
 * Commission the follow-ups granted to a run that has now ended (called when
 * a run settles, and swept by the scheduler for runs that ended otherwise).
 */
export async function commissionFollowUps(actionId: string): Promise<number> {
  const [running] = await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE id = $1`, [actionId]);
  if (running?.status === "running") return 0;
  const rows = await rawQuery<PetitionRow>(
    `SELECT * FROM petitions
      WHERE requester_action_id = $1 AND status = 'follow_up' AND follow_up_commissioned_at IS NULL`,
    [actionId]
  );
  let n = 0;
  for (const p of rows) if (await commissionFollowUp(p)) n++;
  return n;
}

/** Follow-ups whose runs ended without the settle hook seeing them. */
export async function sweepFollowUps(): Promise<number> {
  const rows = await rawQuery<{ requester_action_id: string }>(
    `SELECT DISTINCT p.requester_action_id
       FROM petitions p JOIN actions a ON a.id = p.requester_action_id
      WHERE p.status = 'follow_up' AND p.follow_up_commissioned_at IS NULL
        AND a.status <> 'running'
      LIMIT 100`
  );
  let n = 0;
  for (const r of rows) n += await commissionFollowUps(r.requester_action_id);
  return n;
}

/**
 * Take a mandate's inbox for one sitting, or report that someone else has
 * it. The lease expires on its own, so a crashed sitting frees the inbox.
 */
export async function takeInboxLease(grantId: string, minutes = 6): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE grants SET officer_lease_until = now() + make_interval(mins => $2)
      WHERE id = $1 AND (officer_lease_until IS NULL OR officer_lease_until < now())
      RETURNING id`,
    [grantId, minutes]
  );
  return rows.length > 0;
}

export async function releaseInboxLease(grantId: string): Promise<void> {
  await rawQuery(`UPDATE grants SET officer_lease_until = NULL WHERE id = $1`, [grantId]);
}

/** Whether a mandate has anything for its officers, or for its Grantmaker. */
export async function inboxWaiting(grantId: string): Promise<{ officer: number; grantmaker: number }> {
  const [row] = await rawQuery<{ officer: number; grantmaker: number }>(
    `SELECT
       (SELECT count(*) FROM petitions WHERE grant_id = $1 AND status = 'pending')
       + (SELECT count(*) FROM mandate_inbox WHERE grant_id = $1 AND handled_at IS NULL AND escalated_at IS NULL) AS officer,
       (SELECT count(*) FROM petitions WHERE grant_id = $1 AND status = 'escalated')
       + (SELECT count(*) FROM mandate_inbox WHERE grant_id = $1 AND handled_at IS NULL AND escalated_at IS NOT NULL) AS grantmaker`,
    [grantId]
  );
  return { officer: Number(row?.officer ?? 0), grantmaker: Number(row?.grantmaker ?? 0) };
}

/**
 * Wait for a petition's answer, working the mandate's inbox if no one else
 * is. `work` runs one sitting (officer, then Grantmaker for escalations); it
 * is injected so the agents stay out of this service.
 */
export async function awaitDecision(
  petitionId: string,
  work: (grantId: string) => Promise<void>,
  opts: { deadlineMs?: number; pollMs?: number } = {}
): Promise<PetitionRow | null> {
  const deadline = Date.now() + (opts.deadlineMs ?? loadConfig().petitionWaitSeconds * 1000);
  const poll = opts.pollMs ?? 1000;
  let p = await getPetition(petitionId);
  while (p && (p.status === "pending" || p.status === "escalated") && Date.now() < deadline) {
    if (await takeInboxLease(p.grant_id)) {
      try {
        await work(p.grant_id);
      } finally {
        await releaseInboxLease(p.grant_id);
      }
    } else {
      await new Promise((r) => setTimeout(r, poll));
    }
    p = await getPetition(petitionId);
  }
  return p;
}
