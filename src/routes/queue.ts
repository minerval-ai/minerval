/**
 * Allocation transparency (§15): why the graph's attention is going where
 * it is going. Public and read-only, like claim reads — the allocation
 * engine is only trustworthy if anyone can inspect it.
 *
 *   GET /queue — the candidate set with the engine's actual bookkeeping:
 *     each claim's expected-value inputs, the expected cost of its pass,
 *     the allocations already backing it, and what remains before it is
 *     covered and runs. The rule is uniform for every funder: an action
 *     runs exactly when allocations cover its cost, and costs split pro
 *     rata among its funders. Minerval's own General assessment mandate
 *     allocates through this same engine, paced by its daily rate; its
 *     budget and today's placements are shown alongside.
 */
import type { FastifyInstance } from "fastify";
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { stewardQueueHealth } from "../workers/steward-pipeline.js";
import { stewardTierCostEstimates } from "../services/cost-estimate-service.js";
import {
  getEffectiveAllocationPolicy,
  getGeneralMandate,
} from "../services/allocation-policy-service.js";
import { microUsdToOwls } from "../services/owl.js";

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: number } }>("/", {
    schema: {
      tags: ["queue"],
      summary:
        "The allocation engine's candidate set: value inputs, cost " +
        "estimates, allocations, and coverage per claim",
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
      const [health, tierCosts, policy, mandate, rows] = await Promise.all([
        stewardQueueHealth(),
        stewardTierCostEstimates(),
        getEffectiveAllocationPolicy(),
        getGeneralMandate(),
        rawQuery<{
          id: string;
          text: string;
          queue_priority: number;
          importance: number;
          contestation: number | null;
          created_by: string;
          marginal_yield: number | null;
          assessed_at: Date | null;
          backing_micro: number;
        }>(
          `SELECT c.id, c.text, c.queue_priority, c.importance,
                  c.contestation, c.created_by,
                  a.marginal_yield, a.assessed_at,
                  COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                              FROM action_allocations al
                             WHERE al.claim_id = c.id AND al.action = 'assess'),
                           0) AS backing_micro
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
      const strongMin = policy.strong_min_value;
      const costMicroFor = (value: number): number =>
        strongConfigured && value >= strongMin
          ? tierCosts.strongMicroUsd
          : tierCosts.standardMicroUsd;

      let placedTodayMicro = 0;
      if (mandate) {
        const [today] = await rawQuery<{ placed: number }>(
          `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS placed
             FROM action_allocations
            WHERE grant_id = $1 AND created_at >= date_trunc('day', now())`,
          [mandate.grantId]
        );
        placedTodayMicro = Number(today?.placed ?? 0);
      }

      const pending = rows
        .map((r) => {
          const costMicro = costMicroFor(r.queue_priority);
          const backingMicro = Number(r.backing_micro);
          const costOwls = microUsdToOwls(costMicro);
          return {
            claim_id: r.id,
            text: r.text,
            expected_value: r.queue_priority,
            expected_cost_owls: costOwls,
            allocated_owls: microUsdToOwls(backingMicro),
            remaining_owls: microUsdToOwls(
              Math.max(0, costMicro - backingMicro)
            ),
            covered: backingMicro >= costMicro,
            value_per_owl:
              costOwls > 0
                ? Math.round((r.queue_priority / costOwls) * 100) / 100
                : null,
            inputs: {
              importance: r.importance,
              // Unassessed claims carry maximal expected gain by convention.
              marginal_yield: r.marginal_yield ?? (r.assessed_at ? null : 1),
              contestation: r.contestation,
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
        // Covered actions run next; then the engine's value-per-dollar view.
        .sort(
          (a, b) =>
            Number(b.covered) - Number(a.covered) ||
            (b.value_per_owl ?? 0) - (a.value_per_owl ?? 0)
        );

      return reply.send({
        depth: health,
        // The knobs in effect — the governing mandate's allocation policy
        // (config defaults underneath), so the numbers are reproducible.
        formula: {
          contestation_floor: policy.contestation_floor,
          staleness_saturation_days: policy.staleness_saturation_days,
          user_provenance_boost: policy.user_provenance_boost,
        },
        cost_estimates: {
          standard_owls: microUsdToOwls(tierCosts.standardMicroUsd),
          strong_owls: microUsdToOwls(tierCosts.strongMicroUsd),
          strong_min_value: strongConfigured ? strongMin : null,
        },
        general_mandate: mandate
          ? {
              grant_id: mandate.grantId,
              daily_rate_owls: microUsdToOwls(mandate.dailyBudgetMicroUsd),
              allocated_today_owls: microUsdToOwls(placedTodayMicro),
            }
          : null,
        pending,
      });
    },
  });
}
