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
 *
 * The shared page cache: an analyze request with share=true, once its run
 * finishes, stores the result for other readers of the page if the server
 * confirms the page is public (services/shared-analysis-service.ts). The two
 * GET /extension/shared endpoints read it. They are free and need no key: a
 * lookup sends only a short hash prefix, and identifying the reader would
 * undo the point of sending so little.
 */
import type { FastifyInstance } from "fastify";
import {
  extensionAnalyzeBody,
  extensionAnalysisParams,
  extensionChatBody,
  sharedHashParams,
  sharedPrefixQuery,
} from "../schemas/extension.js";
import {
  startAnalysis,
  getAnalysisByHash,
  chatAboutPage,
  whenAnalysisSettles,
  type AnalysisState,
} from "../services/extension-service.js";
import {
  getSharedAnalysis,
  listSharedHashes,
  shareIfPublic,
} from "../services/shared-analysis-service.js";
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
          share: {
            type: "boolean",
            description:
              "Share the result with other readers of this page, if the " +
              "server confirms the page is public (default false)",
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

      if (body.share) {
        // Detached: verifying the page is public outlives this response,
        // like the run itself after a 202. A failure only means no sharing.
        const state = run.value;
        const settled =
          state.state === "ready"
            ? Promise.resolve(state.analysis)
            : state.state === "running"
              ? whenAnalysisSettles(state.content_hash)
              : Promise.resolve(null);
        void settled
          .then((analysis) => (analysis ? shareIfPublic(body.url, analysis) : null))
          .catch((err) => request.log.warn({ err }, "sharing a page analysis failed"));
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

  // GET /extension/shared?prefix=abcd — every shared page's URL hash in a
  // prefix bucket. The client checks for its own page's full hash locally.
  app.get("/shared", {
    schema: {
      tags: ["extension"],
      summary:
        "List the URL hashes of shared page analyses that start with a " +
        "4-hex-character prefix (private lookup: send the prefix of your " +
        "page's hash, match locally)",
      querystring: {
        type: "object",
        required: ["prefix"],
        properties: { prefix: { type: "string", pattern: "^[0-9a-f]{4}$" } },
      },
      response: {
        200: {
          type: "object",
          properties: { hashes: { type: "array", items: { type: "string" } } },
        },
      },
    },
    handler: async (request, reply) => {
      const { prefix } = sharedPrefixQuery.parse(request.query);
      return reply.send({ hashes: await listSharedHashes(prefix) });
    },
  });

  // GET /extension/shared/:url_hash — one shared analysis, claim statuses live.
  app.get<{ Params: { url_hash: string } }>("/shared/:url_hash", {
    schema: {
      tags: ["extension"],
      summary:
        "A shared analysis of a public page, by the SHA-256 of its " +
        "normalized URL, with each claim's current graph status",
      params: {
        type: "object",
        properties: { url_hash: { type: "string", pattern: "^[0-9a-f]{64}$" } },
      },
    },
    handler: async (request, reply) => {
      const { url_hash } = sharedHashParams.parse(request.params);
      const analysis = await getSharedAnalysis(url_hash);
      if (!analysis) {
        return reply.code(404).send({
          error: "No shared analysis for this page",
          code: "NOT_SHARED",
        });
      }
      return reply.send(analysis);
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
      // A reader watching the answer form asks for an event stream: `text`
      // events carry the reply as it is written ({delta, turn}; a new turn,
      // after a tool call, starts the text over), then one `done` event
      // carries what the JSON form returns, or an `error` event. The stream
      // opens only once the charge is taken, so a quota denial is still an
      // ordinary HTTP error.
      const streaming = (request.headers.accept ?? "").includes("text/event-stream");
      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let run;
      try {
        run = await withAgenticCharge(
          request.auth,
          "extension_chat",
          {},
          () => {
            if (streaming) {
              reply.hijack();
              reply.raw.writeHead(200, {
                // Headers already set on the reply (CORS among them) would
                // be lost to the hijack otherwise.
                ...(reply.getHeaders() as Record<string, string>),
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
                // Proxies that buffer would hold the whole stream back.
                "x-accel-buffering": "no",
              });
            }
            return runWithUsageContext(
              {
                userId: request.auth?.userId ?? null,
                apiKeyId: request.auth?.apiKeyId ?? null,
                requestId: request.id,
              },
              () =>
                chatAboutPage({
                  ...body,
                  ...(streaming
                    ? { onText: (delta: string, turn: number) => send("text", { delta, turn }) }
                    : {}),
                })
            );
          }
        );
      } catch (err) {
        if (!streaming || !reply.sent) throw err;
        request.log.error({ err }, "extension chat failed mid-stream");
        send("error", { error: "The answer could not be finished. Please try again." });
        reply.raw.end();
        return;
      }
      if (!run.ok) return app.sendQuotaDenial(reply, run.denied);

      if (streaming) {
        send("done", run.value);
        reply.raw.end();
        return;
      }
      return reply.send(run.value);
    },
  });
}
