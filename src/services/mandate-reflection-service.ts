/**
 * What a mandate's money did since its Grantmaker's last review, for the
 * review pass to read back and learn from (mandate-review.ts). The review is
 * where the Grantmaker fixes causes rather than cases: budgets set wrong for
 * a kind of work, standing instructions its officers read differently than
 * it meant, a lookout that surfaces too much or misses what matters.
 *
 * Every figure is from the ledger and the decision log; nothing here judges.
 */
import { rawQuery } from "../db/client.js";
import { microUsdToOwls } from "./owl.js";

const owls = (micro: number | string | null | undefined) => microUsdToOwls(Number(micro ?? 0));

export async function reflectionSections(grantId: string, sinceIso: string): Promise<string> {
  const [money] = await rawQuery<{ runs: number; spent: number; budget: number; heavy: number }>(
    `SELECT count(*)::int AS runs,
            COALESCE(SUM(spent_micro_usd), 0)::bigint AS spent,
            COALESCE(SUM(amount_micro_usd), 0)::bigint AS budget,
            count(*) FILTER (WHERE spent_micro_usd >= 0.9 * amount_micro_usd)::int AS heavy
       FROM minerval_whole.allocation_money
      WHERE grant_id = $1 AND commissioned_by IS NOT NULL AND released_at IS NOT NULL
        AND released_at >= $2::timestamptz`,
    [grantId, sinceIso]
  );
  const byKind = await rawQuery<{ kind: string; runs: number; spent: number; budget: number }>(
    `SELECT a.kind, count(*)::int AS runs, SUM(al.spent_micro_usd)::bigint AS spent, SUM(al.amount_micro_usd)::bigint AS budget
       FROM minerval_whole.allocation_money al JOIN actions a ON a.id = al.action_id
      WHERE al.grant_id = $1 AND al.commissioned_by IS NOT NULL AND al.released_at IS NOT NULL
        AND al.released_at >= $2::timestamptz
      GROUP BY a.kind ORDER BY spent DESC`,
    [grantId, sinceIso]
  );
  const [outcomes] = await rawQuery<{ changed: number; stood: number }>(
    `WITH commissioned AS (
       SELECT DISTINCT a.claim_id FROM minerval_whole.allocation_money al JOIN actions a ON a.id = al.action_id
        WHERE al.grant_id = $1 AND a.claim_id IS NOT NULL AND al.created_at >= $2::timestamptz
     ),
     passes AS (
       SELECT x.claim_id, x.status,
              (SELECT p.status FROM assessments p WHERE p.claim_id = x.claim_id AND p.assessed_at < x.assessed_at
                ORDER BY p.assessed_at DESC LIMIT 1) AS prev
         FROM assessments x JOIN commissioned c ON c.claim_id = x.claim_id
        WHERE x.assessed_at >= $2::timestamptz
     )
     SELECT count(*) FILTER (WHERE prev IS DISTINCT FROM status)::int AS changed,
            count(*) FILTER (WHERE prev IS NOT DISTINCT FROM status)::int AS stood
       FROM passes`,
    [grantId, sinceIso]
  );
  const petitions = await rawQuery<{ requester_agent: string | null; kind: string; status: string; n: number; asked: number; granted: number }>(
    `SELECT requester_agent, kind, status, count(*)::int AS n,
            SUM(asked_micro_usd)::bigint AS asked, COALESCE(SUM(granted_micro_usd), 0)::bigint AS granted
       FROM petitions WHERE grant_id = $1 AND created_at >= $2::timestamptz
      GROUP BY requester_agent, kind, status ORDER BY n DESC`,
    [grantId, sinceIso]
  );
  const short = await rawQuery<{ action_id: string; claim_id: string | null; kind: string; spent: number }>(
    `SELECT a.id AS action_id, a.claim_id, a.kind, al.spent_micro_usd AS spent
       FROM minerval_whole.allocation_money al JOIN actions a ON a.id = al.action_id
      WHERE al.grant_id = $1 AND al.commissioned_by IS NOT NULL AND al.released_at >= $2::timestamptz
        AND al.spent_micro_usd >= al.amount_micro_usd
        AND NOT EXISTS (SELECT 1 FROM petitions p WHERE p.requester_action_id = a.id AND p.created_at >= $2::timestamptz)
      ORDER BY al.released_at DESC LIMIT 10`,
    [grantId, sinceIso]
  );
  const decisions = await rawQuery<{ decided_by: string; item_kind: string; n: number }>(
    `SELECT decided_by, item_kind, count(*)::int AS n FROM mandate_decisions
      WHERE grant_id = $1 AND created_at >= $2::timestamptz
      GROUP BY decided_by, item_kind ORDER BY n DESC`,
    [grantId, sinceIso]
  );
  const [deciding] = await rawQuery<{ deciding: number; total: number }>(
    `SELECT COALESCE(SUM(spent_micro_usd) FILTER (WHERE exclusion_group LIKE 'officer:%' OR exclusion_group LIKE 'escalation:%'), 0)::bigint AS deciding,
            COALESCE(SUM(spent_micro_usd), 0)::bigint AS total
       FROM minerval_whole.allocation_money WHERE grant_id = $1 AND created_at >= $2::timestamptz`,
    [grantId, sinceIso]
  );
  const [waiting] = await rawQuery<{ n: number; oldest: string | null }>(
    `SELECT count(*)::int AS n, MIN(m.created_at)::text AS oldest
       FROM node_messages m
      WHERE m.read_at IS NULL AND m.trigger <> 'message_reply'
        AND m.node_id IN (SELECT DISTINCT a.claim_id FROM minerval_whole.allocation_money al JOIN actions a ON a.id = al.action_id
                           WHERE al.grant_id = $1 AND a.claim_id IS NOT NULL)`,
    [grantId]
  );
  const answers = await rawQuery<{ outcome: string; n: number }>(
    `SELECT m.outcome, count(*)::int AS n FROM node_messages m
      WHERE m.answered_at >= $2::timestamptz
        AND m.node_id IN (SELECT DISTINCT a.claim_id FROM minerval_whole.allocation_money al JOIN actions a ON a.id = al.action_id
                           WHERE al.grant_id = $1 AND a.claim_id IS NOT NULL)
      GROUP BY m.outcome`,
    [grantId, sinceIso]
  );
  const lookouts = await rawQuery<{ title: string; raised: number; commissioned: number }>(
    `SELECT l.title,
            (SELECT count(*) FROM mandate_inbox i WHERE i.grant_id = $1 AND i.source = 'the lookout "' || l.title || '"'
               AND i.created_at >= $2::timestamptz)::int AS raised,
            (SELECT count(*) FROM minerval_whole.allocation_money al WHERE al.grant_id = $1 AND al.commissioned_by = 'lookout'
               AND al.created_at >= $2::timestamptz)::int AS commissioned
       FROM lookouts l WHERE l.grant_id = $1 AND l.status = 'active'`,
    [grantId, sinceIso]
  );

  const used = Number(money?.budget ?? 0) > 0 ? Math.round((100 * Number(money!.spent)) / Number(money!.budget)) : 0;
  const share = Number(deciding?.total ?? 0) > 0 ? Math.round((100 * Number(deciding!.deciding)) / Number(deciding!.total)) : 0;
  const petitionTotals = petitions.reduce(
    (t, p) => {
      t.n += p.n;
      if (p.status === "granted") (t.granted += p.n), (t.grantedOwls += Number(p.granted));
      if (p.status === "refused") t.refused += p.n;
      if (p.status === "follow_up") t.follow += p.n;
      if (p.status === "escalated") t.escalated += p.n;
      return t;
    },
    { n: 0, granted: 0, grantedOwls: 0, refused: 0, follow: 0, escalated: 0 }
  );
  return [
    `## What your money did since your last review (${sinceIso.slice(0, 10)})\n\n` +
      (Number(money?.runs ?? 0) === 0
        ? "No commissioned run has settled since then."
        : `Spent ${owls(money!.spent)} owls over ${money!.runs} runs, using ${used}% of their budgets; ` +
          `${money!.heavy} used more than 90%. By kind: ` +
          byKind.map((k) => `${k.kind} · ${k.runs} · ${owls(k.spent)} of ${owls(k.budget)} owls`).join("; ") +
          `. Outcomes on the nodes you paid for: ${outcomes?.changed ?? 0} assessments changed status, ${outcomes?.stood ?? 0} stood.`),
    `## Petitions\n\n` +
      (petitionTotals.n === 0
        ? "None since then."
        : `${petitionTotals.n} received: ${petitionTotals.granted} granted (${owls(petitionTotals.grantedOwls)} owls), ` +
          `${petitionTotals.refused} refused, ${petitionTotals.follow} follow-ups, ${petitionTotals.escalated} still escalated. ` +
          `Asked most: ` +
          petitions
            .slice(0, 5)
            .map((p) => `${p.kind} from ${p.requester_agent ?? "agents"} (${p.status}) ×${p.n}, asking ${owls(p.asked)} owls`)
            .join("; ") +
          "."),
    `## Runs that ran short without asking\n\n` +
      (short.length === 0
        ? "None."
        : `${short.length} run(s) spent their whole budget and did not petition: ` +
          short.map((r) => `${r.kind}${r.claim_id ? ` on ${r.claim_id}` : ""} (${owls(r.spent)} owls)`).join("; ") +
          "."),
    `## Your program officers\n\n` +
      (decisions.length === 0
        ? "No decisions logged since then."
        : decisions.map((d) => `${d.decided_by} · ${d.item_kind} ×${d.n}`).join("; ") +
          `. Deciding cost ${share}% of spend.`),
    `## Messages waiting in your territory\n\n` +
      `${waiting?.n ?? 0} open message(s) on nodes you have paid for` +
      (waiting?.oldest ? `, the oldest from ${String(waiting.oldest).slice(0, 10)}` : "") +
      `. Answers since your last review: ` +
      (answers.length === 0 ? "none" : answers.map((a) => `${a.outcome} ${a.n}`).join(", ")) +
      ".",
    `## Your lookouts\n\n` +
      (lookouts.length === 0
        ? "None active."
        : lookouts.map((l) => `"${l.title}": raised ${l.raised}, commissioned ${l.commissioned}`).join("; ") + "."),
  ].join("\n\n");
}
