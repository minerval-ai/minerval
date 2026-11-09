/**
 * Spending from the run in hand: who pays for work this run commissions,
 * and keeping the run's own ceiling honest as it pays.
 *
 * The lane that funds a run says who pays (usage-context.ts, RunFunding).
 * A run on the ledger pays from the allocations covering it, so the money
 * keeps its payer and the chain of runs is recorded; a run funded straight
 * from a mandate's escrow pays from that mandate. A run with neither can't
 * pay for other work, and its tools say so.
 */
import { getUsageContext, passBudgetLeftMicroUsd } from "./usage-context.js";
import type { CommissionPayer } from "../services/commission-service.js";

export function runPayer(): CommissionPayer | null {
  const funding = getUsageContext().passBudget?.funding;
  if (funding?.actionId) return { kind: "run", actionId: funding.actionId };
  if (funding?.grantId) return { kind: "grant", grantId: funding.grantId };
  return null;
}

/** What this run may still spend, in micro-USD, or null when it has no budget. */
export function runBudgetLeft(): number | null {
  return passBudgetLeftMicroUsd();
}

/** Lower this run's ceiling by what it just paid for other work with. */
export function debitRunBudget(microUsd: number): void {
  const budget = getUsageContext().passBudget;
  if (budget) budget.microUsd = Math.max(budget.meter.billedMicroUsd, budget.microUsd - Math.round(microUsd));
}

/** Raise this run's ceiling by a granted petition. */
export function creditRunBudget(microUsd: number): void {
  const budget = getUsageContext().passBudget;
  if (budget) budget.microUsd += Math.round(microUsd);
}
