/**
 * Grant routes — the grantmaker console's API.
 *
 *   POST /grants             — service-only direct mandate creation. People
 *     create grants through the granting CONVERSATION
 *     (/grant-conversations): the Grantmaker agent designs the mandate,
 *     quotes its cost, and holds the authority to refuse it. This endpoint
 *     remains for operator tooling and seeding.
 *   GET  /grants             — the acting user's grants.
 *   GET  /grants/:id         — dashboard payload: spend, plan, progress, the
 *     assessments the grant funded.
 *   POST /grants/:id/approve — approve the plan the mandate's Grantmaker proposed.
 *   POST /grants/:id/topup   — add budget (delegates to the budget job).
 *   POST /grants/:id/cancel  — stop the mandate, refund unspent budget.
 */
import type { FastifyInstance } from "fastify";
import {
  createGrant,
  approveGrantPlan,
  cancelGrant,
  listGrants,
  getGrant,
  serializeGrant,
  serializeGrantRow,
  GRANT_POLICIES,
} from "../services/grant-service.js";
import { DETAIL_QUERY_PROPERTIES, type DetailOptions } from "../services/read-detail.js";
import { topUpBudgetJob } from "../services/budget-job-service.js";
import { microUsdToOwls } from "../services/owl.js";
import { isDirectService } from "../server/plugins/auth.js";
import { requirePermission } from "../server/require-permission.js";

export async function grantRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      name: string;
      policy: string;
      budget_owls: number;
      scope_claim_id?: string;
      scope_query?: string;
    };
  }>("/", {
    schema: {
      tags: ["grants"],
      summary:
        "Create and fund a mandate directly (service callers only; people " +
        "use the granting conversation)",
      body: {
        type: "object",
        required: ["name", "policy", "budget_owls"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          policy: { type: "string", enum: [...GRANT_POLICIES] },
          budget_owls: { type: "number", exclusiveMinimum: 0, maximum: 10000 },
          scope_claim_id: { type: "string", format: "uuid" },
          scope_query: { type: "string", maxLength: 500 },
        },
      },
    },
    // Creating a mandate this way both opens it and funds it, so in a
    // members-only deployment it takes both permissions.
    preHandler: [
      app.authenticate,
      app.requireUser,
      requirePermission("direct"),
      requirePermission("fund"),
    ],
    handler: async (request, reply) => {
      if (!isDirectService(request.auth)) {
        return reply.code(403).send({
          error:
            "Grants are created in a granting conversation " +
            "(POST /grant-conversations), not by direct form submission",
          code: "USE_CONVERSATION",
        });
      }
      const result = await createGrant({
        funderUserId: request.auth!.userId!,
        name: request.body.name,
        policy: request.body.policy,
        budgetOwls: request.body.budget_owls,
        scopeClaimId: request.body.scope_claim_id ?? null,
        scopeQuery: request.body.scope_query ?? null,
      });
      if (!result.ok) {
        const status =
          result.code === "INSUFFICIENT_OWLS"
            ? 402
            : result.code === "CLAIM_NOT_FOUND"
              ? 404
              : 400;
        return reply
          .code(status)
          .send({ error: result.message, code: result.code });
      }
      return reply.code(201).send({ grant: await serializeGrant(result.grant) });
    },
  });

  app.get<{ Querystring: { status?: string; offset?: number; limit?: number } }>("/", {
    schema: {
      tags: ["grants"],
      summary: "List the authenticated user's grants, newest first",
      description:
        "One short row per grant: id, title, status, budget, spent and held owls, how many " +
        "items its plan has, page_url (its public page) and funder_url (your page for it, " +
        "with its Grantmaker). get_grant reads one whole. `total` counts every grant that " +
        "matches `status`.",
      querystring: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["planning", "pending_approval", "active", "completed", "cancelled"],
            description: "Only grants in this state.",
          },
          offset: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const page = await listGrants(request.auth!.userId!, {
        status: request.query.status,
        offset: request.query.offset,
        limit: request.query.limit,
      });
      return reply.send({
        grants: await Promise.all(page.rows.map((g) => serializeGrantRow(g))),
        total: page.total,
      });
    },
  });

  app.get<{ Params: { id: string }; Querystring: DetailOptions }>("/:id", {
    schema: {
      tags: ["grants"],
      summary: "Get one grant with live spend, plan, and funded assessments",
      description:
        "Carries page_url (the mandate's public page) and funder_url (your page for it, with " +
        "its Grantmaker). By default a summary: the plan's items a page at a time, each with " +
        "its index, state, and who added it and when (added_by, added_at), plan_item_counts " +
        "for the whole plan, the funded assessments cut to list_limit, and `collections` " +
        "giving each list's whole length; detail=full for everything. spent_owls and " +
        "held_owls are counted as get_mandate counts them.",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
      querystring: {
        type: "object",
        properties: DETAIL_QUERY_PROPERTIES,
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const grant = await getGrant(request.params.id);
      if (!grant || grant.funderUserId !== request.auth!.userId!) {
        return reply
          .code(404)
          .send({ error: "Grant not found", code: "NOT_FOUND" });
      }
      return reply.send({ grant: await serializeGrant(grant, request.query) });
    },
  });

  app.post<{ Params: { id: string } }>("/:id/approve", {
    schema: {
      tags: ["grants"],
      summary: "Approve the plan the mandate's Grantmaker proposed (the grant starts executing)",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission("direct")],
    handler: async (request, reply) => {
      const result = await approveGrantPlan({
        grantId: request.params.id,
        funderUserId: request.auth!.userId!,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 409)
          .send({ error: result.message, code: result.code });
      }
      return reply.send({ grant: await serializeGrant(result.grant) });
    },
  });

  app.post<{ Params: { id: string }; Body: { owls: number } }>("/:id/topup", {
    schema: {
      tags: ["grants"],
      summary: "Add owls to a grant's budget (a paused grant resumes)",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
      body: {
        type: "object",
        required: ["owls"],
        properties: { owls: { type: "number", exclusiveMinimum: 0 } },
      },
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission("fund")],
    handler: async (request, reply) => {
      const grant = await getGrant(request.params.id);
      if (!grant || grant.funderUserId !== request.auth!.userId!) {
        return reply
          .code(404)
          .send({ error: "Grant not found", code: "NOT_FOUND" });
      }
      const result = await topUpBudgetJob({
        jobId: grant.budgetJobId,
        userId: request.auth!.userId!,
        owls: request.body.owls,
      });
      if (!result.ok) {
        const status =
          result.code === "NOT_FOUND"
            ? 404
            : result.code === "INSUFFICIENT_OWLS"
              ? 402
              : 409;
        return reply
          .code(status)
          .send({ error: result.message, code: result.code });
      }
      return reply.send({ grant: await serializeGrant(grant) });
    },
  });

  app.post<{ Params: { id: string } }>("/:id/cancel", {
    schema: {
      tags: ["grants"],
      summary: "Cancel a grant and refund its unspent budget",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const result = await cancelGrant({
        grantId: request.params.id,
        funderUserId: request.auth!.userId!,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 409)
          .send({ error: result.message, code: result.code });
      }
      return reply.send({
        cancelled: true,
        refunded_owls: microUsdToOwls(result.refundedMicroUsd),
      });
    },
  });
}
