/**
 * Grant-conversation routes — how a person creates a grant.
 *
 *   POST /grant-conversations              — open with a first message.
 *   GET  /grant-conversations              — the acting user's conversations.
 *   GET  /grant-conversations/:id          — one conversation with mandate.
 *   POST /grant-conversations/:id/messages — continue the conversation.
 *   POST /grant-conversations/:id/fund     — escrow the budget and turn the
 *     drafted mandate into a live grant. Refused for the platform account,
 *     whose mandates are funded under a public approval (#529).
 *   GET  /grant-conversations/platform/:id — one of the platform's
 *     conversations, public (#529).
 *
 * There is no form: the Grantmaker agent (best model, constitution loaded)
 * designs the mandate in the conversation, quotes costs in owls, and can
 * refuse mandates that would compromise the graph. Message turns run the
 * agent synchronously, so responses take model latency; the web BFF calls
 * these with a generous timeout.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  startConversation,
  addMessage,
  fundConversationMandate,
  getConversation,
  listConversations,
  serializeConversation,
  type ConverseResult,
} from "../services/grant-conversation-service.js";
import { getPublicPlatformConversation } from "../services/platform-mandate-service.js";

const MESSAGE_BODY = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 8000 },
  },
} as const;

/**
 * The Grantmaker failed after the funder's message was saved: 502 with the
 * saved conversation, so the caller sees its message is in the transcript
 * and does not resend it.
 */
function agentFailed(
  reply: FastifyReply,
  result: Extract<ConverseResult, { code: "AGENT_FAILED" }>
) {
  return reply.code(502).send({
    error: result.message,
    code: result.code,
    message_saved: true,
    conversation: serializeConversation(result.conversation),
  });
}

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
        if (result.code === "AGENT_FAILED") return agentFailed(reply, result);
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

  // A platform granting conversation, readable by anyone (#529): the
  // reasoning behind every platform mandate is on the public record, and
  // the CI check on a funding request reads the draft and its hash here.
  // A person's conversations are never served by this route.
  app.get<{ Params: { id: string } }>("/platform/:id", {
    schema: {
      tags: ["grants"],
      summary:
        "Read one of the platform's granting conversations: transcript, standing draft, and the draft's hash (public)",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    handler: async (request, reply) => {
      const convo = await getPublicPlatformConversation(request.params.id);
      if (!convo) {
        return reply.code(404).send({
          error: "No platform granting conversation has that id",
          code: "NOT_FOUND",
        });
      }
      return reply.send({ conversation: convo });
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
          if (result.code === "AGENT_FAILED") return agentFailed(reply, result);
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
                : result.code === "PLATFORM_FUNDS_BY_APPROVAL"
                  ? 403
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
