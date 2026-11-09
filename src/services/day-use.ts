/**
 * What one allocation counts against its mandate's day (SQL fragment): its
 * whole amount while its run may still spend it, and what was actually spent
 * once it has settled. Budgets are set at the high end of what work costs and
 * the unspent part returns at settlement, so counting amounts placed would
 * hold a mandate to a fraction of its rate; counting spend alone would let it
 * promise more than the day allows while runs are in flight.
 */
export function allocationDayUseSql(alias?: string): string {
  const a = alias ? `${alias}.` : "";
  return `CASE WHEN ${a}released_at IS NULL THEN ${a}amount_micro_usd ELSE ${a}spent_micro_usd END`;
}
