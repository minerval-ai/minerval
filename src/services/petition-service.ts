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
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
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
  /** The session the decision returns into, when the petitioner waits in one. */
  reply_to_session?: string | null;
  done_so_far?: string | null;
  held_until?: string | null;
  hold_reason?: string | null;
}

/**
 * The columns a petition is read with, named: a column the table gains (its
 * label, src/labels.ts) does not ride along into a brief or a reply.
 */
export const PETITION_COLUMNS = `id, grant_id, kind, asked_micro_usd, plan, why, if_refused, requester_agent,
  requester_action_id, requester_node_id, chain, waiting, status, granted_micro_usd, decided_by, reason,
  follow_up_commissioned_at, created_at, decided_at, reply_to_session, done_so_far,
  held_until::text AS held_until, hold_reason`;

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
  /** The session the decision returns into (session-service.ts). */
  replyToSession?: string | null;
  /** What the asking run has established so far and what is still open. */
  doneSoFar?: string | null;
}): Promise<string> {
  const chain = input.requesterActionId ? await runChain(input.requesterActionId) : [];
  if (chain.length > 0 && input.spentMicroUsd != null) {
    chain[chain.length - 1]!.spent_micro_usd = Math.round(input.spentMicroUsd);
  }
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO petitions
       (grant_id, kind, asked_micro_usd, plan, why, if_refused, requester_agent,
        requester_action_id, requester_node_id, chain, waiting, reply_to_session, done_so_far)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
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
      input.replyToSession ?? null,
      input.doneSoFar?.trim() || null,
    ]
  );
  return row!.id;
}

/**
 * The latest a held petition may be held to, when a run waits on it: its
 * session's deadline less a margin. The one limit on holding, because a
 * caller waits on the result (CLAUDE.md, "Constraints on agents"); the
 * officer's brief states it for each petition.
 */
export const HOLD_MARGIN_MINUTES = 60;

export async function latestHold(p: Pick<PetitionRow, "reply_to_session" | "waiting">): Promise<Date | null> {
  if (!p.waiting || !p.reply_to_session) return null;
  const [s] = await rawQuery<{ deadline: string | null; status: string }>(
    `SELECT deadline::text AS deadline, status FROM agent_sessions WHERE id = $1`,
    [p.reply_to_session]
  );
  if (!s || !["waiting", "ready", "running"].includes(s.status)) return null;
  // A running session has not paused yet: it waits at least the platform's
  // wait once it does.
  const deadline = s.deadline ? new Date(s.deadline) : new Date(Date.now() + loadSessionWaitMs());
  return new Date(deadline.getTime() - HOLD_MARGIN_MINUTES * 60_000);
}

function loadSessionWaitMs(): number {
  return Math.round(loadConfig().sessionWaitHours * 3_600_000);
}

/**
 * Hold a petition for perspective: until a time, or until named runs settle
 * (whichever comes first), with what it waits to learn. The asking run is
 * told at once, without being woken, so it knows the answer is coming later
 * and why. A hold for a waiting run must end before its session's deadline.
 */
export async function holdPetition(input: {
  petitionId: string;
  until: Date;
  refs: string[];
  criteria: string;
  decidedBy: "officer" | "grantmaker";
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const p = await getPetition(input.petitionId);
  if (!p) return { ok: false, message: "No such petition." };
  if (p.status !== "pending" && p.status !== "escalated") return { ok: false, message: `That petition is ${p.status}.` };
  const criteria = input.criteria.trim();
  if (!criteria) return { ok: false, message: "criteria is required: what the hold waits to learn, for the asker and the record." };
  const latest = await latestHold(p);
  if (latest && input.until.getTime() > latest.getTime()) {
    return {
      ok: false,
      message:
        `A run is waiting on this petition, and its session waits until ${latest.toISOString().slice(0, 16).replace("T", " ")} UTC ` +
        `(its deadline less ${HOLD_MARGIN_MINUTES} minutes), so a hold must end by then. Hold it for less, or decide it now.`,
    };
  }
  await rawQuery(
    `UPDATE petitions SET status = 'held', held_until = $2, hold_refs = $3::jsonb, hold_reason = $4, decided_by = $5 WHERE id = $1`,
    [p.id, input.until.toISOString(), JSON.stringify(input.refs), criteria, input.decidedBy]
  );
  await rawQuery(
    `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, target, reason, petition_id, action_id)
     VALUES ($1, $2, 'petition', 'held', $3, $4, $5, $6)`,
    [p.grant_id, input.decidedBy, p.requester_node_id, criteria, p.id, p.requester_action_id]
  );
  if (p.reply_to_session) {
    const { deliverReply } = await import("./session-service.js");
    await deliverReply({
      sessionId: p.reply_to_session,
      kind: "petition",
      // Not the petition's own ref: a hold is not its answer.
      ref: `${p.id}:held`,
      text:
        `The mandate is holding your petition until ${input.until.toISOString().slice(0, 16).replace("T", " ")} UTC at the latest` +
        `${input.refs.length ? `, or until ${input.refs.length} related run(s) report` : ""}, to decide it with more in front of it: ` +
        `${criteria}. Carry on with what you can do; the decision will come to you.`,
      fallback: null,
      wake: false,
    });
  }
  return { ok: true, message: `Held until ${input.until.toISOString().slice(0, 16).replace("T", " ")} UTC${input.refs.length ? ` or until the named runs settle` : ""}.` };
}

/**
 * Return held petitions and items whose time has come (or whose named runs
 * have all settled) to the officers, with what they were held for. Never
 * refused by time: a held decision comes back to be decided. Returns the
 * mandates whose inbox has something back.
 */
export async function releaseHolds(): Promise<string[]> {
  const settled = `NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(hold_refs) r
                     JOIN actions a ON a.id::text = r WHERE a.status IN ('open', 'running'))`;
  // A hold comes back to whoever placed it: the Grantmaker's to its session
  // (as an escalation, which wakes it), an officer's to the officers.
  const petitions = await rawQuery<{ id: string; grant_id: string; status: string; requester_node_id: string | null; hold_reason: string | null }>(
    `UPDATE petitions
        SET status = CASE WHEN decided_by = 'grantmaker' THEN 'escalated' ELSE 'pending' END,
            decided_by = NULL,
            reason = 'Held until ' || to_char(held_until AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC to learn: ' ||
                     COALESCE(hold_reason, '') || '. It is back for a decision.'
      WHERE status = 'held'
        AND (held_until <= now() OR (jsonb_array_length(hold_refs) > 0 AND ${settled}))
      RETURNING id, grant_id, status, requester_node_id, hold_reason`
  );
  const { recordEvent } = await import("./event-service.js");
  for (const p of petitions.filter((x) => x.status === "escalated")) {
    await recordEvent({
      kind: "escalated",
      grantId: p.grant_id,
      nodeId: p.requester_node_id,
      refs: { petition: p.id },
      summary: `A petition you held is back for a decision: ${p.hold_reason ?? ""}`,
    });
  }
  const items = await rawQuery<{ grant_id: string }>(
    `UPDATE mandate_inbox
        SET held_until = NULL,
            summary = summary || E'\n(Held to learn: ' || COALESCE(hold_reason, '') || '. Back for a decision.)'
      WHERE handled_at IS NULL AND held_until IS NOT NULL
        AND (held_until <= now() OR (jsonb_array_length(hold_refs) > 0 AND ${settled}))
      RETURNING grant_id`
  );
  return [...new Set([...petitions, ...items].map((r) => r.grant_id))];
}

export async function getPetition(id: string): Promise<PetitionRow | null> {
  const [row] = await rawQuery<PetitionRow>(`SELECT ${PETITION_COLUMNS} FROM petitions WHERE id = $1`, [id]);
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
  // A petitioner whose session paused to wait (session-service.ts): its run
  // has ended, so a grant funds the pass that resumes it instead of the row.
  const { sessionStatus, deliverReply } = await import("./session-service.js");
  const asker = await sessionStatus(p.reply_to_session ?? null);
  const askerPaused = asker === "waiting" || asker === "ready";
  let granted = 0;
  let placedOnRun = false;
  let status: PetitionStatus;
  if (input.decision === "refuse") {
    status = "refused";
  } else {
    // A grant is at most what was asked; a follow-up's budget is the decider's.
    const amount = input.owlsMicroUsd ?? Number(p.asked_micro_usd);
    granted = Math.round(input.decision === "grant" ? Math.min(amount, Number(p.asked_micro_usd)) : amount);
    if (!(granted > 0)) return { ok: false, message: "A grant or follow-up needs an amount above zero." };
    // The reserve is checked here, when the decision is made, since a grant
    // may be placed later (on a paused session's resumption, or as a
    // follow-up): an officer grants only from money outside it.
    const { paceRoom, paceRefusal } = await import("./pace-service.js");
    const room = await paceRoom(p.grant_id, input.decidedBy === "grantmaker" ? "grantmaker" : "delegated");
    if (!room || granted > room.availableMicroUsd) {
      return {
        ok: false,
        message: room ? `Nothing was decided. ${paceRefusal(room, granted)}` : "The mandate is not active.",
      };
    }
    if (input.decision === "follow_up") {
      status = "follow_up";
    } else {
      status = "granted";
      if (p.kind === "follow_up") status = "follow_up";
      if (status === "granted" && askerPaused) {
        // Placed on the resuming pass when the session resumes.
      } else if (status === "granted" && p.requester_action_id) {
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
            committer: "grantmaker",
            brief: p.plan,
            reason,
          });
          if (!placed.ok) return { ok: false, message: `The grant could not be placed: ${placed.message}` };
          placedOnRun = true;
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
  {
    const { recordEvent } = await import("./event-service.js");
    await recordEvent({
      kind: "petition_decided",
      grantId: p.grant_id,
      nodeId: p.requester_node_id,
      actionId: p.requester_action_id,
      refs: { petition: p.id, session: p.reply_to_session },
      summary: `A ${p.kind} petition from ${p.requester_agent ?? "an agent"} was ${status === "refused" ? "refused" : status === "granted" ? `granted ${microUsdToOwls(granted)} owls` : `funded as a ${microUsdToOwls(granted)}-owl follow-up`} by the ${input.decidedBy}: ${reason}`,
      payload: { status, granted_micro_usd: granted, decided_by: input.decidedBy },
    });
  }
  // The decision returns into the session that asked: shown to its run if it
  // is still working (a grant raising its ceiling then), or resuming it if
  // it paused (a grant funding that pass).
  if (p.reply_to_session) {
    const who = input.decidedBy === "grantmaker" ? "Grantmaker" : "program officer";
    const owl = (m: number) => microUsdToOwls(m);
    const text =
      status === "refused"
        ? `Refused by the mandate's ${who}. Reason: ${reason}. Work with the budget you have and record what you ` +
          `could and couldn't establish. The refusal is about money, not your conclusion.`
        : status === "granted"
          ? `Granted by the mandate's ${who}: ${owl(granted)} of ${owl(Number(p.asked_micro_usd))} owls. Reason: ${reason}. ` +
            (askerPaused ? `It is added to the budget of the pass that resumes you.` : `Your budget is raised by ${owl(granted)} owls.`)
          : `The mandate's ${who} funded a follow-up pass of ${owl(granted)} owls with your plan as its brief, ` +
            `to run after this one. Reason: ${reason}. Record what you have now; the follow-up starts from it.`;
    const routed = await deliverReply({
      sessionId: p.reply_to_session,
      kind: "petition",
      ref: p.id,
      text,
      fallback: null,
      creditMicroUsd: placedOnRun && asker === "running" ? granted : undefined,
      grant: status === "granted" && askerPaused ? { grantId: p.grant_id, microUsd: granted } : null,
    });
    if (routed !== "session" && status === "granted" && askerPaused) {
      // The session went away between looking and delivering: the money
      // becomes a follow-up pass instead.
      status = "follow_up";
      await rawQuery(`UPDATE petitions SET status = 'follow_up' WHERE id = $1`, [p.id]);
    }
  }
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
    `SELECT ${PETITION_COLUMNS} FROM petitions
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
       + (SELECT count(*) FROM mandate_inbox WHERE grant_id = $1 AND handled_at IS NULL AND escalated_at IS NULL
                                              AND held_until IS NULL) AS officer,
       (SELECT count(*) FROM petitions WHERE grant_id = $1 AND status = 'escalated')
       + (SELECT count(*) FROM mandate_inbox WHERE grant_id = $1 AND handled_at IS NULL AND escalated_at IS NOT NULL) AS grantmaker`,
    [grantId]
  );
  return { officer: Number(row?.officer ?? 0), grantmaker: Number(row?.grantmaker ?? 0) };
}

