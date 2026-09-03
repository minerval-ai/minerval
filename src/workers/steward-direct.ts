/**
 * Direct invocation of the Claim Steward for the money triggers
 * (docs/mathematics.md §6.4).
 *
 * The ordinary path enqueues the Steward into the claim's single pending slot,
 * where triggers coalesce and an existing trigger wins over a new one. A
 * fidelity judgment on a prize claim, a formalization review, or the
 * verdict on a solver attempt must not run as a reassessment on the standard
 * tier because a reassessment happened to be pending. So the six money
 * triggers never pass through the queue: the worker that owns the event
 * calls this function, which runs the Steward now, on the strong tier, under
 * the funding job's usage context, and returns what it cost.
 *
 * Production refuses to run a money trigger without STEWARD_STRONG_MODEL,
 * loudly, because the alternative is a prize decided by the cheap tier.
 */
import { loadConfig } from "../config.js";
import { runClaimSteward } from "../llm/agents/claim-steward.js";
import { runWithUsageContext, withCostMeter } from "../llm/usage-context.js";

export const MONEY_TRIGGERS = [
  "formalize",
  "formalization_review",
  "prize_claim",
  "prize_claim_voided",
  "prize_window_closed",
  "attempt_completed",
] as const;

export type MoneyTrigger = (typeof MONEY_TRIGGERS)[number];

export function isMoneyTrigger(trigger: string): trigger is MoneyTrigger {
  return (MONEY_TRIGGERS as readonly string[]).includes(trigger);
}

export interface DirectStewardInput {
  trigger: MoneyTrigger;
  claimId: string;
  /** Short: the id of the record to fetch and one line; the Steward fetches the rest with its tools. */
  context: string;
  /** The funding job (the mandate's budget job or the prize-review reserve). */
  jobId?: string;
  userId?: string;
  /** Test and harness override; production ignores it unless it is the strong model. */
  model?: string;
}

export interface DirectStewardResult {
  model: string;
  billedMicroUsd: number;
}

/** The model a money trigger runs on, or a thrown error in production. */
export function moneyTriggerModel(trigger: MoneyTrigger, override?: string): string {
  const config = loadConfig();
  if (config.stewardStrongModel) return override ?? config.stewardStrongModel;
  if (config.env === "production") {
    throw new Error(
      `STEWARD_STRONG_MODEL is not set; the ${trigger} trigger is a money decision and ` +
        "does not run on the standard tier in production (docs/mathematics.md §6.4)"
    );
  }
  return override ?? config.stewardModel;
}

/**
 * Run the Steward on one claim for one money trigger, now, on the strong
 * tier, metered against the funding job. Never goes through enqueueSteward.
 */
export async function invokeStewardDirect(input: DirectStewardInput): Promise<DirectStewardResult> {
  if (!isMoneyTrigger(input.trigger)) {
    throw new Error(`${String(input.trigger)} is not a money trigger; use enqueueSteward`);
  }
  const model = moneyTriggerModel(input.trigger, input.model);
  const { billedMicroUsd } = await runWithUsageContext(
    {
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      claimId: input.claimId,
    },
    () =>
      withCostMeter(() =>
        runClaimSteward({
          trigger: input.trigger,
          claimId: input.claimId,
          context: input.context,
          model,
        })
      )
  );
  return { model, billedMicroUsd };
}
