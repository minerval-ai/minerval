/**
 * Seed the platform's own mandates — the ones Minerval sets up and runs,
 * which take pride of place on the public /mandates page. To start:
 * Mathematics and AI Economics.
 *
 * Idempotent: re-running tops nothing up and never duplicates. The platform
 * account is a system contributor ("platform:minerval"); its owls are
 * minted as an admin adjustment (the platform funding its own graph is a
 * traction cost, not revenue) and escrowed into each mandate's budget job.
 *
 * Usage: DATABASE_URL=… npx tsx scripts/seed-platform-mandates.ts
 */
import { rawQuery } from "../src/db/client.js";
import { owlsToMicroUsd } from "../src/services/owl.js";

interface PlatformMandate {
  key: string;
  title: string;
  objective: string;
  scopeQuery: string;
  strategy: string;
  budgetOwls: number;
}

const MANDATES: PlatformMandate[] = [
  {
    key: "mathematics",
    title: "Mathematics",
    objective:
      "Keep the graph's mathematical claims sound and current: the " +
      "load-bearing results, the live conjectures and their evidence, and " +
      "the contested applications of mathematical results elsewhere in the " +
      "graph. Settled bedrock is recorded cheaply; attention concentrates " +
      "where working mathematicians actually disagree.",
    scopeQuery: "mathematics theorem conjecture proof",
    strategy:
      "Cover unassessed mathematical claims in scope first, then keep " +
      "assessments fresh as new results land. Depth goes to claims whose " +
      "subtrees carry contested lemmas or disputed applicability.",
    budgetOwls: 250,
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
    scopeQuery: "artificial intelligence economics labor productivity automation",
    strategy:
      "Cover the unassessed cruxes first, reassess anything stale in a " +
      "field that moves monthly, and deepen the claims whose subtrees " +
      "carry the contested elasticity and adoption estimates.",
    budgetOwls: 250,
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

    // Mint the platform's owls (idempotent), then escrow them.
    await rawQuery(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, idempotency_key)
       VALUES ($1, $2, 'admin_adjust', $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [platformId, budgetMicro, `platform_mandate_mint:${m.key}`]
    );

    const [job] = await rawQuery<{ id: string }>(
      `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status)
       VALUES ($1, 'grant', $2, 'running')
       RETURNING id`,
      [platformId, budgetMicro]
    );
    await rawQuery(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id, idempotency_key)
       VALUES ($1, $2, 'escrow_hold', $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [platformId, -budgetMicro, job!.id, `platform_mandate_hold:${m.key}`]
    );

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

    // Platform mandates run the coverage selector over their scope (policy
    // 'cover'): standing breadth mandates, not one-shot plans.
    const [grant] = await rawQuery<{ id: string }>(
      `INSERT INTO grants
         (funder_user_id, budget_job_id, name, scope_query, policy, status,
          plan, mandate, is_platform)
       VALUES ($1, $2, $3, $4, 'cover', 'active', $5::jsonb, $6::jsonb, true)
       RETURNING id`,
      [
        platformId,
        job!.id,
        m.title,
        m.scopeQuery,
        JSON.stringify({ strategy: m.strategy, items: [] }),
        JSON.stringify(mandate),
      ]
    );
    console.log(`+ ${m.title} created (${grant!.id}), ${m.budgetOwls} owls`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
