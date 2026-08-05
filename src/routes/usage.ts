/**
 * Usage routes (#70): the queryable face of the per-token meter.
 * Per-user summaries power the dashboard; the system aggregate powers ops.
 */
import type { FastifyInstance } from "fastify";
import {
  getUsageSummary,
  getSystemUsageSummary,
  type UsageTotals,
} from "../services/usage-service.js";
import {
  getEntitlement,
  serializeEntitlement,
} from "../services/billing-service.js";

function serializeTotals(t: UsageTotals) {
  return {
    calls: t.calls,
    input_tokens: t.inputTokens,
    output_tokens: t.outputTokens,
    cache_read_tokens: t.cacheReadTokens,
    cache_creation_tokens: t.cacheCreationTokens,
    cost_micro_usd: t.costMicroUsd,
  };
}

function parseDays(raw: unknown): number {
  const n = Number(raw ?? 30);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  // GET /usage — the acting user's metered usage: totals, per-day, per-key,
  // per-agent, plus the current entitlement.
  app.get("/", {
    schema: {
      tags: ["usage"],
      summary: "Usage summary for the authenticated user",
      querystring: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const userId = request.auth!.userId!;
      const days = parseDays((request.query as { days?: number }).days);
      const [summary, entitlement] = await Promise.all([
        getUsageSummary(userId, days),
        getEntitlement(userId),
      ]);
      return reply.send({
        days,
        totals: serializeTotals(summary.totals),
        by_day: summary.byDay.map((d) => ({
          date: d.date,
          ...serializeTotals(d),
        })),
        by_key: summary.byKey.map((k) => ({
          api_key_id: k.apiKeyId,
          key_name: k.keyName,
          ...serializeTotals(k),
        })),
        by_agent: summary.byAgent.map((a) => ({
          agent: a.agent,
          ...serializeTotals(a),
        })),
        entitlement: serializeEntitlement(entitlement),
      });
    },
  });

  // GET /usage/system — ops aggregate across all users (service keys only):
  // total vs system-attributed spend, per-agent breakdown, top spenders.
  app.get("/system", {
    schema: {
      tags: ["usage"],
      summary: "Aggregate usage across all users (service keys only)",
      querystring: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireService],
    handler: async (request, reply) => {
      const days = parseDays((request.query as { days?: number }).days);
      const summary = await getSystemUsageSummary(days);
      return reply.send({
        days,
        totals: serializeTotals(summary.totals),
        system: serializeTotals(summary.system),
        by_agent: summary.byAgent.map((a) => ({
          agent: a.agent,
          ...serializeTotals(a),
        })),
        top_users: summary.topUsers.map((u) => ({
          user_id: u.userId,
          ...serializeTotals(u),
        })),
      });
    },
  });
}
