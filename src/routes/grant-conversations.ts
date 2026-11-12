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
 * refuse mandates that would compromise the graph. A message is saved and
 * answered at once with the conversation, its turn "replying"; the
 * Grantmaker's reply follows in the background (a drafting turn can take
 * minutes), and callers read the conversation until the turn is idle.
 * Writes return what they changed, not the conversation, and a read can
 * wait for the turn and leave out what the caller holds (#905).
 */

/**
 * How a caller gets the reply, stated on every route that starts a turn.
 * Each read returns only what the caller lacks (#905): a caller following
 * this never re-reads the transcript or an unchanged draft.
 */
const TURN_PROTOCOL =
  "Returns at once, before the Grantmaker replies, with your message's " +
  "place in the conversation (message.index, message_count), the draft's " +
  "hash (mandate_sha256) and turn.state \"replying\"; not the transcript, " +
  "which you already hold. To get the reply, call GET " +
  "/grant-conversations/:id (MCP: get_grant_conversation) with " +
  "after=<message_count>, mandate_sha256=<the hash> and wait=25: it " +
  "returns when the turn ends, or after 25 seconds, with only the messages " +
  "after the ones you have, and the draft only if the reply changed it " +
  "(otherwise mandate_unchanged: true). Repeat with the same values while " +
  "turn.state is \"replying\" (a drafting turn can take several minutes). " +
  "At \"idle\" the new messages end with the reply; at \"failed\", " +
  "turn.error says why and a short follow-up asks again. Never resend the " +
  "same message: it is already saved. One turn runs at a time; a message " +
  "sent while one runs is refused with TURN_IN_PROGRESS and not saved.";
import { FUNDING_CALL_MAX_OWLS, FUNDING_CALL_MAX_NOTE } from "../services/owl.js";
import type { FastifyInstance } from "fastify";
import {
  startConversation,
  addMessage,
  fundConversationMandate,
  listConversations,
  serializeConversation,
  serializeConversationSummary,
  serializeSentMessage,
  getConversationAfterTurn,
  MAX_TURN_WAIT_SECONDS,
} from "../services/grant-conversation-service.js";
import { getPublicPlatformConversation } from "../services/platform-mandate-service.js";
import { requirePermission } from "../server/require-permission.js";
import { deploymentHoldsLabels } from "../db/client.js";
import { membersOnly } from "../permissions.js";

const MESSAGE_BODY = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 8000 },
  },
} as const;

/**
 * Whether a conversation says which label it works at: where a members-only
 * deployment holds material at more than one, its owner chose the label
 * when they started it (server/request-labels.ts), and the mandate drafted
 * in it takes the same one. Nowhere else is the field served.
 */
async function conversationsShowLabels(): Promise<boolean> {
  return membersOnly() && (await deploymentHoldsLabels());
}

export async function grantConversationRoutes(
  app: FastifyInstance
): Promise<void> {
  app.post<{ Body: { message: string } }>("/", {
    schema: {
      tags: ["grants"],
      summary:
        "Start a granting conversation: send the Grantmaker your first " +
        "message about the mandate you want to fund (no charge; nothing " +
        "runs until a drafted mandate is funded)",
      description: TURN_PROTOCOL,
      body: MESSAGE_BODY,
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission("direct")],
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
        .send({ conversation: serializeSentMessage(result.conversation) });
    },
  });

  app.get("/", {
    schema: {
      tags: ["grants"],
      summary:
        "List the authenticated user's granting conversations: id, status, " +
        "draft title, message count and turn state for each (read one with " +
        "GET /grant-conversations/:id for its messages and draft)",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const rows = await listConversations(request.auth!.userId!);
      const showLabels = await conversationsShowLabels();
      return reply.send({
        conversations: rows.map((c) => ({
          ...serializeConversationSummary(c),
          ...(showLabels ? { label: c.sensitivityLabel } : {}),
        })),
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

  app.get<{
    Params: { id: string };
    Querystring: { after?: number; mandate_sha256?: string; wait?: number };
  }>("/:id", {
    schema: {
      tags: ["grants"],
      summary:
        "Get one granting conversation: messages, drafted mandate, status, " +
        "and turn.state (\"replying\" while the Grantmaker is still " +
        "answering); after, mandate_sha256 and wait return only what you " +
        "lack, once the turn ends",
      description:
        "With no parameters, the whole conversation. To follow a turn, pass " +
        "what your last read or send returned: after=<message_count> returns " +
        "only the messages after those, mandate_sha256=<hash> leaves the " +
        "draft out (mandate_unchanged: true) while it still hashes the " +
        "same, and wait=<seconds> (at most " +
        `${MAX_TURN_WAIT_SECONDS}) holds the read until the running turn ` +
        "ends or the time is up. message_count and mandate_sha256 come back " +
        "on every read. To check only the turn, fields=conversation.turn.state.",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
      querystring: {
        type: "object",
        properties: {
          after: {
            type: "integer",
            minimum: 0,
            description:
              "How many messages you already hold (message_count from your " +
              "last read or send); only later messages are returned",
          },
          mandate_sha256: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
            description:
              "The draft hash from your last read or send; the draft is " +
              "left out while it is unchanged",
          },
          wait: {
            type: "integer",
            minimum: 0,
            maximum: MAX_TURN_WAIT_SECONDS,
            description:
              "Seconds to wait for a running turn to end before answering " +
              `(at most ${MAX_TURN_WAIT_SECONDS}); returns at once when no turn runs`,
          },
        },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const { after, mandate_sha256, wait } = request.query;
      let gone = false;
      request.raw.once("close", () => {
        gone = true;
      });
      const convo = await getConversationAfterTurn(
        request.params.id,
        request.auth!.userId!,
        wait ?? 0,
        () => gone
      );
      if (!convo) {
        return reply
          .code(404)
          .send({ error: "Conversation not found", code: "NOT_FOUND" });
      }
      return reply.send({
        conversation: {
          ...serializeConversation(convo, {
            after,
            mandateSha256: mandate_sha256,
          }),
          ...((await conversationsShowLabels()) ? { label: convo.sensitivityLabel } : {}),
        },
      });
    },
  });

  app.post<{ Params: { id: string }; Body: { message: string } }>(
    "/:id/messages",
    {
      schema: {
        tags: ["grants"],
        summary:
          "Continue a granting conversation: send the Grantmaker a message " +
          "about the mandate (its reply, and a drafted mandate when it " +
          "proposes one, follow in the conversation)",
        description: TURN_PROTOCOL,
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: MESSAGE_BODY,
      },
      preHandler: [app.authenticate, app.requireUser, requirePermission("direct")],
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
        return reply.code(202).send({
          conversation: serializeSentMessage(result.conversation),
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
          "Fund the drafted mandate: escrow the budget and start the grant " +
          "(returns the new grant_id; read it with GET /grants/:id)",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["budget_owls"],
          properties: {
            // One call's ceiling, a guard against a mistyped amount: the
            // caller's balance bounds the spend, and top_up_grant adds more,
            // so the cap limits a slip, not what a funder may commit (#729).
            budget_owls: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: FUNDING_CALL_MAX_OWLS,
              description: FUNDING_CALL_MAX_NOTE,
            },
          },
        },
      },
      preHandler: [app.authenticate, app.requireUser, requirePermission("fund")],
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
          grant_id: result.grantId,
          conversation: {
            id: result.conversation.id,
            status: result.conversation.status,
          },
        });
      },
    }
  );
}
