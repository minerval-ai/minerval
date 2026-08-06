/**
 * Allocation transparency (§15): why the background lane is doing what it's
 * doing. Public and read-only, like claim reads — the allocation mechanism
 * is only trustworthy if anyone can inspect it.
 *
 *   GET /queue — candidate-set depth by state and the top pending claims,
 *     each with its expected-value inputs (importance, contestation,
 *     expected gain, stakes, staleness, provenance), the expected cost of
 *     the pass it would get, and the value-per-owl ratio the lane actually
 *     orders by — so "why is this claim ahead of that one" is always
 *     answerable. The day's budget and spend are included: the lane takes
 *     the best ratios until the budget is gone, and the rest wait.
 */
import type { FastifyInstance } from "fastify";
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { stewardQueueHealth } from "../workers/steward-pipeline.js";
import { stewardTierCostEstimates } from "../services/cost-estimate-service.js";
import { microUsdToOwls } from "../services/owl.js";

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: number } }>("/", {
    schema: {
      tags: ["queue"],
      summary:
        "The background lane's candidate set: depth by state and the top " +
        "pending claims with their value inputs, cost estimates, and " +
        "value-per-owl ratios",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
      },
    },
    handler: async (request, reply) => {
      const config = loadConfig();
      const limit = request.query.limit ?? 25;
      const [health, tierCosts, spentRow, rows] = await Promise.all([
        stewardQueueHealth(),
        stewardTierCostEstimates(),
        rawQuery<{ spent: number }>(
          `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
             FROM llm_usage
            WHERE user_id IS NULL AND job_id IS NULL
              AND created_at >= date_trunc('day', now())`
        ),
        rawQuery<{
          id: string;
          text: string;
          queue_priority: number;
          importance: number;
          contestation: number | null;
          created_by: string;
          marginal_yield: number | null;
          assessed_at: Date | null;
          stake_micro: number;
        }>(
          `SELECT c.id, c.text, c.queue_priority, c.importance,
                  c.contestation, c.created_by,
                  a.marginal_yield, a.assessed_at,
                  COALESCE((SELECT SUM(s.amount_micro_usd)
                              FROM claim_stakes s WHERE s.claim_id = c.id), 0)
                    AS stake_micro
             FROM claims c
             LEFT JOIN assessments a
               ON a.claim_id = c.id AND a.is_current = true
            WHERE c.state = 'active' AND c.steward_state = 'pending'
            ORDER BY c.queue_priority DESC, c.updated_at ASC
            LIMIT $1`,
          [limit]
        ),
      ]);

      const strongConfigured = !!config.stewardStrongModel;
      const strongMin = config.stewardStrongMinPriority;
      const costOwlsFor = (value: number): number =>
        microUsdToOwls(
          strongConfigured && value >= strongMin
            ? tierCosts.strongMicroUsd
            : tierCosts.standardMicroUsd
        );

      const pending = rows
        .map((r) => {
          const costOwls = costOwlsFor(r.queue_priority);
          return {
            claim_id: r.id,
            text: r.text,
            expected_value: r.queue_priority,
            expected_cost_owls: costOwls,
            value_per_owl:
              costOwls > 0
                ? Math.round((r.queue_priority / costOwls) * 100) / 100
                : null,
            inputs: {
              importance: r.importance,
              // Unassessed claims carry maximal expected gain by convention.
              marginal_yield: r.marginal_yield ?? (r.assessed_at ? null : 1),
              contestation: r.contestation,
              stake_owls:
                Math.round(
                  (Number(r.stake_micro) / config.owlPriceMicroUsd) * 1000
                ) / 1000,
              days_since_assessed: r.assessed_at
                ? Math.floor(
                    (Date.now() - new Date(r.assessed_at).getTime()) /
                      86_400_000
                  )
                : null,
              user_proposed: r.created_by === "user",
            },
          };
        })
        // The lane's real ordering: value per owl of expected cost.
        .sort((a, b) => (b.value_per_owl ?? 0) - (a.value_per_owl ?? 0));

      return reply.send({
        depth: health,
        // The knobs in effect, so the numbers below are reproducible.
        formula: {
          contestation_floor: config.valueContestationFloor,
          stake_weight: config.priorityStakeWeight,
          stake_saturation_owls: config.priorityStakeSaturationOwls,
          staleness_saturation_days: config.priorityStalenessSaturationDays,
          user_provenance_boost: config.priorityUserProvenanceBoost,
        },
        cost_estimates: {
          standard_owls: microUsdToOwls(tierCosts.standardMicroUsd),
          strong_owls: microUsdToOwls(tierCosts.strongMicroUsd),
          strong_min_value: strongConfigured ? strongMin : null,
        },
        daily_budget: {
          budget_owls: config.backgroundDailyBudgetOwls,
          spent_today_owls: microUsdToOwls(Number(spentRow[0]?.spent ?? 0)),
        },
        pending,
      });
    },
  });
}
