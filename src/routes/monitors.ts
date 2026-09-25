/**
 * Production monitors (#334 S9): the read face of monitor-service.ts.
 * Public reads like GET /queue — every number here is derived from the
 * graph's own record and is safe to show; nothing on this surface changes
 * anything. docs/monitors.md explains each signal and carries its SQL.
 */
import type { FastifyInstance } from "fastify";
import {
  MONITOR_SIGNALS,
  defaultThresholds,
  overview,
  signalReport,
  type MonitorSignal,
} from "../services/monitor-service.js";

export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", {
    schema: {
      tags: ["monitors"],
      summary:
        "Production monitors overview: candidate detectors (performed settling, empty chairs), " +
        "overturn-rate discrimination, evidence monotonicity, cascade and queue health, agent rollups",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
    },
    handler: async (request, reply) => {
      const q = request.query as { limit?: number };
      const t = defaultThresholds(q.limit ? { limit: q.limit } : {});
      return reply.send(await overview(t));
    },
  });

  app.get("/:signal", {
    schema: {
      tags: ["monitors"],
      summary: "One monitor signal's report",
      params: {
        type: "object",
        properties: { signal: { type: "string", enum: [...MONITOR_SIGNALS] } },
        required: ["signal"],
      },
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
    },
    handler: async (request, reply) => {
      const { signal } = request.params as { signal: MonitorSignal };
      const q = request.query as { limit?: number };
      const t = defaultThresholds(q.limit ? { limit: q.limit } : {});
      return reply.send(await signalReport(signal, t));
    },
  });
}
