/**
 * A node's current judgment lives in the table its kind keeps (§10): a
 * proposition's verdict in `assessments`, a quantity's estimate in
 * `quantity_estimates`, a question's standing in `question_assessments`.
 * The allocation SQL reads two things from it, the Steward's recorded
 * marginal yield and when the judgment was made, and must read them from
 * the right table, or every quantity and question looks never assessed and
 * worth a full pass (#755). One fragment serves the valuer and the queue
 * priority, so the two cannot drift apart. (graph-read-tools'
 * allocationSignals reads recency by kind the same way.)
 */

/** The current judgment's `column` for the claims row aliased `alias`, or NULL when it has none. */
function currentJudgmentColumnSql(column: "marginal_yield" | "assessed_at", alias: string): string {
  const pick = (table: string) =>
    `(SELECT j.${column} FROM ${table} j
       WHERE j.claim_id = ${alias}.id AND j.is_current = true
       ORDER BY j.assessed_at DESC LIMIT 1)`;
  return `(CASE ${alias}.kind
    WHEN 'quantity' THEN ${pick("quantity_estimates")}
    WHEN 'question' THEN ${pick("question_assessments")}
    ELSE ${pick("assessments")} END)`;
}

/** The Steward's recorded marginal yield on the node's current judgment (NULL when unstated or unjudged). */
export function nodeMarginalYieldSql(alias = "c"): string {
  return currentJudgmentColumnSql("marginal_yield", alias);
}

/** When the node's current judgment was made (NULL when it has none). */
export function nodeAssessedAtSql(alias = "c"): string {
  return currentJudgmentColumnSql("assessed_at", alias);
}
