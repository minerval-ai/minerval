/**
 * The one line every agent's task message uses to state what it has to work
 * with (#474). When the run has a budget (runBudget), that is the binding
 * constraint and the line leads with it; the turn cap is a halting guard in
 * the constitution's sense (Part IX), so the line says so: a backstop, not a
 * target. The loop appends a running spend and turn line to every tool
 * result and a notice near the end, so the agent is told the numbers once
 * here and then kept current.
 */
import { runBudget } from "../usage-context.js";

/**
 * The turn cap for an agent whose run has a budget. The money is what ends
 * such a run; this only halts a loop that has stopped making progress
 * without spending (a harness or provider fault), so it is set far above
 * any real run rather than tuned per agent.
 */
export const RUN_TURN_GUARD = 200;

function usd(micro: number): string {
  return `$${(Math.max(0, micro) / 1_000_000).toFixed(2)}`;
}

export interface BudgetLineOptions {
  canSpend?: boolean;
  /**
   * What the figure is and who set it, as one or more whole sentences, for
   * a run whose budget is not a costing-skill estimate of the work: a
   * Grantmaker's own pass, budgeted by its mandate's policy (#820). It
   * replaces the "high end of what work like this usually costs" sentence,
   * which is only true of a budget set that way.
   */
  basis?: string;
}

/** The budget sentence alone, or "" when the run has no budget. */
export function runBudgetSentence(opts: BudgetLineOptions = {}): string {
  const budget = runBudget();
  if (!budget) return "";
  return (
    `This run has a budget of ${usd(budget.ceilingMicroUsd)}, from ${budget.source}. ` +
    (opts.basis
      ? `${opts.basis.trim()} Spend what the work warrants, and what you leave goes back to whoever paid, ` +
        `for other work. `
      : `It is ` +
        `set at the high end of what work like this usually costs, so most runs finish well ` +
        `inside it: spend what the work warrants, and what you leave goes back to whoever paid, ` +
        `for other work. `) +
    `It is metered at real cost, model tokens and any paid tool; paid ` +
    `tools say what they cost and decline a call the remaining budget cannot cover.` +
    (opts.canSpend
      ? ` If doing this properly needs more, ask with petition_mandate and you will get the ` +
        `answer in this run. You can pay for other agents' work from this budget with commission.`
      : "")
  );
}

export function turnBudgetLine(maxTurns: number, opts: BudgetLineOptions = {}): string {
  const budget = runBudgetSentence(opts);
  const turns =
    `you have up to ${maxTurns} tool-use turns in this run, the one ` +
    `that records your conclusion included. That is a backstop, not a ` +
    `target; each tool result tells you how many remain. Make your ` +
    `concluding tool call(s) before the last of them: whatever is not ` +
    `recorded when the run ends is lost.`;
  if (!budget) return `Budget: ${turns}`;
  return `Budget: ${budget} Separately, ${turns}`;
}
