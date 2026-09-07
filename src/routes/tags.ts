/**
 * /tags (#272): the graph's topical vocabulary, read-only and public.
 *
 * The vocabulary is navigation: a reader lands on a topic and follows it
 * into the filtered claim list (GET /claims?tag=…), an agent or an MCP
 * client asks what topics the graph holds before searching. Writes to the
 * vocabulary go through the tagger and the operator script (scripts/
 * tags.ts), not this surface: a public write to a shared vocabulary would
 * be a contribution, and contributions have a review pipeline.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listTags, resolveTagBySlug, searchTags } from "../services/tag-service.js";

const listTagsParams = z.object({
  // A substring of the name or slug (list), or a free-text topic (search).
  q: z.string().max(200).optional(),
  // "search" ranks by meaning (an embedding call); "list" is usage order.
  mode: z.enum(["list", "search"]).default("list"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // Tags no active claim carries yet (freshly minted, or emptied by merges).
  include_unused: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
});

const TAG_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    slug: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    claim_count: { type: "integer" },
    // Only in search mode: cosine similarity of the tag to the query.
    similarity: { type: "number", nullable: true },
  },
} as const;

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Record<string, string> }>(
    "/",
    {
      schema: {
        tags: ["tags"],
        summary: "The topic vocabulary: tags with how many claims carry each",
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            mode: { type: "string", enum: ["list", "search"], default: "list" },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            include_unused: { type: "boolean", default: false },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { tags: { type: "array", items: TAG_SCHEMA } },
          },
        },
      },
      handler: async (request, reply) => {
        const params = listTagsParams.parse(request.query);
        if (params.mode === "search" && params.q?.trim()) {
          const hits = await searchTags(params.q, { limit: Math.min(50, params.limit) });
          return reply.send({
            tags: hits.map((h) => ({
              id: h.id,
              slug: h.slug,
              name: h.name,
              description: h.description,
              claim_count: h.claim_count,
              similarity: h.similarity,
            })),
          });
        }
        const tags = await listTags({
          q: params.q,
          limit: params.limit,
          includeUnused: params.include_unused,
        });
        return reply.send({
          tags: tags.map((t) => ({
            id: t.id,
            slug: t.slug,
            name: t.name,
            description: t.description,
            claim_count: t.claim_count,
            similarity: null,
          })),
        });
      },
    }
  );

  // GET /tags/:slug — one tag. A merged tag's slug resolves to its survivor,
  // so old links keep working; the response says which slug is canonical.
  app.get<{ Params: { slug: string } }>(
    "/:slug",
    {
      schema: {
        tags: ["tags"],
        summary: "One tag by slug (a merged slug resolves to its survivor)",
        params: { type: "object", properties: { slug: { type: "string" } } },
        response: {
          200: {
            type: "object",
            properties: {
              tag: {
                type: "object",
                properties: {
                  ...TAG_SCHEMA.properties,
                  status: { type: "string" },
                  created_by: { type: "string" },
                  created_at: { type: "string", format: "date-time" },
                },
              },
              // The slug the request used, when it was a merged alias.
              requested_slug: { type: "string", nullable: true },
            },
          },
          404: {
            type: "object",
            properties: {
              error: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                  request_id: { type: "string" },
                },
              },
            },
          },
        },
      },
      handler: async (request, reply) => {
        const tag = await resolveTagBySlug(request.params.slug);
        if (!tag) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Tag not found", request_id: request.id },
          });
        }
        const [withCount] = await listTags({ q: tag.slug, limit: 50, includeUnused: true }).then(
          (rows) => rows.filter((r) => r.id === tag.id)
        );
        return reply.send({
          tag: {
            id: tag.id,
            slug: tag.slug,
            name: tag.name,
            description: tag.description,
            claim_count: withCount?.claim_count ?? 0,
            similarity: null,
            status: tag.status,
            created_by: tag.created_by,
            created_at: tag.created_at,
          },
          requested_slug: tag.slug === request.params.slug ? null : request.params.slug,
        });
      },
    }
  );
}
