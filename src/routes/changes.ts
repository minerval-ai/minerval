/**
 * GET /changes — the change stream (services/graph-change-service.ts; #562
 * first slice, #563). A public read like GET /queue: what changed in the
 * graph, oldest first, from a cursor, narrowed to part of the graph. MCP
 * serves the same read natively as `list_graph_changes`, and the graph's own
 * Correspondents read it through the same function.
 */
import type { FastifyInstance } from "fastify";
import { graphChangeDefinition, runGraphChanges } from "../services/graph-change-service.js";

export async function changeRoutes(app: FastifyInstance): Promise<void> {
  const def = graphChangeDefinition("caller");
  // A querystring carries arrays as repeated keys (?under=a&under=b) or one
  // comma-separated value; both are accepted.
  const props = def.input_schema.properties as Record<string, Record<string, unknown>>;
  const querystring = {
    type: "object",
    properties: {
      ...props,
      under: { anyOf: [props.under, { type: "string" }] },
      tags: { anyOf: [props.tags, { type: "string" }] },
    },
  };
  const list = (v: unknown): string[] | undefined =>
    v === undefined
      ? undefined
      : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);

  app.get("/", {
    schema: {
      tags: ["changes"],
      summary: def.description,
      querystring,
    },
    handler: async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const result = await runGraphChanges({ ...q, under: list(q.under), tags: list(q.tags) });
      if (!result.ok) {
        return reply.code(400).send({ error: { code: result.code, message: result.message, request_id: request.id } });
      }
      return reply.send(result.payload);
    },
  });
}
