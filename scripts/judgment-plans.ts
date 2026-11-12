/**
 * The plans of a claim page's hot reads of the judgment in force.
 *
 *   DATABASE_URL=postgresql://…/a_seeded_database npx tsx scripts/judgment-plans.ts
 *
 * A node may carry a judgment at each label, and which is in force depends
 * on who reads (src/db/schema.ts, "The judgment in force, and a version at
 * each label"). The four `*_in_force` views call a function for that. On a
 * deployment whose only label is `public` the function is the constant
 * true, which the planner folds into the query, so each view must plan as
 * the plain "where is_current" it was before a node could carry more than
 * one version. This script prints the plan of each hot read so that the two
 * can be compared: run it on a database migrated to just before the change
 * and on one migrated to it, with the same rows in each, and diff.
 *
 * Plans are printed without costs, which depend on the statistics of the
 * day; what must not change is their shape and the indexes they use. It
 * reads only.
 */
import "../src/load-env.js";
import pg from "pg";

const NODE = "00000000-0000-4000-8000-000000000001";

/** Each read as the services send it, cut to what touches a judgment (file and what it serves). */
const READS: Array<[string, string]> = [
  [
    "the node's verdict (assessment-service.ts getCurrentAssessment; routes/claims.ts GET /claims/:id)",
    `SELECT id, status, confidence, claim_credence, summary, reasoning_trace, assessed_at
       FROM assessments_in_force WHERE claim_id = '${NODE}' LIMIT 1`,
  ],
  [
    "a quantity's estimate and a question's standing (claim-view-service.ts kindJudgmentFields)",
    `SELECT (SELECT marginal_yield FROM quantity_estimates_in_force WHERE claim_id = '${NODE}') AS estimate_yield,
            (SELECT confidence FROM question_assessments_in_force WHERE claim_id = '${NODE}') AS standing_confidence`,
  ],
  [
    "the subclaims with each one's judgment (claim-view-service.ts, tree-service.ts)",
    `SELECT c.id, c.text, a.status, a.confidence, qe.estimate, qa.standing
       FROM claim_relationships cr
       JOIN claims c ON c.id = cr.child_claim_id
       LEFT JOIN assessments_in_force a ON a.claim_id = cr.child_claim_id
       LEFT JOIN quantity_estimates_in_force qe ON qe.claim_id = c.id
       LEFT JOIN question_assessments_in_force qa ON qa.claim_id = c.id
      WHERE cr.parent_claim_id = '${NODE}'`,
  ],
  [
    "the arguments with their evaluations and whether each predates the verdict (argument-service.ts)",
    `SELECT a.id, a.name, ae.verdict, ae.decisive, ae.content,
            (ae.id IS NOT NULL AND (ca.id IS NULL OR ae.assessment_id IS DISTINCT FROM ca.id)) AS stale
       FROM arguments a
       JOIN claims c ON c.id = a.claim_id
       LEFT JOIN argument_evaluations_in_force ae ON ae.argument_id = a.id
       LEFT JOIN assessments_in_force ca ON ca.claim_id = a.claim_id
       LEFT JOIN quantity_estimates_in_force cq ON cq.claim_id = a.claim_id
      WHERE a.claim_id = '${NODE}' AND a.name IS NOT NULL AND a.retired_at IS NULL`,
  ],
  [
    "what has changed since the judgment (judgment-inputs-service.ts, the judged CTE and its premises)",
    `WITH judged AS (
       SELECT DISTINCT ON (node_id) node_id, kind, id, assessed_at, inputs_recorded
         FROM (SELECT claim_id AS node_id, 'assessment'::text AS kind, id, assessed_at, inputs_recorded
                 FROM assessments_in_force WHERE claim_id = ANY(ARRAY['${NODE}']::uuid[])
               UNION ALL
               SELECT claim_id, 'quantity_estimate', id, assessed_at, inputs_recorded
                 FROM quantity_estimates_in_force WHERE claim_id = ANY(ARRAY['${NODE}']::uuid[])
               UNION ALL
               SELECT claim_id, 'question_assessment', id, assessed_at, inputs_recorded
                 FROM question_assessments_in_force WHERE claim_id = ANY(ARRAY['${NODE}']::uuid[])) j
        ORDER BY node_id, assessed_at DESC, kind)
     SELECT j.node_id, i.node_id AS premise, i.input_judgment_id,
            (SELECT x.id FROM assessments_in_force x WHERE x.claim_id = i.node_id) AS in_force_now
       FROM judged j
       JOIN judgment_inputs i ON i.judgment_kind = j.kind AND i.judgment_id = j.id AND i.input_kind = 'premise'`,
  ],
  [
    "a list of nodes with their verdicts (claim-service.ts listClaims; search-service.ts)",
    `SELECT c.id, c.text, a.status, a.confidence
       FROM claims c
       LEFT JOIN assessments_in_force a ON a.claim_id = c.id
      WHERE c.state = 'active'
      ORDER BY c.importance DESC, c.created_at DESC
      LIMIT 50`,
  ],
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const [what, sql] of READS) {
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF) ${sql}`);
      console.log(`-- ${what}`);
      for (const row of plan.rows) console.log(row["QUERY PLAN"]);
      console.log("");
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
