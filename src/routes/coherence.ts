/**
 * /coherence (#330, Phase 0): the mechanical coherence pre-filter, read-only.
 *
 * What an operator watches before the Consistency Checker agent exists, and
 * what the agent's sweeps will read once it does: how often each kind of
 * mechanically suspect pair occurs on the live graph, and the shortlist
 * itself, importance first. Nothing here is a verdict (services/
 * coherence-service.ts); it is where to look.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  COHERENCE_KINDS,
  COHERENCE_THRESHOLDS,
  coherenceStats,
  listCoherenceCandidates,
} from "../services/coherence-service.js";
import { resolveTagBySlug } from "../services/tag-service.js";

const coherenceParams = z.object({
  // Restrict to tensions touching a claim carrying this tag (by slug).
  tag: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ENDPOINT_SCHEMA = {
  type: "object",
  properties: {
    claim_id: { type: "string", format: "uuid" },
    text: { type: "string" },
    status: { type: "string" },
    credence: { type: "number", nullable: true },
    assessed_at: { type: "string" },
  },
} as const;

export async function coherenceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Record<string, string> }>(
    "/",
    {
      schema: {
        tags: ["coherence"],
        summary:
          "Mechanically suspect assessment pairs along the graph's edges: " +
          "counts by kind and the shortlist, most important first (#330)",
        querystring: {
          type: "object",
          properties: {
            tag: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              scope: {
                type: "object",
                properties: {
                  tag: { type: "string", nullable: true },
                },
              },
              thresholds: {
                type: "object",
                properties: {
                  requiresMargin: { type: "number" },
                  highCredence: { type: "number" },
                  rivalTolerance: { type: "number" },
                },
              },
              kinds: { type: "array", items: { type: "string" } },
              stats: {
                type: "object",
                properties: {
                  assessed_claims: { type: "integer" },
                  assessed_edges: { type: "integer" },
                  distinct_primaries: { type: "integer" },
                  counts: { type: "object", additionalProperties: { type: "integer" } },
                },
              },
              candidates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string" },
                    primary_claim_id: { type: "string", format: "uuid" },
                    claim_ids: { type: "array", items: { type: "string", format: "uuid" } },
                    importance: { type: "number" },
                    relation: { type: "string" },
                    primary: ENDPOINT_SCHEMA,
                    other: ENDPOINT_SCHEMA,
                    neighbor_status_then: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const params = coherenceParams.parse(request.query);
      let tagId: string | null = null;
      if (params.tag) {
        const tag = await resolveTagBySlug(params.tag);
        if (!tag) {
          return reply.status(404).send({ error: `No tag "${params.tag}"` });
        }
        tagId = tag.id;
      }
      const scope = { tagId };
      const [stats, candidates] = await Promise.all([
        coherenceStats(scope),
        listCoherenceCandidates(scope, { limit: params.limit, offset: params.offset }),
      ]);
      return reply.send({
        scope: { tag: params.tag ?? null },
        thresholds: COHERENCE_THRESHOLDS,
        kinds: COHERENCE_KINDS,
        stats,
        candidates,
      });
    }
  );
}
