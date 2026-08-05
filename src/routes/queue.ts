/**
 * Queue transparency (§15): why the background lane is doing what it's
 * doing. Public and read-only, like claim reads — the allocation mechanism
 * is only trustworthy if anyone can inspect it.
 *
 *   GET /queue — queue depth by state and the top of the pending lane, each
 *     claim with its composite priority BROKEN INTO ITS INPUTS (importance,
 *     expected yield, contestation, stakes, staleness, provenance), so
 *     "why is this claim ahead of that one" is always answerable.
 */
import type { FastifyInstance } from "fastify";
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { stewardQueueHealth } from "../workers/steward-pipeline.js";

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: number } }>("/", {
    schema: {
      tags: ["queue"],
      summary:
        "The background assessment queue: depth by state and the top " +
        "pending claims with their priority inputs",
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
      const [health, rows] = await Promise.all([
        stewardQueueHealth(),
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

      return reply.send({
        depth: health,
        // The weights in effect, so the numbers below are reproducible.
        weights: {
          yield: config.priorityYieldWeight,
          contestation: config.priorityContestationWeight,
          stake: config.priorityStakeWeight,
          stake_saturation_owls: config.priorityStakeSaturationOwls,
          staleness: config.priorityStalenessWeight,
          staleness_saturation_days: config.priorityStalenessSaturationDays,
          user_provenance_boost: config.priorityUserProvenanceBoost,
        },
        pending: rows.map((r) => ({
          claim_id: r.id,
          text: r.text,
          queue_priority: r.queue_priority,
          inputs: {
            importance: r.importance,
            // Unassessed claims carry maximal expected yield by convention.
            marginal_yield: r.marginal_yield ?? (r.assessed_at ? null : 1),
            contestation: r.contestation,
            stake_owls:
              Math.round(
                (Number(r.stake_micro) / config.owlPriceMicroUsd) * 1000
              ) / 1000,
            days_since_assessed: r.assessed_at
              ? Math.floor(
                  (Date.now() - new Date(r.assessed_at).getTime()) / 86_400_000
                )
              : null,
            user_proposed: r.created_by === "user",
          },
        })),
      });
    },
  });
}
