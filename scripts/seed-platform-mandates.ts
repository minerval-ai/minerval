/**
 * Seed the platform's own mandates — the ones Minerval sets up and runs,
 * which take pride of place on the public /mandates page.
 *
 * The load-bearing one is GENERAL ASSESSMENT: the mandate whose escrow is
 * however many dollars Minerval allocates to expanding and maintaining the
 * graph (Minerval buys owls at $1 per owl — at cost; the $4 price is what
 * users pay, and the margin funds this escrow). Its allocator backs the
 * highest value-per-dollar assessments up to its daily rate through the
 * same allocation engine every funder uses, and its ALLOCATION POLICY is
 * the platform's formulas, amendable by its Grantmaker in conversation.
 * Beside it: Mathematics and AI Economics, topical standing mandates.
 *
 * Idempotent: re-running tops nothing up and never duplicates.
 *
 * Usage: DATABASE_URL=… npx tsx scripts/seed-platform-mandates.ts
 */
import { rawQuery, withTransaction } from "../src/db/client.js";
import { owlsToMicroUsd } from "../src/services/owl.js";

interface PlatformMandate {
  key: string;
  title: string;
  objective: string;
  scopeQuery: string | null;
  strategy: string;
  budgetOwls: number;
  policy: "general" | "cover";
  dailyBudgetOwls: number;
}

const MANDATES: PlatformMandate[] = [
  {
    key: "general-assessment",
    title: "General assessment",
    objective:
      "Assess the most important claims across the whole graph, wherever " +
      "they are. This is Minerval's own standing mandate: its budget is " +
      "the money the platform allocates to expanding and maintaining the " +
      "graph, its allocator backs the highest expected value per dollar " +
      "of cost each day, and its allocation policy is the platform's " +
      "public formula, revised by this mandate's Grantmaker as the " +
      "evidence about allocation itself accumulates.",
    scopeQuery: null,
    strategy:
      "Back the candidates with the best expected value per dollar of " +
      "remaining cost, across the whole graph, until the day's rate is " +
      "committed. Co-fund partially backed claims rather than duplicate " +
      "other funders' allocations.",
    budgetOwls: 2000,
    policy: "general",
    dailyBudgetOwls: 50,
  },
  {
    key: "mathematics",
    title: "Mathematics",
    objective:
      "Keep the graph's mathematical claims sound and current: the " +
      "load-bearing results, the live conjectures and their evidence, and " +
      "the contested applications of mathematical results elsewhere in the " +
      "graph. Settled bedrock is recorded cheaply; attention concentrates " +
      "where working mathematicians actually disagree.",
    // websearch OR-form: a topical scope wants anything matching ANY of
    // its terms, not the conjunction of all of them.
    scopeQuery: "mathematics OR theorem OR conjecture OR proof",
    strategy:
      "Cover unassessed mathematical claims in scope first, then keep " +
      "assessments fresh as new results land. Depth goes to claims whose " +
      "subtrees carry contested lemmas or disputed applicability.",
    budgetOwls: 250,
    policy: "cover",
    dailyBudgetOwls: 10,
  },
  {
    key: "ai-economics",
    title: "AI Economics",
    objective:
      "Map and assess the claims the AI-economics debate actually turns " +
      "on: labor-market effects, productivity and growth estimates, " +
      "compute and capability economics, market structure, and the policy " +
      "claims that depend on them. This is a fast-moving, contested area; " +
      "reassessment cadence matters as much as coverage.",
    scopeQuery:
      "economics OR labor OR productivity OR automation OR wage OR employment",
    strategy:
      "Cover the unassessed cruxes first, reassess anything stale in a " +
      "field that moves monthly, and deepen the claims whose subtrees " +
      "carry the contested elasticity and adoption estimates.",
    budgetOwls: 250,
    policy: "cover",
    dailyBudgetOwls: 10,
  },
];

async function main() {
  // The platform account.
  const [platform] = await rawQuery<{ id: string }>(
    `INSERT INTO contributors (external_id, display_name)
     VALUES ('platform:minerval', 'Minerval')
     ON CONFLICT (external_id)
       DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`
  );
  const platformId = platform!.id;

  for (const m of MANDATES) {
    const [existing] = await rawQuery<{ id: string }>(
      `SELECT id FROM grants
        WHERE is_platform = true AND name = $1`,
      [m.title]
    );
    if (existing) {
      console.log(`= ${m.title} already exists (${existing.id})`);
      continue;
    }

    const budgetMicro = owlsToMicroUsd(m.budgetOwls);

    const mandate = {
      title: m.title,
      objective: m.objective,
      scope_claim_id: null,
      scope_query: m.scopeQuery,
      plan: { strategy: m.strategy, items: [] },
      expected_cost_owls: m.budgetOwls,
      notes:
        "A standing platform mandate. Its plan grows as the Grantmaker " +
        "surveys the scope; contributions extend how far it reaches.",
    };

    // One transaction per mandate: mint, job, hold, and grant land (or
    // roll back) together — a crash mid-way can never leave an orphaned
    // running job whose hold's idempotency key pins the escrow to it.
    const grantId = await withTransaction(async (tx) => {
      // Mint the platform's owls (idempotent), then escrow them.
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, idempotency_key)
         VALUES ($1, $2, 'admin_adjust', $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [platformId, budgetMicro, `platform_mandate_mint:${m.key}`]
      );
      const [job] = await tx.query<{ id: string }>(
        `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status)
         VALUES ($1, 'grant', $2, 'running')
         RETURNING id`,
        [platformId, budgetMicro]
      );
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id, idempotency_key)
         VALUES ($1, $2, 'escrow_hold', $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [platformId, -budgetMicro, job!.id, `platform_mandate_hold:${m.key}`]
      );

      // 'general' = the allocation engine's platform lane; 'cover' = the
      // coverage selector over a topical scope. Both standing mandates.
      const [grant] = await tx.query<{ id: string }>(
        `INSERT INTO grants
           (funder_user_id, budget_job_id, name, scope_query, policy, status,
            plan, mandate, is_platform, daily_budget_micro_usd)
         VALUES ($1, $2, $3, $4, $7, 'active', $5::jsonb, $6::jsonb, true, $8)
         RETURNING id`,
        [
          platformId,
          job!.id,
          m.title,
          m.scopeQuery,
          JSON.stringify({ strategy: m.strategy, items: [] }),
          JSON.stringify(mandate),
          m.policy,
          owlsToMicroUsd(m.dailyBudgetOwls),
        ]
      );
      return grant!.id;
    });
    console.log(`+ ${m.title} created (${grantId}), ${m.budgetOwls} owls`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
