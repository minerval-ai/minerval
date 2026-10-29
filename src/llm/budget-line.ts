/**
 * The spend line an agent sees after every turn of a run with a budget
 * (instruments and every metered run alike): what it has spent, of what,
 * and about how many turns that leaves. Kept free of imports so the tool
 * loop can use it without pulling in the instruments' harness.
 */

function usd(micro: number): string {
  return `$${(Math.max(0, micro) / 1_000_000).toFixed(2)}`;
}

/**
 * The line shown after every turn: what has been spent, of what, and about
 * how many turns remain at the last turn's cost. Turns grow dearer as the
 * history grows, so the count is an upper bound and says so.
 */
export function spendLine(input: {
  spentMicroUsd: number;
  ceilingMicroUsd: number;
  lastTurnMicroUsd: number;
}): string {
  const { spentMicroUsd: spent, ceilingMicroUsd: ceiling, lastTurnMicroUsd: last } = input;
  const pct = ceiling > 0 ? Math.min(100, Math.round((100 * spent) / ceiling)) : 100;
  const head = `Budget: ${usd(spent)} of ${usd(ceiling)} spent (${pct}%).`;
  if (last <= 0 || spent >= ceiling) return head;
  const left = Math.floor((ceiling - spent) / last);
  return (
    `${head} Your last turn cost ${usd(last)}; at that rate about ${left} ` +
    `turn${left === 1 ? "" : "s"} remain, fewer as the conversation grows.`
  );
}
