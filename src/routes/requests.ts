/**
 * /requests (constitution Part VIII, Requests): what someone could do that
 * would improve what the graph knows, public to read. Requests are filed
 * and kept by administrators through their tools; a contributor files one
 * as a contribution. A mandate's request is shown as filed by "a funded
 * mandate", never by name (§12/§19). The work on a request is a row on the
 * action ledger, and anyone may put owls toward it (POST /:id/contribute).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REQUEST_STATES } from "../schemas/kinds.js";
import { getRequest, listRequests } from "../services/request-service.js";
import { allocateToRequest } from "../services/allocation-service.js";

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
    budget_usd: { type: "number", nullable: true },
    ledger: {
      type: "object",
      nullable: true,
      properties: {
        action_id: { type: "string", format: "uuid" },
        variant: { type: "string", enum: ["scope", "full"] },
        status: { type: "string", enum: ["open", "running"] },
        cost_usd: { type: "number" },
        backing_usd: { type: "number" },
      },
    },
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
              description:
                "Search what requests ask and why, by meaning and by keyword (web-search syntax); ranks by meaning",
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

  // POST /requests/:request_id/contribute — put owls toward the work on a
  // request: its scoping pass while it has no budget, else the full work.
  // Allocations accumulate across funders (people and mandates alike); the
  // moment they cover the row's cost, the Researcher takes it up, and the
  // metered cost is split pro rata among the funders. Unspent money comes
  // back when the run settles or the request closes.
  app.post<{ Params: { request_id: string }; Body: { owls: number } }>(
    "/:request_id/contribute",
    {
      schema: {
        tags: ["requests"],
        summary:
          "Allocate owls toward the work on this request (runs when " +
          "allocations cover the cost; funders split the cost pro rata)",
        params: {
          type: "object",
          properties: { request_id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["owls"],
          properties: { owls: { type: "number", exclusiveMinimum: 0 } },
        },
      },
      preHandler: [app.authenticate, app.requireUser],
      handler: async (request, reply) => {
        const result = await allocateToRequest({
          userId: request.auth!.userId!,
          requestId: request.params.request_id,
          owls: request.body.owls,
        });
        if (!result.ok) {
          const status =
            result.code === "REQUEST_NOT_FOUND"
              ? 404
              : result.code === "INSUFFICIENT_OWLS"
                ? 402
                : result.code === "COVERED" || result.code === "CLOSED"
                  ? 409
                  : 400;
          return reply.code(status).send({ error: result.message, code: result.code });
        }
        return reply.send({
          allocated_owls: result.allocatedOwls,
          backing_owls: result.backingOwls,
          variant: result.variant,
          covered: result.covered,
        });
      },
    }
  );
}
