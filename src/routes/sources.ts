import type { FastifyInstance } from "fastify";
import { sourceSubmitBody } from "../schemas/source.js";
import { submitSource } from "../services/source-service.js";
import { createSourceProposal } from "../services/intake-service.js";
import { gateContributor } from "../server/contributor-gate.js";
import { isDirectService } from "../server/plugins/auth.js";
import { chargeAgenticOp, refundAgenticOp } from "../server/plugins/quota.js";
import { attachChargeContribution } from "../services/owl-ledger-service.js";
import { getSourceFacts } from "../services/source-facts-service.js";
import { getSourceDocument } from "../services/source-segment-service.js";

// Contributor-gate errors ({error: {code, message}}), shared with
// POST /contributions.
const errorEnvelopeSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  // GET /sources/:source_id/document — the document as annotated text
  // (#507): its segments in its own order (sections, passages, tables,
  // notes, references), each passage with the claims that assert it and
  // each claim Steward's reading, in that claim's voice. The source page's
  // body. Instances whose text is not in the stored document are listed
  // apart rather than placed by guess.
  app.get<{ Params: { source_id: string } }>("/:source_id/document", {
    schema: {
      tags: ["sources"],
      summary: "A source as annotated text: its structure, and the claims anchored to each passage",
      params: {
        type: "object",
        properties: { source_id: { type: "string", format: "uuid" } },
      },
    },
    handler: async (request, reply) => {
      const doc = await getSourceDocument(request.params.source_id);
      if (!doc) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Source not found", request_id: request.id },
        });
      }
      return reply.send(doc);
    },
  });

  // GET /sources/:source_id — the facts about a document that need no
  // judgment (#507): identity (authors, publisher, date, kind, DOI, an
  // archived copy), its other versions and republished copies, and what has
  // happened to it since publication. The first section of the source page.
  // Public and read-only, like a claim page. No response schema: the shape
  // is the read model's.
  app.get<{ Params: { source_id: string } }>("/:source_id", {
    schema: {
      tags: ["sources"],
      summary: "Facts about a source: identity, versions, copies, corrections and retractions",
      params: {
        type: "object",
        properties: { source_id: { type: "string", format: "uuid" } },
      },
    },
    handler: async (request, reply) => {
      const facts = await getSourceFacts(request.params.source_id);
      if (!facts) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Source not found", request_id: request.id },
        });
      }
      return reply.send(facts);
    },
  });

  // POST /sources
  app.post("/", {
    schema: {
      tags: ["sources"],
      summary:
        "Submit a source URL for claim extraction (user submissions enter the review queue)",
      body: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
          title: { type: "string" },
          content: { type: "string" },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            source_id: { type: "string", format: "uuid" },
            job_id: { type: "string", format: "uuid" },
            contribution_id: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["queued", "pending_review"] },
          },
        },
        402: errorEnvelopeSchema,
        403: errorEnvelopeSchema,
        429: errorEnvelopeSchema,
      },
    },
    // Source ingestion drives the extractor + matcher (LLM work), so it is a
    // flat-priced agentic surface (source_ingest owls — src/services/owl.ts).
    preHandler: [app.authenticate, app.requireAgenticQuota("source_ingest")],
    handler: async (request, reply) => {
      const body = sourceSubmitBody.parse(request.body);
      const auth = request.auth;

      // Internal seeding fast path (#157): a direct service caller (corpus,
      // FLF case studies) goes straight to extraction. Everything else —
      // including the web BFF acting for a signed-in user — takes the intake
      // path below.
      if (isDirectService(auth)) {
        const result = await submitSource(body, {
          userId: auth.userId ?? null,
          apiKeyId: auth.apiKeyId ?? null,
        });

        return reply.code(202).send({
          source_id: result.sourceId,
          job_id: result.jobId,
          status: "queued" as const,
        });
      }

      // Governed intake (#157): the source is stored verbatim but nothing is
      // extracted — no claims, no instances — until the Contribution Reviewer
      // accepts the submission.
      const contributor = await gateContributor(request, reply);
      if (!contributor) return;

      // Charge at start: the price buys the extraction work that follows
      // acceptance. The charge is linked to the contribution so an intake
      // rejection refunds it automatically (good-faith submission is free).
      const charge = await chargeAgenticOp(auth, "source_ingest");
      if (!charge.allowed) return app.sendQuotaDenial(reply, charge);

      let contribution, sourceId;
      try {
        ({ contribution, sourceId } = await createSourceProposal({
          url: body.url,
          title: body.title,
          content: body.content,
          contributorId: contributor.id,
        }));
        if (charge.entryId) {
          await attachChargeContribution(charge.entryId, contribution.id);
        }
      } catch (err) {
        // The proposal never materialized: the user must not pay for a 500.
        await refundAgenticOp(auth, "source_ingest").catch(() => {});
        throw err;
      }

      return reply.code(202).send({
        source_id: sourceId,
        contribution_id: contribution.id,
        status: "pending_review" as const,
      });
    },
  });
}
