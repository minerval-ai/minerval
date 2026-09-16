/**
 * The one line every agent's task message uses to state its tool-use turn
 * budget (#474). The cap is a halting guard in the constitution's sense
 * (Part IX), so the line says so: a backstop, not a target. The loop appends
 * a running counter to every tool result and a final notice near the cut, so
 * the agent is told the number once here and then kept current.
 */
export function turnBudgetLine(maxTurns: number): string {
  return (
    `Budget: you have up to ${maxTurns} tool-use turns in this run, the one ` +
    `that records your conclusion included. That is a backstop, not a ` +
    `target; each tool result tells you how many remain. Make your ` +
    `concluding tool call(s) before the last of them: whatever is not ` +
    `recorded when the run ends is lost.`
  );
}
