/**
 * Deep decomposition as a mandate (docs/allocation.md, "Deep decomposition:
 * a mandate on one claim").
 *
 * "Decompose this claim, x owls deep" used to be a budget job a worker
 * walked mechanically: the claim's subtree, stub by stub, off the ledger,
 * never the claim itself once assessed and never what sits beside it. It is
 * now a mandate like any other, funded and started in one step: an escrow
 * of x owls, a Grantmaker that plans the work, and ledger rows that carry
 * it out. The plan always begins with a fresh pass on the claim itself;
 * after that the Grantmaker judges what bears on it (its subclaims, what it
 * rests on, what rests on it, closely linked claims) and buys the most
 * consequential first.
 *
 * Its words are fixed: the objective says what was bought and nothing the
 * funder wrote, so the mandate is neutral by construction. The funder
 * shows on its page as "a reader". Paying is the approval: the plan runs
 * when drafted, with no approval step.
 *
 * The Grantmaker's own passes (planning, and the reviews that pick up the
 * subclaims each pass mints) share a tenth of the budget between them
 * (GRANTMAKER_SHARE), each pass told what it has. When the share is spent
 * and the plan is done, the mandate completes and the rest refunds.
 */
import { rawQuery } from "../db/client.js";
import { owlsToMicroUsd } from "./owl.js";
import { withOwlBalanceLock } from "./owl-ledger-service.js";

/** The fewest owls a decomposition is funded with: below this, the
 *  Grantmaker's share could not pay for a pass that plans anything. */
export const MIN_DECOMPOSITION_OWLS = 5;

/** The part of the budget the mandate's Grantmaker passes may spend. */
export const GRANTMAKER_SHARE = 0.1;

/**
 * What a decomposition's Grantmaker pass is told about its share, so the
 * limit it works under is stated to it with the reason (CLAUDE.md, the
 * constraints on agents).
 */
export function grantmakerShareNote(shareOwls: number, leftOwls: number, pass: "planning" | "review"): string {
  const left = Math.max(0, Math.round(leftOwls * 1000) / 1000);
  return (
    `\n\n## Your share of this budget\n\n` +
    `This mandate is a decomposition a reader bought on one claim. Your own passes ` +
    `(this planning, and the reviews that pick up what each pass finds) share ` +
    `${shareOwls} owls, a tenth of its budget, so that the rest goes to the work itself. ` +
    `${left} owls of that share are left` +
    (pass === "planning" ? `; this planning pass may use up to half of the share. ` : `. `) +
    `No review runs once the share is spent, and when its plan's work is done the ` +
    `mandate completes and refunds the rest. Plan so the work you put in now carries ` +
    `the mandate; the plan always opens with a fresh pass on the claim, added if you leave it out.`
  );
}

export type ClaimMandateResult =
  | { ok: true; grantId: string; budgetJobId: string }
  | {
      ok: false;
      code: "CLAIM_NOT_FOUND" | "INSUFFICIENT_OWLS" | "BUDGET_TOO_SMALL";
      message: string;
    };

/** The mandate's fixed words, from the claim it is about. */
export function claimMandateText(claimText: string, budgetOwls: number) {
  const short = claimText.length > 160 ? `${claimText.slice(0, 157)}...` : claimText;
  return {
    title: `Decompose and assess: "${short}"`,
    objective:
      `Take this claim apart and assess what it turns on, within ${budgetOwls} owls. ` +
      "First a fresh pass on the claim itself. Then the claims that bear on it, most " +
      "consequential first: its subclaims (released from the stubs the graph's own " +
      "budget leaves undecomposed), the claims it rests on and those that rest on it, " +
      "and closely linked claims where they change how it should be read. The work " +
      "buys attention, never a conclusion.",
  };
}

/**
 * Fund and start a decomposition mandate on one claim. The escrow happens
 * here; the planning pass is opened by the next ledger sweep, funded from
 * the escrow like any mandate's.
 */
export async function createClaimMandate(input: {
  userId: string;
  claimId: string;
  budgetOwls: number;
}): Promise<ClaimMandateResult> {
  if (!(input.budgetOwls >= MIN_DECOMPOSITION_OWLS)) {
    return {
      ok: false,
      code: "BUDGET_TOO_SMALL",
      message: `A decomposition is funded with at least ${MIN_DECOMPOSITION_OWLS} owls`,
    };
  }
  const [claim] = await rawQuery<{ id: string; text: string }>(
    `SELECT id, text FROM claims WHERE id = $1 AND state = 'active'`,
    [input.claimId]
  );
  if (!claim) {
    return { ok: false, code: "CLAIM_NOT_FOUND", message: "Claim not found or not active" };
  }
  const budgetMicro = owlsToMicroUsd(input.budgetOwls);
  const [job] = await rawQuery<{ id: string }>(
    `INSERT INTO budget_jobs (user_id, kind, claim_id, budget_micro_usd, status)
     VALUES ($1, 'grant', $2, 0, 'running') RETURNING id`,
    [input.userId, claim.id]
  );
  // Escrow behind the balance guard, under the owl-balance lock.
  const held = await withOwlBalanceLock(input.userId, (tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
       SELECT $1, $2, 'escrow_hold', $3
        WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0)
                 FROM owl_ledger WHERE user_id = $1) >= $4
       RETURNING id`,
      [input.userId, -budgetMicro, job!.id, budgetMicro]
    )
  );
  if (held.length === 0) {
    await rawQuery(`DELETE FROM budget_jobs WHERE id = $1`, [job!.id]);
    return {
      ok: false,
      code: "INSUFFICIENT_OWLS",
      message: `Funding this decomposition takes ${input.budgetOwls} owls and your balance can't cover it`,
    };
  }
  await rawQuery(`UPDATE budget_jobs SET budget_micro_usd = $2 WHERE id = $1`, [job!.id, budgetMicro]);

  const text = claimMandateText(claim.text, input.budgetOwls);
  const mandate = {
    ...text,
    scope_claim_id: claim.id,
    scope_query: null,
    plan: null,
    expected_cost_owls: input.budgetOwls,
    origin: "deep_decomposition",
    grantmaker_share_owls: Math.round(input.budgetOwls * GRANTMAKER_SHARE * 1000) / 1000,
    // The funder is a reader buying depth on one claim: shown as one. A
    // reader buying depth on a claim declares no stake in it by doing so.
    funder_named: false,
    funder_stake: null,
  };
  const [grant] = await rawQuery<{ id: string }>(
    `INSERT INTO grants
       (funder_user_id, budget_job_id, name, scope_claim_id, policy, status, mandate)
     VALUES ($1, $2, $3, $4, 'agent', 'planning', $5::jsonb)
     RETURNING id`,
    [input.userId, job!.id, text.title, claim.id, JSON.stringify(mandate)]
  );
  return { ok: true, grantId: grant!.id, budgetJobId: job!.id };
}
