/**
 * Assistant routes (#646, #619, #312): a user's conversations with the
 * agent that works for them.
 *
 *   POST   /assistant/conversations                — open with a first message.
 *   GET    /assistant/conversations                — the user's conversations.
 *   GET    /assistant/conversations/:id            — one, with its held
 *                                                    actions, turn and bill.
 *   POST   /assistant/conversations/:id/messages   — continue it.
 *   POST   /assistant/conversations/:id/stop       — stop the running turn.
 *   PATCH  /assistant/conversations/:id            — choose its model.
 *   DELETE /assistant/conversations/:id            — delete it.
 *   POST   /assistant/conversations/:id/held/:action_id — run or decline a
 *                                                    held action.
 *   GET    /assistant/allowance                    — kinds allowed without
 *   PUT    /assistant/allowance                      asking, account-wide.
 *
 * Running a held action and changing the allowance need the signed-in
 * dashboard session, like minting an API key.
 *
 * The Assistant's work is charged to the user's balance as it runs, with no
 * cap: a message is refused only when the balance is zero. A message is
 * saved and answered at once with the conversation, its turn "replying"; the
 * reply follows in the background and callers read the conversation until
 * the turn is idle, as with a granting conversation.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  addAssistantMessage,
  assistantModels,
  decideHeldAction,
  deleteAssistantConversation,
  getAllowance,
  getAssistantConversation,
  insufficientOwlsBody,
  listAssistantConversations,
  serializeAssistantConversation,
  serializeAssistantSummary,
  setAllowance,
  setAssistantModel,
  startAssistantConversation,
  stopAssistantTurn,
  type AssistantResult,
  type AssistantUser,
} from "../services/assistant-service.js";
import { HELD_KINDS } from "../llm/tools/assistant-tools.js";
import { getEntitlement } from "../services/billing-service.js";

const TURN_PROTOCOL =
  "Returns at once, before the Assistant replies: the conversation comes back with your " +
  "message saved and turn.state \"replying\". Read it with GET /assistant/conversations/:id " +
  "until turn.state is \"idle\", when the last message is the reply, or \"failed\", when " +
  "turn.error says why. While it runs, turn.partial is the reply so far, turn.note the " +
  "Assistant's progress line and turn.cost_micro_usd what the reply has cost. One turn runs " +
  "at a time; a message sent while one runs is refused with TURN_IN_PROGRESS and not saved. " +
  "The work is charged to your owl balance as it runs, at metered cost, with no cap; the " +
  "balance is the bound, and a message is refused with INSUFFICIENT_OWLS when it is zero.";

const ID_PARAMS = {
  type: "object",
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const KINDS = {
  type: "array",
  items: { type: "string", enum: Object.keys(HELD_KINDS) },
  description:
    "Kinds of held action: " +
    Object.entries(HELD_KINDS)
      .map(([k, label]) => `${k} (${label})`)
      .join("; "),
} as const;

function userOf(request: FastifyRequest): AssistantUser {
  return { id: request.auth!.userId!, externalId: request.auth!.contributorExternalId };
}

function statusOf(code: Exclude<AssistantResult, { ok: true }>["code"]): number {
  return code === "NOT_FOUND"
    ? 404
    : code === "INSUFFICIENT_OWLS"
      ? 402
      : code === "TURN_IN_PROGRESS"
        ? 409
        : 400;
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  const guards = [app.authenticate, app.requireUser];
  // Releasing what the gate holds, and widening what runs without asking,
  // take the dashboard session: nothing that holds only a key can do
  // either, and the Assistant's own calls run at a key's trust
  // (tools/assistant-tools.ts assistantAuth).
  const sessionGuards = [app.authenticate, app.requireSession, app.requireUser];

  const refuse = async (
    request: FastifyRequest,
    result: Exclude<AssistantResult, { ok: true }>
  ) =>
    result.code === "INSUFFICIENT_OWLS"
      ? await insufficientOwlsBody(request.auth!.userId!, result.message)
      : { error: result.message, code: result.code };

  app.post<{ Body: { message: string; node_id?: string; model?: string } }>("/conversations", {
    schema: {
      tags: ["assistant"],
      summary: "Start a conversation with the Assistant, the agent that works for your account",
      description: TURN_PROTOCOL,
      body: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 1, maxLength: 20000 },
          node_id: {
            type: "string",
            format: "uuid",
            description: "The node whose page the conversation was opened from, if any.",
          },
          model: { type: "string", description: "One of the models a conversation lists; omitted, the default." },
        },
      },
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const result = await startAssistantConversation({
        app,
        user: userOf(request),
        message: request.body.message,
        nodeId: request.body.node_id ?? null,
        model: request.body.model ?? null,
      });
      if (!result.ok) return reply.code(statusOf(result.code)).send(await refuse(request, result));
      return reply
        .code(201)
        .send({ conversation: await serializeAssistantConversation(result.conversation) });
    },
  });

  app.get("/conversations", {
    schema: { tags: ["assistant"], summary: "List your conversations with the Assistant" },
    preHandler: guards,
    handler: async (request, reply) => {
      const userId = request.auth!.userId!;
      const [rows, entitlement, always] = await Promise.all([
        listAssistantConversations(userId),
        getEntitlement(userId),
        getAllowance(userId),
      ]);
      return reply.send({
        conversations: rows.map(serializeAssistantSummary),
        // What a new conversation would start with.
        models: assistantModels(),
        balance_micro_usd: entitlement.owlBalanceMicroUsd,
        allowed_kinds: { always, labels: HELD_KINDS },
      });
    },
  });

  app.get<{ Params: { id: string } }>("/conversations/:id", {
    schema: {
      tags: ["assistant"],
      summary:
        "Get one conversation with the Assistant: transcript, held actions, turn state, what it has cost, and your balance",
      params: ID_PARAMS,
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const convo = await getAssistantConversation(request.params.id, request.auth!.userId!);
      if (!convo) return reply.code(404).send({ error: "Conversation not found", code: "NOT_FOUND" });
      return reply.send({ conversation: await serializeAssistantConversation(convo) });
    },
  });

  app.post<{ Params: { id: string }; Body: { message: string } }>("/conversations/:id/messages", {
    schema: {
      tags: ["assistant"],
      summary: "Continue a conversation with the Assistant",
      description: TURN_PROTOCOL,
      params: ID_PARAMS,
      body: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string", minLength: 1, maxLength: 20000 } },
      },
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const result = await addAssistantMessage({
        app,
        user: userOf(request),
        conversationId: request.params.id,
        message: request.body.message,
      });
      if (!result.ok) return reply.code(statusOf(result.code)).send(await refuse(request, result));
      return reply
        .code(202)
        .send({ conversation: await serializeAssistantConversation(result.conversation) });
    },
  });

  app.post<{ Params: { id: string } }>("/conversations/:id/stop", {
    schema: {
      tags: ["assistant"],
      summary:
        "Stop the Assistant's running turn at its next step; what it has written is kept and what it cost stays charged",
      params: ID_PARAMS,
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const stopping = await stopAssistantTurn(request.params.id, request.auth!.userId!);
      return reply.send({ stopping });
    },
  });

  app.patch<{ Params: { id: string }; Body: { model: string } }>("/conversations/:id", {
    schema: {
      tags: ["assistant"],
      summary: "Choose the model a conversation with the Assistant runs on",
      params: ID_PARAMS,
      body: { type: "object", required: ["model"], properties: { model: { type: "string" } } },
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const result = await setAssistantModel(request.params.id, request.auth!.userId!, request.body.model);
      if (!result.ok) return reply.code(statusOf(result.code)).send(await refuse(request, result));
      return reply.send({ conversation: await serializeAssistantConversation(result.conversation) });
    },
  });

  app.delete<{ Params: { id: string } }>("/conversations/:id", {
    schema: {
      tags: ["assistant"],
      summary:
        "Delete a conversation with the Assistant: its text, its held actions, and its runs' transcripts. What it cost stays in the owl history",
      params: ID_PARAMS,
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const deleted = await deleteAssistantConversation(request.params.id, request.auth!.userId!);
      if (!deleted) return reply.code(404).send({ error: "Conversation not found", code: "NOT_FOUND" });
      return reply.send({ deleted: true });
    },
  });

  app.post<{
    Params: { id: string; action_id: string };
    Body: { decision: "run" | "decline"; allow?: { kinds?: string[]; scope: "conversation" | "always" } };
  }>("/conversations/:id/held/:action_id", {
    schema: {
      tags: ["assistant"],
      summary:
        "Run or decline an action the Assistant prepared and could not take itself: one that spends owls on the graph or publishes under your account",
      params: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          action_id: { type: "string", format: "uuid" },
        },
      },
      body: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["run", "decline"] },
          allow: {
            type: "object",
            required: ["scope"],
            description:
              "With decision \"run\": let this action's kind, and any others named, run without asking from now on.",
            properties: {
              kinds: KINDS,
              scope: { type: "string", enum: ["conversation", "always"] },
            },
          },
        },
      },
    },
    preHandler: sessionGuards,
    handler: async (request, reply) => {
      const result = await decideHeldAction({
        app,
        user: userOf(request),
        conversationId: request.params.id,
        actionId: request.params.action_id,
        decision: request.body.decision,
        ...(request.body.allow ? { allow: request.body.allow } : {}),
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 409)
          .send({ error: result.message, code: result.code });
      }
      const convo = await getAssistantConversation(request.params.id, request.auth!.userId!);
      return reply.send({ conversation: convo ? await serializeAssistantConversation(convo) : null });
    },
  });

  app.get("/allowance", {
    schema: {
      tags: ["assistant"],
      summary: "The kinds of action your Assistant may take without asking, in every conversation",
    },
    preHandler: guards,
    handler: async (request, reply) =>
      reply.send({ kinds: await getAllowance(request.auth!.userId!), labels: HELD_KINDS }),
  });

  app.put<{ Body: { kinds: string[] } }>("/allowance", {
    schema: {
      tags: ["assistant"],
      summary:
        "Set the kinds of action your Assistant may take without asking, in every conversation (an empty list asks every time)",
      body: { type: "object", required: ["kinds"], properties: { kinds: KINDS } },
    },
    preHandler: sessionGuards,
    handler: async (request, reply) =>
      reply.send({ kinds: await setAllowance(request.auth!.userId!, request.body.kinds), labels: HELD_KINDS }),
  });
}
