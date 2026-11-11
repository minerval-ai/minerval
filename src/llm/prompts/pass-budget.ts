/**
 * What a Grantmaker's own pass is told about its budget (#820): what the
 * figure is and who set it, that it is held against the day while the pass
 * runs, how to add to it, and, with figures, when the pass was started with
 * less than the figure. These sentences are the `basis` of the budget line
 * (turn-budget.ts) for the review and planning passes, whose budgets are
 * not a costing-skill estimate of the work: a review pass works to the
 * figure its mandate's operating policy names
 * (operating-policy-service.ts, reviewPassBudget), a planning pass to the
 * platform's default, and a decomposition's passes to its Grantmaker share.
 *
 * Pure functions of figures the caller already holds, in micro-USD.
 */
import { microUsdToOwls } from "../../services/owl.js";

const OPENING_TURN =
  `Its opening turn (your instructions, the tool list and this briefing) is paid from it before any other work.`;

/** Below this difference a pass is not called short (rounding in the ledger). */
const SHORT_BY_MICRO_USD = 10_000;

function owls(micro: number): string {
  return String(microUsdToOwls(Math.max(0, micro)));
}

function shortSentence(input: {
  ceilingMicroUsd: number;
  floorOwls: number;
  /** Where the money stands now, for the agent to act on. */
  standing: string;
}): string {
  return (
    `This pass was started with less than that, ${owls(input.ceilingMicroUsd)} owls, because that was what ` +
    `could be found when it was funded (${input.standing}). A pass is started short rather than not at all when at ` +
    `least ${input.floorOwls} owls can be found, and waits for room below that, since less would be spent on ` +
    `the opening turn alone.`
  );
}

export interface ReviewPassBudgetFacts {
  /** The budget this run actually has, or null when it runs without one. */
  ceilingMicroUsd: number | null;
  /** The mandate's figure for a review pass (reviewPassBudget). */
  figure: { microUsd: number; fromPolicy: boolean; reason: string };
  /** A decomposition: its passes are paid from the Grantmaker share. */
  fromShare: boolean;
  floorOwls: number;
  dailyRateMicroUsd: number;
  /** Committed against today's rate so far, this pass's budget included. */
  dayUsedMicroUsd: number;
  /** Escrow not yet committed, this pass's budget already taken out. */
  escrowFreeMicroUsd: number;
}

export function reviewPassBudgetBasis(f: ReviewPassBudgetFacts): string {
  const paced = f.dailyRateMicroUsd > 0;
  const held = paced
    ? `The whole of it is held against today's rate while this pass runs, and what you do not spend is freed when it ends.`
    : `The whole of it is held from your escrow while this pass runs, and what you do not spend is freed when it ends.`;
  const standing =
    (paced
      ? `now ${owls(f.dayUsedMicroUsd)} of ${owls(f.dailyRateMicroUsd)} owls of today's rate are committed, ` +
        `this pass's budget included, and `
      : `now `) + `${owls(f.escrowFreeMicroUsd)} owls of escrow are uncommitted`;
  const short =
    f.ceilingMicroUsd != null && f.ceilingMicroUsd < f.figure.microUsd - SHORT_BY_MICRO_USD
      ? " " + shortSentence({ ceilingMicroUsd: f.ceilingMicroUsd, floorOwls: f.floorOwls, standing })
      : "";

  if (f.fromShare) {
    return (
      `It is what is left of this mandate's Grantmaker share ("Your share of this budget", above), which is the ` +
      `bound on your own passes, so there is no adding to it.${short} ${held} ${OPENING_TURN}`
    );
  }
  const what = f.figure.fromPolicy
    ? `It is your mandate's own figure for a review pass: review_pass_owls in your operating policy, ` +
      `${owls(f.figure.microUsd)} owls (${f.figure.reason}). Change it with write_operating_policy; it applies ` +
      `from the next pass opened.`
    : `It is the platform's default for a review pass, ${owls(f.figure.microUsd)} owls, the figure a Curator run, ` +
      `an Audit run and a paid assessment work to, because your operating policy names none. The mandate pays ` +
      `for its own passes, so the figure is yours to set: review_pass_owls in write_operating_policy, with your ` +
      `reason, from the next pass opened.`;
  const add =
    `If this pass needs more, add_to_pass_budget moves more of your escrow onto it, within what ` +
    (paced ? `today's rate and the escrow have left` : `the escrow has left`) +
    `, and gives you the figures when it cannot` +
    (paced ? ` (the rate is yours to raise with set_daily_rate)` : ``) +
    `. That is cheaper than a second pass, which pays for the opening turn again.`;
  return `${what}${short} ${held} ${OPENING_TURN} ${add}`;
}

export interface PlanningPassBudgetFacts {
  ceilingMicroUsd: number | null;
  /** The platform's default for a Grantmaker's pass. */
  defaultMicroUsd: number;
  fromShare: boolean;
  floorOwls: number;
  escrowMicroUsd: number;
}

export function planningPassBudgetBasis(f: PlanningPassBudgetFacts): string {
  if (f.fromShare) {
    return (
      `It is half of this mandate's Grantmaker share ("Your share of this budget", above), paid from the ` +
      `mandate's escrow. ${OPENING_TURN}`
    );
  }
  const short =
    f.ceilingMicroUsd != null && f.ceilingMicroUsd < f.defaultMicroUsd - SHORT_BY_MICRO_USD
      ? " " +
        shortSentence({
          ceilingMicroUsd: f.ceilingMicroUsd,
          floorOwls: f.floorOwls,
          standing: `the mandate's escrow is ${owls(f.escrowMicroUsd)} owls`,
        })
      : "";
  return (
    `It is the platform's default for a Grantmaker's pass, ${owls(f.defaultMicroUsd)} owls, the figure a Curator ` +
    `run, an Audit run and a paid assessment work to: a planning pass runs before the mandate has an operating ` +
    `policy to name its own figure. It is paid from the mandate's escrow, and it cannot be added to during the ` +
    `pass, since nothing is commissioned from a mandate before its funder approves the plan.${short} ${OPENING_TURN}`
  );
}
