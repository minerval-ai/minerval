/**
 * A lookout's commission window (#1043): the most it may commit alone across
 * items within a rolling window, beside the per-item limit.
 *
 * The per-item limit (lookouts.commission_limit_micro_usd) marks what is
 * small enough to commit without the program officers' weighing, since a
 * lookout sees only its find and the officers see everything else the
 * mandate could buy. Five items each inside that limit, committed in two
 * minutes, are one large call nobody weighed; the window is the
 * Grantmaker's bound on that. It is a delegation in money, set on
 * spawn_lookout/update_lookout and stated to the lookout with its running
 * state, never a count of commissions or runs.
 *
 * It is read as a mandate's steady pace is (pace-service.ts): over the
 * allocations the lookout placed (action_allocations.lookout_id) in the last
 * `hours`, each counting its amount while its run may still spend it and its
 * spend once settled (allocationDayUseSql), through the whole-money view so
 * work at every label counts. A commission past it is not clipped: it goes
 * to the officers with the figures, as one past the per-item limit does.
 */
import { rawQuery, type TxQuery } from "../db/client.js";
import { allocationDayUseSql } from "./day-use.js";
import { microUsdToOwls } from "./owl.js";

/** The longest commission window: a week, the longest a steady pace is commonly set to. */
export const COMMISSION_WINDOW_MAX_HOURS = 168;

export interface LookoutWindow {
  /** The most it may commit alone in the window; 0 = no window. */
  windowMicroUsd: number;
  hours: number;
  /** What its own commissions hold against the window now. */
  usedMicroUsd: number;
  /** windowMicroUsd - usedMicroUsd, never below 0; Infinity with no window. */
  leftMicroUsd: number;
}

/** The lookout's window and what of it is used; null for an unknown lookout. */
export async function lookoutWindow(lookoutId: string, tx?: TxQuery): Promise<LookoutWindow | null> {
  const q = <T,>(text: string, params: unknown[]) => (tx ? tx.query<T>(text, params) : rawQuery<T>(text, params));
  const [row] = await q<{ window_micro_usd: string; hours: number; used: string }>(
    `SELECT l.commission_window_micro_usd AS window_micro_usd,
            l.commission_window_hours AS hours,
            COALESCE((SELECT SUM(${allocationDayUseSql("al")})
                        FROM minerval_whole.allocation_money al
                       WHERE al.lookout_id = l.id
                         AND al.created_at > now() - make_interval(hours => l.commission_window_hours)), 0)::bigint AS used
       FROM lookouts l WHERE l.id = $1`,
    [lookoutId]
  );
  if (!row) return null;
  const windowMicroUsd = Number(row.window_micro_usd) || 0;
  const usedMicroUsd = Number(row.used) || 0;
  return {
    windowMicroUsd,
    hours: Number(row.hours) || 24,
    usedMicroUsd,
    leftMicroUsd: windowMicroUsd > 0 ? Math.max(0, windowMicroUsd - usedMicroUsd) : Number.POSITIVE_INFINITY,
  };
}

const owls = (micro: number) => microUsdToOwls(micro);

/** Where the window stands, in one sentence, for the lookout's briefing and its results. */
export function lookoutWindowSentence(w: LookoutWindow): string {
  if (!(w.windowMicroUsd > 0)) return "";
  return (
    `Your own commissions hold ${owls(w.usedMicroUsd)} of your ${owls(w.windowMicroUsd)} owls for any ` +
    `${w.hours} hours (${owls(w.leftMicroUsd)} left); it frees as their runs settle and as they age past ${w.hours} hours.`
  );
}

/** A refusal in words: why a budget does not fit the window, with the figures. */
export function lookoutWindowRefusal(w: LookoutWindow, budgetMicroUsd: number): string {
  return (
    `A budget of ${owls(budgetMicroUsd)} owls is more than your commission window leaves ` +
    `(${owls(w.leftMicroUsd)} of ${owls(w.windowMicroUsd)} owls for any ${w.hours} hours). ` +
    `Past the window, an item goes to the program officers, who weigh it against everything else the mandate could buy.`
  );
}
