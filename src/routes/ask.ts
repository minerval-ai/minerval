/**
 * "Ask the graph" (issue #312): one conversational endpoint for every
 * surface. The website's claim-page ask box and ask page call it through
 * the web BFF acting for the signed-in reader; the browser extension's
 * POST /extension/chat is the same loop in page mode under its older name;
 * and REST callers without a model of their own can call it directly. MCP
 * deliberately does not wrap it (docs/mcp.md): an MCP client already has a
 * model, and the `ask_graph` prompt hands it the same grounding rules.
 *
 * Agentic, so it authenticates with an API key and passes the owl quota
 * gate, charged at the graph_chat cap when the exchange starts and settled
 * to metered cost afterward. Nothing from the conversation is persisted.
 */
import type { FastifyInstance } from "fastify";
import { askBody } from "../schemas/ask.js";
import { askGraph, UnknownClaimError } from "../services/graph-chat-service.js";
import type { GraphChatContext } from "../llm/prompts/graph-chat.js";
import { runWithUsageContext } from "../llm/usage-context.js";
import { withAgenticCharge } from "../server/plugins/quota.js";

function toContext(context: ReturnType<typeof askBody.parse>["context"]): GraphChatContext {
  switch (context.kind) {
    case "graph":
      return { kind: "graph" };
    case "claim":
      return { kind: "claim", claimId: context.claim_id };
    case "page":
      return {
        kind: "page",
        url: context.url,
        title: context.title,
        claims: context.claims,
      };
  }
}

export async function askRoutes(app: FastifyInstance): Promise<void> {
  // POST /ask
  app.post("/", {
    schema: {
      tags: ["ask"],
      summary:
        "Ask the claim graph a question: a model with read-only graph " +
        "tools answers grounded in the graph's assessments, citing the " +
        "claims it used. Context anchors the conversation to one claim, " +
        "to a web page, or to the graph as a whole.",
      body: {
        type: "object",
        required: ["messages"],
        properties: {
          messages: {
            type: "array",
            description:
              "The conversation so far, alternating user/assistant turns; " +
              "the last turn is the question.",
          },
          context: {
            type: "object",
            additionalProperties: true,
            description:
              '{kind: "graph"} (default), {kind: "claim", claim_id}, or ' +
              '{kind: "page", url, title, claims}.',
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            reply: { type: "string" },
            citations: { type: "array" },
            model: { type: "string", nullable: true },
          },
        },
        404: {
          type: "object",
          properties: {
            error: { type: "string" },
            code: { type: "string" },
          },
        },
      },
    },
    preHandler: [app.authenticate, app.requireAgenticQuota("graph_chat")],
    handler: async (request, reply) => {
      const body = askBody.parse(request.body);
      const context = toContext(body.context);

      try {
        const run = await withAgenticCharge(request.auth, "graph_chat", {}, () =>
          runWithUsageContext(
            {
              userId: request.auth?.userId ?? null,
              apiKeyId: request.auth?.apiKeyId ?? null,
              requestId: request.id,
            },
            () => askGraph({ messages: body.messages, context })
          )
        );
        if (!run.ok) return app.sendQuotaDenial(reply, run.denied);
        return reply.send(run.value);
      } catch (err) {
        // A charge taken before the claim lookup is refunded by
        // withAgenticCharge's failure path; the caller just learns the id
        // is wrong.
        if (err instanceof UnknownClaimError) {
          return reply.code(404).send({
            error: `No claim with id ${err.claimId}`,
            code: "CLAIM_NOT_FOUND",
          });
        }
        throw err;
      }
    },
  });
}
