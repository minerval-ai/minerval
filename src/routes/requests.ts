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
import { microUsdToOwls } from "../services/owl.js";
import { requirePermission } from "../server/require-permission.js";
import { DECLINE_REASONS, TakeUpError, declineTakenUpRequest, takeUpRequest } from "../services/request-take-up-service.js";

const listRequestsParams = z.object({
  // One state, or "live" for every request still open to work.
  state: z.enum([...REQUEST_STATES, "live"]).optional(),
  claim_id: z.guid().optional(),
  source_id: z.guid().optional(),
  keeper: z.enum(["curator", "steward"]).optional(),
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
          // The agent run that did the work, for GET /runs/:run_id.
          run_id: { type: "string", format: "uuid", nullable: true },
          // On a run of the full work: what it was funded at and what the
          // work was quoted at then; funding says so when it was below.
          budget_usd: { type: "number", nullable: true },
          quote_usd: { type: "number", nullable: true },
          funding: { type: "string", nullable: true },
        },
      },
    },
    // Where a deployment has more than one label, or mirrors the public
    // graph: the request this one was taken up from, and the requests at
    // labels the reader reads that took this one up
    // (services/request-adoption-service.ts). Absent otherwise.
    taken_up_from: {
      type: "object",
      properties: {
        request_id: { type: "string", format: "uuid" },
        label: { type: "string" },
        public_request_id: { type: "string", format: "uuid" },
      },
    },
    // That work at a label the reader may not read took the request up, as it came through the gate
    // (docs/the-gate.md). Absent where nothing came.
    taken_up_above: {
      type: "object",
      properties: { said_at: { type: "string" }, answer: { type: "string" }, answer_source_id: { type: "string", format: "uuid" } },
    },
    taken_up_at: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          request_id: { type: "string", format: "uuid" },
          state: { type: "string" },
        },
      },
    },
    // Accounts that have said they are taking the request up, and what followed.
    taken_up: {
      type: "array",
      items: {
        type: "object",
        properties: {
          by: { type: "string" },
          account_id: { type: "string", format: "uuid" },
          at: { type: "string", format: "date-time" },
          followed: { type: "string" },
          in_words: { type: "string" },
          published_page_id: { type: "string", format: "uuid", nullable: true },
          node_id: { type: "string", format: "uuid", nullable: true },
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
            source_id: { type: "string", format: "uuid", description: "Only requests bearing on this document" },
            keeper: {
              type: "string",
              enum: ["curator", "steward"],
              description:
                "Who keeps it: the Curator (requests bearing on several nodes or on none) or a node's Steward",
            },
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
          sourceId: params.source_id,
          keeper: params.keeper,
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

  // POST /requests/:request_id/contribute — commission the work on a
  // request whole (its scoping pass while it has no budget, else the full
  // work), at the budget the reader chooses. The Researcher takes it up at
  // once; unspent money comes back when the run settles or the request closes.
  app.post<{ Params: { request_id: string }; Body: { owls: number } }>(
    "/:request_id/contribute",
    {
      schema: {
        tags: ["requests"],
        summary:
          "Commission the work on this request with a budget of owls: it runs at " +
          "once, and what it does not spend comes back. The run works to the budget you give, " +
          "not to the request's quote (budget_usd): a budget below the quote is accepted, the " +
          "response says so (below_quote, note), and the run does only part of the work and is " +
          "marked on the request's work log as funded below its quote",
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
      preHandler: [app.authenticate, app.requireUser, requirePermission("fund")],
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
          // The full work's quote, and whether this budget is below it (#885).
          ...(result.quote
            ? {
                quote_owls: microUsdToOwls(result.quote.quoteMicroUsd),
                below_quote: result.quote.underQuote,
                note: result.quote.note,
              }
            : {}),
        });
      },
    }
  );

  // POST /requests/:request_id/take-up: an account says, on the request's
  // record, that it is taking the request up (request-take-up-service.ts).
  app.post<{ Params: { request_id: string } }>("/:request_id/take-up", {
    schema: {
      tags: ["requests"],
      summary: "Say on a request's record, under your account's name, that you are taking the request up",
      description:
        "A request may be addressed to whoever holds the evidence, and what becomes of it is part of its record. Any account may say it is taking a " +
        "request up. The statement is public at once, in fixed words with your account's name and the date. It commits you to doing the work well, " +
        "not to a result, and it funds nothing: the work is still paid for like any work. The record then shows what followed, read from the graph " +
        "and not from you: a page your account publishes on a node the request bears on, your own later statement that you will not do the work, or " +
        "nothing yet, with how long. The statement stays on the record.",
      params: { type: "object", required: ["request_id"], properties: { request_id: { type: "string", format: "uuid" } } },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      try {
        const result = await takeUpRequest({ requestId: request.params.request_id, accountId: request.auth!.userId! });
        return reply.code(result.already ? 200 : 201).send(result);
      } catch (err) {
        if (err instanceof TakeUpError) {
          return reply.code(err.code === "REQUEST_NOT_FOUND" ? 404 : 409).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    },
  });

  app.post<{ Params: { request_id: string }; Body: { reason: string } }>("/:request_id/take-up/decline", {
    schema: {
      tags: ["requests"],
      summary: "Say on a request's record that you will not do the work you took up, with a reason from a fixed list",
      description:
        "A refusal is a complete answer to a request and part of its record. The reason is one of: " +
        Object.entries(DECLINE_REASONS).map(([k, v]) => `${k} (${v})`).join("; ") +
        ". It is your own statement and nobody checks it. That you took the request up, and when, stays on the record.",
      params: { type: "object", required: ["request_id"], properties: { request_id: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["reason"], properties: { reason: { type: "string", enum: Object.keys(DECLINE_REASONS) } } },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      try {
        return reply.send(await declineTakenUpRequest({ requestId: request.params.request_id, accountId: request.auth!.userId!, reason: request.body.reason }));
      } catch (err) {
        if (err instanceof TakeUpError) return reply.code(409).send({ error: err.message, code: err.code });
        throw err;
      }
    },
  });
}
