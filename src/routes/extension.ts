/**
 * Browser-extension endpoints (issues #72, #93).
 *
 * Analyze is asynchronous (#93): a real page's pipeline can run for minutes,
 * longer than any load-balancer timeout, so POST starts (or joins) the run
 * and answers within a short grace window — 200 with the result when it
 * finishes in time or was cached, 202 with the content hash otherwise — and
 * the extension polls GET /extension/analysis/:content_hash.
 *
 * POST endpoints are agentic (extractor + matcher + extension agent): they
 * authenticate with an API key and pass the owl quota gate, charged at their
 * flat price (extension_analysis / extension_chat — src/services/owl.ts)
 * when the work starts, with LLM work inside runWithUsageContext so every
 * token is attributed to the calling user/key — including work that
 * continues after a 202 is returned. A cache hit refunds the charge (no
 * model work happened). The poll endpoint authenticates but is free.
 */
import type { FastifyInstance } from "fastify";
import {
  extensionAnalyzeBody,
  extensionAnalysisParams,
  extensionChatBody,
} from "../schemas/extension.js";
import {
  startAnalysis,
  getAnalysisByHash,
  chatAboutPage,
  type AnalysisState,
} from "../services/extension-service.js";
import { runWithUsageContext } from "../llm/usage-context.js";
import {
  refundAgenticOp,
  withAgenticCharge,
} from "../server/plugins/quota.js";
import type { FastifyReply } from "fastify";

function sendAnalysisState(reply: FastifyReply, state: AnalysisState) {
  switch (state.state) {
    case "ready":
      return reply.send({ ...state.analysis, cached: state.cached });
    case "running":
      return reply
        .code(202)
        .send({ content_hash: state.content_hash, status: "running" });
    case "failed":
      return reply.code(502).send({
        error: `Analysis failed: ${state.error}`,
        code: "ANALYSIS_FAILED",
        content_hash: state.content_hash,
      });
    case "unknown":
      return reply.code(404).send({
        error:
          "No analysis known for this content hash (expired, or never started); POST /extension/analyze again",
        code: "UNKNOWN_ANALYSIS",
      });
  }
}

export async function extensionRoutes(app: FastifyInstance): Promise<void> {
  // POST /extension/analyze
  app.post("/analyze", {
    schema: {
      tags: ["extension"],
      summary:
        "Start (or join) analysis of a web page: extract claims, match them " +
        "to the graph, and return markup annotations decided by the " +
        "extension agent. Returns 202 + content_hash when the pipeline " +
        "outlasts the grace window; poll GET /extension/analysis/:hash.",
      body: {
        type: "object",
        required: ["url", "content"],
        properties: {
          url: { type: "string", format: "uri" },
          title: { type: "string" },
          content: {
            type: "string",
            description: "Readable page text (not raw HTML)",
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            url: { type: "string" },
            content_hash: { type: "string" },
            cached: { type: "boolean" },
            annotations: { type: "array" },
            stats: { type: "object", additionalProperties: true },
            analyzed_at: { type: "string" },
          },
        },
        202: {
          type: "object",
          properties: {
            content_hash: { type: "string" },
            status: { type: "string", enum: ["running"] },
          },
        },
      },
    },
    preHandler: [
      app.authenticate,
      app.requireAgenticQuota("extension_analysis"),
    ],
    handler: async (request, reply) => {
      const body = extensionAnalyzeBody.parse(request.body);

      const run = await withAgenticCharge(
        request.auth,
        "extension_analysis",
        {},
        () =>
          runWithUsageContext(
            {
              userId: request.auth?.userId ?? null,
              apiKeyId: request.auth?.apiKeyId ?? null,
              requestId: request.id,
            },
            () => startAnalysis(body)
          )
      );
      if (!run.ok) return app.sendQuotaDenial(reply, run.denied);

      // A cache hit did no model work — return the charge.
      if (run.value.state === "ready" && run.value.cached) {
        await refundAgenticOp(request.auth, "extension_analysis");
      }

      return sendAnalysisState(reply, run.value);
    },
  });

  // GET /extension/analysis/:content_hash — poll a started run. Free of LLM
  // work, so authenticated but not quota-gated.
  app.get<{ Params: { content_hash: string } }>("/analysis/:content_hash", {
    schema: {
      tags: ["extension"],
      summary: "Poll a page analysis started via POST /extension/analyze",
      params: {
        type: "object",
        properties: {
          content_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
    },
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const params = extensionAnalysisParams.parse(request.params);
      return sendAnalysisState(reply, getAnalysisByHash(params.content_hash));
    },
  });

  // POST /extension/chat
  app.post("/chat", {
    schema: {
      tags: ["extension"],
      summary:
        "Talk to the extension agent about the current page, grounded in " +
        "the claim graph",
      body: {
        type: "object",
        required: ["messages"],
        properties: {
          messages: { type: "array" },
          page: { type: "object", additionalProperties: true },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            reply: { type: "string" },
            citations: { type: "array" },
          },
        },
      },
    },
    preHandler: [app.authenticate, app.requireAgenticQuota("extension_chat")],
    handler: async (request, reply) => {
      const body = extensionChatBody.parse(request.body);

      const run = await withAgenticCharge(
        request.auth,
        "extension_chat",
        {},
        () =>
          runWithUsageContext(
            {
              userId: request.auth?.userId ?? null,
              apiKeyId: request.auth?.apiKeyId ?? null,
              requestId: request.id,
            },
            () => chatAboutPage(body)
          )
      );
      if (!run.ok) return app.sendQuotaDenial(reply, run.denied);

      return reply.send(run.value);
    },
  });
}
