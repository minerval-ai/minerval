/**
 * Grant-conversation routes — how a person creates a grant.
 *
 *   POST /grant-conversations              — open with a first message.
 *   GET  /grant-conversations              — the acting user's conversations.
 *   GET  /grant-conversations/:id          — one conversation with mandate.
 *   POST /grant-conversations/:id/messages — continue the conversation.
 *   POST /grant-conversations/:id/fund     — escrow the budget and turn the
 *     drafted mandate into a live grant.
 *
 * There is no form: the Grantmaker agent (best model, constitution loaded)
 * designs the mandate in the conversation, quotes costs in owls, and can
 * refuse mandates that would compromise the graph. Message turns run the
 * agent synchronously, so responses take model latency; the web BFF calls
 * these with a generous timeout.
 */
import type { FastifyInstance } from "fastify";
import {
  startConversation,
  addMessage,
  fundConversationMandate,
  getConversation,
  listConversations,
  serializeConversation,
} from "../services/grant-conversation-service.js";

const MESSAGE_BODY = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 8000 },
  },
} as const;

export async function grantConversationRoutes(
  app: FastifyInstance
): Promise<void> {
  app.post<{ Body: { message: string } }>("/", {
    schema: {
      tags: ["grants"],
      summary:
        "Open a granting conversation with the Grantmaker agent (no charge; " +
        "nothing runs until a drafted mandate is funded)",
      body: MESSAGE_BODY,
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const result = await startConversation({
        userId: request.auth!.userId!,
        message: request.body.message,
      });
      if (!result.ok) {
        const status = result.code === "RATE_LIMITED" ? 429 : 400;
        return reply
          .code(status)
          .send({ error: result.message, code: result.code });
      }
      return reply
        .code(201)
        .send({ conversation: serializeConversation(result.conversation) });
    },
  });

  app.get("/", {
    schema: {
      tags: ["grants"],
      summary: "List the authenticated user's granting conversations",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const rows = await listConversations(request.auth!.userId!);
      return reply.send({
        conversations: rows.map(serializeConversation),
      });
    },
  });

  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["grants"],
      summary: "Get one granting conversation (transcript, mandate, status)",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const convo = await getConversation(
        request.params.id,
        request.auth!.userId!
      );
      if (!convo) {
        return reply
          .code(404)
          .send({ error: "Conversation not found", code: "NOT_FOUND" });
      }
      return reply.send({ conversation: serializeConversation(convo) });
    },
  });

  app.post<{ Params: { id: string }; Body: { message: string } }>(
    "/:id/messages",
    {
      schema: {
        tags: ["grants"],
        summary: "Send a message and get the Grantmaker's reply",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: MESSAGE_BODY,
      },
      preHandler: [app.authenticate, app.requireUser],
      handler: async (request, reply) => {
        const result = await addMessage({
          conversationId: request.params.id,
          userId: request.auth!.userId!,
          message: request.body.message,
        });
        if (!result.ok) {
          const status =
            result.code === "NOT_FOUND"
              ? 404
              : result.code === "RATE_LIMITED"
                ? 429
                : 409;
          return reply
            .code(status)
            .send({ error: result.message, code: result.code });
        }
        return reply.send({
          conversation: serializeConversation(result.conversation),
        });
      },
    }
  );

  app.post<{ Params: { id: string }; Body: { budget_owls: number } }>(
    "/:id/fund",
    {
      schema: {
        tags: ["grants"],
        summary:
          "Fund the drafted mandate: escrow the budget and start the grant",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["budget_owls"],
          properties: {
            budget_owls: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: 10000,
            },
          },
        },
      },
      preHandler: [app.authenticate, app.requireUser],
      handler: async (request, reply) => {
        const result = await fundConversationMandate({
          conversationId: request.params.id,
          userId: request.auth!.userId!,
          budgetOwls: request.body.budget_owls,
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
        return reply.send({
          conversation: serializeConversation(result.conversation),
          grant_id: result.grantId,
        });
      },
    }
  );
}
