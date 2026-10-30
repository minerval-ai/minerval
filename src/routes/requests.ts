/**
 * /requests (constitution Part VIII, Requests): what someone could do that
 * would improve what the graph knows, read-only and public. Requests are
 * filed and kept by administrators through their tools; a contributor files
 * one as a contribution. A mandate's request is shown as filed by "a funded
 * mandate", never by name (§12/§19).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REQUEST_STATES } from "../schemas/kinds.js";
import { getRequest, listRequests } from "../services/request-service.js";

const listRequestsParams = z.object({
  // One state, or "live" for every request still open to work.
  state: z.enum([...REQUEST_STATES, "live"]).optional(),
  claim_id: z.guid().optional(),
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const nodeRef = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    text: { type: "string" },
    kind: { type: "string" },
  },
} as const;

export const REQUEST_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    ask: { type: "string" },
    why: { type: "string" },
    satisfied_by: { type: "string" },
    who_could: { type: "string", nullable: true },
    addressed_to: { type: "string", nullable: true },
    bears_on: { type: "array", items: nodeRef },
    bears_on_sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string" },
          url: { type: "string", nullable: true },
        },
      },
    },
    bears_on_text: { type: "string", nullable: true },
    filed_by: {
      type: "object",
      properties: { kind: { type: "string" }, label: { type: "string" } },
    },
    keeper: {
      type: "object",
      properties: { kind: { type: "string" }, label: { type: "string" } },
    },
    state: { type: "string" },
    state_note: { type: "string", nullable: true },
    filed_at: { type: "string", format: "date-time" },
    work: {
      type: "array",
      items: {
        type: "object",
        properties: {
          by: { type: "string" },
          outcome: { type: "string", nullable: true },
          summary: { type: "string" },
          at: { type: "string", format: "date-time" },
          funded_by: { type: "string", nullable: true },
        },
      },
    },
  },
} as const;

const notFound = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
} as const;

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Record<string, string> }>(
    "/",
    {
      schema: {
        tags: ["requests"],
        summary: "Requests: what could be done that would improve what the graph knows",
        querystring: {
          type: "object",
          properties: {
            state: { type: "string", enum: [...REQUEST_STATES, "live"] },
            claim_id: { type: "string", format: "uuid" },
            q: {
              type: "string",
              maxLength: 500,
              description: "Words to look for in what a request asks, why, and what would satisfy it; ranks by match",
            },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              requests: { type: "array", items: REQUEST_SCHEMA },
              total: { type: "integer" },
            },
          },
        },
      },
      handler: async (request, reply) => {
        const params = listRequestsParams.parse(request.query);
        const { items, total } = await listRequests({
          state: params.state === "live" ? undefined : params.state,
          live: params.state === "live",
          claimId: params.claim_id,
          q: params.q,
          limit: params.limit,
          offset: params.offset,
        });
        return reply.send({ requests: items, total });
      },
    }
  );

  app.get<{ Params: { request_id: string } }>(
    "/:request_id",
    {
      schema: {
        tags: ["requests"],
        summary: "One request, with the work done on it",
        params: {
          type: "object",
          properties: { request_id: { type: "string", format: "uuid" } },
        },
        response: { 200: REQUEST_SCHEMA, 404: notFound },
      },
      handler: async (request, reply) => {
        const found = await getRequest(request.params.request_id);
        if (!found) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Request not found" },
          });
        }
        return reply.send(found);
      },
    }
  );
}
