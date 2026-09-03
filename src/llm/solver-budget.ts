/**
 * The solver breaker (docs/mathematics.md §7.3): a durable daily cap on
 * `math_solver` spend, independent of any mandate.
 *
 * The in-memory budget tracker exempts attributed calls and is per process,
 * so it bounds nothing for a funded, hours-long attempt. This one is a
 * query: today's `SUM(llm_usage.cost_micro_usd WHERE agent = 'math_solver')`,
 * Lean and container rows included since they land in the same table,
 * against SOLVER_DAILY_CAP_OWLS (or the calibration cap during a calibration
 * run). Over the cap it raises the existing LlmBudgetExceededError, which
 * the worker treats as `budget`: release and requeue, never a failure.
 *
 * Beside it, a consecutive-failure breaker copied from the steward drain:
 * after a short run of transient failures the API itself is the problem,
 * and the worker rests rather than churning through the ledger.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { LlmBudgetExceededError } from "./errors.js";
import { owlsToMicroUsd } from "../services/owl.js";

export const SOLVER_AGENT = "math_solver";

/** Same threshold as the steward drain's TRANSIENT_CIRCUIT_BREAK. */
export const SOLVER_TRANSIENT_CIRCUIT_BREAK = 5;

/** Today's (UTC) metered solver spend, in micro-USD, from the durable meter. */
export async function solverSpentTodayMicroUsd(): Promise<number> {
  const [row] = await rawQuery<{ spent: number | string | null }>(
    `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
       FROM llm_usage
      WHERE agent = $1
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [SOLVER_AGENT]
  );
  return Number(row?.spent ?? 0);
}

/** The cap in force, in micro-USD: the calibration cap during a calibration run. */
export function solverDailyCapMicroUsd(opts: { calibration?: boolean } = {}): number {
  const config = loadConfig();
  const owls = opts.calibration
    ? config.solverCalibrationDailyCapOwls
    : config.solverDailyCapOwls;
  return owlsToMicroUsd(owls);
}

/**
 * Throw LlmBudgetExceededError when today's solver spend has reached the
 * daily cap. A cap of zero admits nothing: the breaker is a money bound,
 * and "no cap" is not a setting it offers.
 */
export async function checkSolverBudget(
  opts: { calibration?: boolean } = {}
): Promise<void> {
  const cap = solverDailyCapMicroUsd(opts);
  const spent = await solverSpentTodayMicroUsd();
  if (spent >= cap) {
    throw new LlmBudgetExceededError(
      opts.calibration ? "solver_calibration_daily_cap_micro_usd" : "solver_daily_cap_micro_usd",
      spent,
      cap
    );
  }
}

/**
 * The consecutive-failure breaker. Transient failures count; a success or
 * an empty tick resets. `tripped` says the worker should rest until the
 * next interval instead of claiming another attempt.
 */
export class SolverFailureBreaker {
  private consecutive = 0;

  constructor(private readonly threshold = SOLVER_TRANSIENT_CIRCUIT_BREAK) {}

  /** Record one transient failure; returns true when the breaker just tripped or is tripped. */
  recordFailure(): boolean {
    this.consecutive++;
    return this.tripped;
  }

  reset(): void {
    this.consecutive = 0;
  }

  get failures(): number {
    return this.consecutive;
  }

  get tripped(): boolean {
    return this.consecutive >= this.threshold;
  }
}
