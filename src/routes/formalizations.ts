/**
 * Routes for the formal-statement surfaces (docs/mathematics.md §11.1).
 * Registered without a prefix because the paths span /claims and
 * /lean-checks. Every route here is a public read.
 */
import type { FastifyInstance } from "fastify";
import {
  getFormalizationSummary,
  getLeanCheckPublicRecord,
  getPublishedFormalization,
  listFormalizations,
} from "../services/formalization-service.js";
import { getClaimById } from "../services/claim-service.js";

const errorEnvelope = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        request_id: { type: "string" },
      },
    },
  },
} as const;

const looseObject = { type: "object", additionalProperties: true } as const;

const uuidParams = (name: string) =>
  ({
    type: "object",
    properties: { [name]: { type: "string", format: "uuid" } },
  }) as const;

export async function formalizationsRoutes(app: FastifyInstance): Promise<void> {
  // GET /claims/:claim_id/formalization — the published statement.
  app.get<{ Params: { claim_id: string } }>(
    "/claims/:claim_id/formalization",
    {
      schema: {
        tags: ["formalizations"],
        summary: "The claim's published formal statement: source, hashes, pin, correspondence, dates",
        params: uuidParams("claim_id"),
        response: { 200: looseObject, 404: errorEnvelope },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const claim = await getClaimById(claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Claim not found", request_id: request.id },
          });
        }
        const formalization = await getFormalizationSummary(claim_id);
        if (!formalization) {
          return reply.code(404).send({
            error: {
              code: "NO_FORMALIZATION",
              message: "This claim has no published formal statement",
              request_id: request.id,
            },
          });
        }
        return reply.send({ claim_id, formalization });
      },
    }
  );

  // GET /claims/:claim_id/formalization.lean — the statement file verbatim.
  app.get<{ Params: { claim_id: string } }>(
    "/claims/:claim_id/formalization.lean",
    {
      schema: {
        tags: ["formalizations"],
        summary: "The published statement file, verbatim, as text/plain for outside solvers",
        params: uuidParams("claim_id"),
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const row = await getPublishedFormalization(claim_id);
        if (!row) {
          return reply.code(404).send({
            error: {
              code: "NO_FORMALIZATION",
              message: "This claim has no published formal statement",
              request_id: request.id,
            },
          });
        }
        reply.header("content-type", "text/plain; charset=utf-8");
        reply.header("x-minerval-pin", row.pin_id);
        reply.header("x-minerval-source-hash", row.source_hash);
        return reply.send(row.statement_source);
      },
    }
  );

  // GET /claims/:claim_id/formalizations — every version, newest first.
  app.get<{ Params: { claim_id: string } }>(
    "/claims/:claim_id/formalizations",
    {
      schema: {
        tags: ["formalizations"],
        summary: "Every version of the claim's formal statement with status and review notes, newest first",
        params: uuidParams("claim_id"),
        response: {
          200: {
            type: "object",
            properties: {
              claim_id: { type: "string", format: "uuid" },
              formalizations: { type: "array", items: looseObject },
              total: { type: "integer" },
            },
          },
          404: errorEnvelope,
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const claim = await getClaimById(claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Claim not found", request_id: request.id },
          });
        }
        const formalizations = await listFormalizations(claim_id);
        return reply.send({ claim_id, formalizations, total: formalizations.length });
      },
    }
  );

  // GET /lean-checks/:id — a check record; the source once it is public.
  app.get<{ Params: { id: string } }>(
    "/lean-checks/:id",
    {
      schema: {
        tags: ["formalizations"],
        summary:
          "A checker record with every gate; the submission source once the owning prize claim's attachments or attempt are public",
        params: uuidParams("id"),
        response: { 200: looseObject, 404: errorEnvelope },
      },
      handler: async (request, reply) => {
        const record = await getLeanCheckPublicRecord(request.params.id);
        if (!record) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Check not found", request_id: request.id },
          });
        }
        return reply.send({
          id: record.id,
          claim_id: record.claim_id,
          formalization_id: record.formalization_id,
          namespace: record.namespace,
          mode: record.mode,
          kind: record.kind,
          verdict: record.verdict,
          checks: record.checks,
          diagnostics: record.diagnostics,
          truncated: record.truncated,
          resource: record.resource,
          pin_id: record.pin_id,
          image_digest: record.image_digest,
          checker_version: record.checker_version,
          submission_sha256: record.submission_sha256,
          submitted_by: record.submitted_by,
          prize_claim_id: record.prize_claim_id,
          attempt_id: record.attempt_id,
          second_opinion: record.second_opinion,
          source_public: record.source_public,
          submission_source: record.submission_source,
          created_at: record.created_at.toISOString(),
          finished_at: record.finished_at ? record.finished_at.toISOString() : null,
        });
      },
    }
  );
}
