/**
 * Assessment-order routes — the user's view of the express lane.
 *
 *   GET    /orders      — the acting user's orders, newest first.
 *   GET    /orders/:id  — one order (poll target for the claim page).
 *   DELETE /orders/:id  — cancel while pending. Free unless a transient
 *     retry had already charged it, in which case the charge refunds.
 *
 * Order CREATION is claim-scoped: POST /claims/:claim_id/order (claims.ts).
 */
import type { FastifyInstance } from "fastify";
import {
  listOrders,
  cancelOrder,
  getOpenOrderForClaim,
  serializeOrders,
} from "../services/order-service.js";
import { getDb } from "../db/client.js";
import { assessmentOrders } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { claim_id?: string; status?: string; offset?: number; limit?: number } }>("/", {
    schema: {
      tags: ["orders"],
      summary:
        "List the authenticated user's assessment orders, newest first, a page " +
        "at a time (claim_id filters to the open order for that claim, for the " +
        "claim-page poll; status to orders in one state)",
      querystring: {
        type: "object",
        properties: {
          claim_id: { type: "string", format: "uuid" },
          status: {
            type: "string",
            enum: ["pending", "running", "done", "failed", "cancelled"],
            description: "Only orders in this state.",
          },
          offset: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const userId = request.auth!.userId!;
      if (request.query.claim_id) {
        const order = await getOpenOrderForClaim(userId, request.query.claim_id);
        return reply.send({ orders: order ? await serializeOrders([order]) : [] });
      }
      const orders = await listOrders(userId, request.query.limit ?? 50, {
        offset: request.query.offset,
        status: request.query.status,
      });
      return reply.send({ orders: await serializeOrders(orders) });
    },
  });

  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["orders"],
      summary: "Get one of the authenticated user's orders",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const db = getDb();
      const [order] = await db
        .select()
        .from(assessmentOrders)
        .where(
          and(
            eq(assessmentOrders.id, request.params.id),
            eq(assessmentOrders.userId, request.auth!.userId!)
          )
        )
        .limit(1);
      if (!order) {
        return reply
          .code(404)
          .send({ error: "Order not found", code: "NOT_FOUND" });
      }
      return reply.send({ order: (await serializeOrders([order]))[0] });
    },
  });

  app.delete<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["orders"],
      summary: "Cancel a pending order (free: pending orders are uncharged)",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const result = await cancelOrder({
        orderId: request.params.id,
        userId: request.auth!.userId!,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 409)
          .send({ error: result.message, code: result.code });
      }
      return reply.send({ cancelled: true, refunded: result.refunded });
    },
  });
}
