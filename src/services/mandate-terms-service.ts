/**
 * A mandate's terms, and leaving one.
 *
 * The terms are the title and objective its funder approved by funding it.
 * The Grantmaker drafts them with the funder and changes them only when the
 * funder asks for it or agrees (amend_objective, in the management chat). A
 * platform mandate's amended terms are approved the way it was funded, so the
 * change is recorded for approval instead of applied. Every version is kept
 * in mandate_policy_versions (part 'terms').
 *
 * Everyone else who funded the mandate (people who contributed, mandates that
 * regranted to it) is told at once, and any of them may take back their
 * unspent share whenever they choose (withdrawFromMandate). A share is the
 * mandate's uncommitted money in proportion to what each funder still has in
 * it; a person's comes back to their balance, a mandate's to its escrow.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { grantCommittedMicroUsd } from "./regrant-service.js";
import { raiseToMandate } from "./mandate-inbox-service.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";

export type AmendResult =
  | { ok: true; status: "applied"; notified: number }
  | { ok: true; status: "awaiting_approval" }
  | { ok: false; message: string };

export async function amendObjective(input: {
  grantId: string;
  title?: string | null;
  objective?: string | null;
  note: string;
  author: string;
}): Promise<AmendResult> {
  const note = input.note.trim();
  if (!note) return { ok: false, message: "note is required: the other funders and the public read it." };
  const title = input.title?.trim() || null;
  const objective = input.objective?.trim() || null;
  if (!title && !objective) return { ok: false, message: "Give a new title, a new objective, or both." };
  const [g] = await rawQuery<{ id: string; is_platform: boolean; title: string | null; objective: string | null; budget_job_id: string; funder_user_id: string; status: string }>(
    `SELECT id, is_platform, mandate->>'title' AS title, mandate->>'objective' AS objective,
            budget_job_id, funder_user_id, status
       FROM grants WHERE id = $1`,
    [input.grantId]
  );
  if (!g) return { ok: false, message: "No such mandate." };
  if (g.status !== "active" && g.status !== "planning") return { ok: false, message: `The mandate is ${g.status}.` };
  const next = { title: title ?? g.title, objective: objective ?? g.objective };
  if (g.is_platform) {
    await rawQuery(
      `INSERT INTO mandate_policy_versions (grant_id, part, content, note, author, status)
       VALUES ($1, 'terms', $2::jsonb, $3, $4, 'awaiting_approval')`,
      [g.id, JSON.stringify(next), note, input.author]
    );
    return { ok: true, status: "awaiting_approval" };
  }
  await rawQuery(
    `UPDATE grants
        SET mandate = COALESCE(mandate, '{}'::jsonb) || jsonb_build_object('title', $2::text, 'objective', $3::text),
            updated_at = now()
      WHERE id = $1`,
    [g.id, next.title, next.objective]
  );
  await rawQuery(
    `INSERT INTO mandate_policy_versions (grant_id, part, content, note, author)
     VALUES ($1, 'terms', $2::jsonb, $3, $4)`,
    [g.id, JSON.stringify({ before: { title: g.title, objective: g.objective }, after: next }), note, input.author]
  );
  await rawQuery(
    `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, reason)
     VALUES ($1, 'grantmaker', 'terms', 'amended the objective', $2)`,
    [g.id, note]
  );
  // Tell every other funder at once. A regranting mandate hears it in its
  // inbox; people read it on the mandate's page and in their account.
  const regranters = await rawQuery<{ from_grant_id: string; share: number }>(
    `SELECT from_grant_id, SUM(amount_micro_usd - refunded_micro_usd)::bigint AS share
       FROM regrants WHERE to_grant_id = $1 GROUP BY from_grant_id`,
    [g.id]
  );
  for (const r of regranters) {
    await raiseToMandate({
      grantId: r.from_grant_id,
      kind: "notice",
      targetRef: g.id,
      source: `the mandate "${next.title ?? ""}"`,
      summary:
        `"${next.title ?? ""}", a mandate you regranted to, has a new objective, at its funder's request.\n` +
        `Before: ${g.objective ?? ""}\nNow: ${next.objective ?? ""}\nWhy: ${note}\n` +
        `withdraw_regrant takes your unspent share back to your escrow if the new objective no longer serves your mission.`,
      detail: { mandate_id: g.id },
    });
  }
  const [people] = await rawQuery<{ n: number }>(
    `SELECT count(DISTINCT user_id)::int AS n FROM owl_ledger
      WHERE job_id = $1 AND reason = 'escrow_hold' AND user_id <> $2`,
    [g.budget_job_id, g.funder_user_id]
  );
  return { ok: true, status: "applied", notified: regranters.length + Number(people?.n ?? 0) };
}

export type WithdrawResult =
  | { ok: true; withdrawnOwls: number }
  | { ok: false; message: string };

/**
 * Take a funder's unspent share out of a mandate: the uncommitted money in
 * proportion to what this funder still has in it, or less if asked. A
 * person's share returns to their balance, recorded against their escrow
 * hold so a later settlement counts what remains; a mandate's lowers its
 * regrant, which returns the money to its own escrow.
 */
export async function withdrawFromMandate(input: {
  grantId: string;
  funder: { userId: string } | { grantId: string };
  owls?: number | null;
}): Promise<WithdrawResult> {
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('mandate-allocator:' || $1, 0))`, [input.grantId]);
    const [g] = await tx.query<{ budget_job_id: string; escrow: number }>(
      `SELECT g.budget_job_id, j.budget_micro_usd AS escrow
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
      [input.grantId]
    );
    if (!g) return { ok: false, message: "No such mandate." } as const;
    const people = await tx.query<{ user_id: string; held: number }>(
      `SELECT user_id, -SUM(amount_micro_usd)::bigint AS held FROM owl_ledger
        WHERE job_id = $1 AND reason = 'escrow_hold' GROUP BY user_id`,
      [g.budget_job_id]
    );
    const mandates = await tx.query<{ from_grant_id: string; held: number }>(
      `SELECT from_grant_id, SUM(amount_micro_usd - refunded_micro_usd)::bigint AS held
         FROM regrants WHERE to_grant_id = $1 GROUP BY from_grant_id`,
      [input.grantId]
    );
    const total = [...people, ...mandates].reduce((s, r) => s + Math.max(0, Number(r.held)), 0);
    const mine =
      "userId" in input.funder
        ? Number(people.find((p) => p.user_id === (input.funder as { userId: string }).userId)?.held ?? 0)
        : Number(mandates.find((m) => m.from_grant_id === (input.funder as { grantId: string }).grantId)?.held ?? 0);
    if (!(mine > 0) || !(total > 0)) return { ok: false, message: "You have nothing in this mandate to withdraw." } as const;
    const committed = await grantCommittedMicroUsd({ id: input.grantId, budgetJobId: g.budget_job_id }, tx);
    const uncommitted = Math.max(0, Number(g.escrow) - committed);
    const share = Math.floor((uncommitted * mine) / total);
    const want = input.owls != null ? Math.min(share, owlsToMicroUsd(Number(input.owls))) : share;
    if (!(want > 0)) return { ok: false, message: "Nothing of your share is uncommitted right now." } as const;
    await tx.query(`UPDATE budget_jobs SET budget_micro_usd = budget_micro_usd - $2, updated_at = now() WHERE id = $1`, [g.budget_job_id, want]);
    if ("userId" in input.funder) {
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id) VALUES ($1, $2, 'escrow_hold', $3)`,
        [input.funder.userId, want, g.budget_job_id]
      );
    } else {
      // Lower the newest regrants first, keeping each at or above what it has returned.
      let left = want;
      const rows = await tx.query<{ id: string; room: number }>(
        `SELECT id, (amount_micro_usd - refunded_micro_usd)::bigint AS room FROM regrants
          WHERE to_grant_id = $1 AND from_grant_id = $2 ORDER BY created_at DESC FOR UPDATE`,
        [input.grantId, input.funder.grantId]
      );
      for (const r of rows) {
        if (left <= 0) break;
        const take = Math.min(left, Number(r.room));
        if (take <= 0) continue;
        await tx.query(`UPDATE regrants SET amount_micro_usd = amount_micro_usd - $2 WHERE id = $1`, [r.id, take]);
        left -= take;
      }
    }
    await tx.query(
      `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, owls_micro_usd, reason)
       VALUES ($1, 'funder', 'withdrawal', 'withdrew an unspent share', $2, $3)`,
      [input.grantId, want, "userId" in input.funder ? "a contributor withdrew" : `the mandate ${input.funder.grantId} withdrew`]
    );
    return { ok: true, withdrawnOwls: microUsdToOwls(want) } as const;
  });
}
