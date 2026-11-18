/**
 * The exclusion group a Steward's lookout keeps its fund on
 * (lookout-fund.ts). No ledger row is ever opened in it, so nothing runs
 * on it and nothing counts it as cover for a run: money leaves it only when
 * the lookout pays for a run or a commission. Its own module so that
 * commission-service.ts can name it without importing the fund's logic.
 */
export const LOOKOUT_FUND_GROUP = (lookoutId: string) => `lookout-fund:${lookoutId}`;
