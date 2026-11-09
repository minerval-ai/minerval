/**
 * /arguments (#541): an argument as the graph records it, read-only and
 * public, like a claim. The same view serves get_argument for the graph's
 * own agents and for MCP (services/argument-view-service.ts).
 */
import type { FastifyInstance } from "fastify";
import {
  ARGUMENT_VIEW_INCLUDES,
  DEFAULT_INSTANCES_PAGE,
  MAX_INSTANCES_PAGE,
  getArgumentView,
} from "../services/argument-view-service.js";

export async function argumentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { argument_id: string };
    Querystring: { include?: string | string[]; instances_limit?: number; instances_offset?: number };
  }>(
    "/:argument_id",
    {
      schema: {
        tags: ["arguments"],
        summary: "Get an argument: its conclusion, written form, and, on request, its evaluation, premises and instances",
        params: {
          type: "object",
          properties: { argument_id: { type: "string", format: "uuid" } },
          required: ["argument_id"],
        },
        querystring: {
          type: "object",
          properties: {
            include: {
              anyOf: [
                { type: "string", enum: [...ARGUMENT_VIEW_INCLUDES] },
                { type: "array", items: { type: "string", enum: [...ARGUMENT_VIEW_INCLUDES] } },
              ],
              description: "Sections to add: evaluation, premises, instances (repeat, or comma-separate).",
            },
            instances_limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_INSTANCES_PAGE,
              default: DEFAULT_INSTANCES_PAGE,
            },
            instances_offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const raw = request.query.include;
      const include = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((v) => v.split(",")).map((v) => v.trim());
      const view = await getArgumentView(request.params.argument_id, {
        include,
        instancesLimit: request.query.instances_limit,
        instancesOffset: request.query.instances_offset,
      });
      if (!view) return reply.code(404).send({ error: "Argument not found" });
      return reply.send(view);
    }
  );
}
