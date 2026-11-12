/**
 * Public mandate routes — grants as public things.
 *
 *   GET  /mandates                — discovery: live mandates, platform-run
 *     first, then largest budgets.
 *   GET  /mandates/:id            — the public dashboard payload; its
 *     sections scale with the mandate's action mix (ingestion pipelines
 *     included). A signed-in manager also receives the conversation id for
 *     talking to the Grantmaker.
 *   GET  /mandates/:id/lookouts/:lookoutId — one standing watch's record:
 *     its brief, its workspace, its flags and what became of each.
 *   POST /mandates/:id/contribute — put your owls behind someone's mandate.
 *
 * Reads are public like claim reads: no credentials required. When
 * credentials ARE presented (the web BFF acting for a session), they are
 * honoured so the payload can include manager-only fields.
 */
import { FUNDING_CALL_MAX_OWLS, FUNDING_CALL_MAX_NOTE } from "../services/owl.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  listPublicMandates,
  getPublicMandate,
  getMandateAllocationView,
  contributeToMandate,
  listMandateAttempts,
} from "../services/mandate-service.js";
import { mandatePrizesBlock } from "../services/bounty-service.js";
import { getLookout, listLookoutFlags, lookoutPrecision } from "../services/lookout-service.js";
import { presentsCredentials } from "../server/plugins/auth.js";
import { optionalAuthHook } from "../server/optional-auth.js";

export async function mandateRoutes(app: FastifyInstance): Promise<void> {
  // Authenticate only when the caller presented credentials; anonymous
  // reads stay open (mandates are public).
  const optionalAuth = optionalAuthHook(async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    if (presentsCredentials(request)) {
      await app.authenticate(request, reply);
    }
  });

  app.get<{ Querystring: { limit?: number } }>("/", {
    schema: {
      tags: ["mandates"],
      summary:
        "Public mandates open to contribution: platform-run first, then " +
        "largest budgets",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
    handler: async (request, reply) => {
      const mandates = await listPublicMandates(request.query.limit ?? 50);
      return reply.send({ mandates });
    },
  });

  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["mandates"],
      summary:
        "One mandate's public dashboard: budget, spend, contributors, plan " +
        "progress, funded assessments, and (when it ingests) the pipeline",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      const mandate = await getPublicMandate(
        request.params.id,
        request.auth?.userId ?? null
      );
      if (!mandate) {
        return reply
          .code(404)
          .send({ error: "Mandate not found", code: "NOT_FOUND" });
      }
      // The Prizes section (docs/mathematics.md §8.3): the mandate's prize
      // numbers (escrow, held in open bounties, paid, the review reserve,
      // headroom), bounties posted, prizes paid, the bounty table, and the
      // house solver's attempts under this mandate. A bounty holds against
      // this mandate's own escrow; a failure in either must not hide the
      // page.
      const [prizes, attempts] = await Promise.all([
        mandatePrizesBlock(request.params.id).catch(() => null),
        listMandateAttempts(request.params.id).catch(() => []),
      ]);
      return reply.send({ mandate: { ...mandate, prizes, attempts } });
    },
  });

  app.get<{
    Params: { id: string };
    Querystring: { kind?: string; offset?: number; limit?: number };
  }>("/:id/allocation", {
    schema: {
      tags: ["mandates"],
      summary:
        "The mandate's operations: the operating policy its program officers " +
        "carry out, its escrow (spent, held by running work, regranted, " +
        "held for prizes, and the remainder, which add up to the escrow) " +
        "and where its pace stands (as needed or steady, and the Grantmaker's reserve), what it " +
        "commissioned in the last 30 days and how those runs used their " +
        "budgets (paged), its officers' and Grantmaker's recent decisions, " +
        "and the petitions it heard",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
      querystring: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "assess",
              "reassess",
              "ingest",
              "grant_planning",
              "mandate_review",
              "lookout_run",
              "consistency_sweep",
              "curate",
              "audit",
              "formalize",
              "attempt_proof",
              "prize_review",
              "request",
            ],
          },
          offset: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
    handler: async (request, reply) => {
      const view = await getMandateAllocationView(request.params.id, {
        kind: request.query.kind,
        offset: request.query.offset,
        limit: request.query.limit,
      });
      if (!view) {
        return reply
          .code(404)
          .send({ error: "Mandate not found", code: "NOT_FOUND" });
      }
      return reply.send({ allocation: view });
    },
  });

  app.post<{ Params: { id: string }; Body: { owls: number } }>(
    "/:id/contribute",
    {
      schema: {
        tags: ["mandates"],
        summary:
          "Contribute owls to a public mandate (escrowed; unspent budget " +
          "refunds contributors pro rata)",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["owls"],
          properties: {
            // One call's ceiling against a mistyped amount; see owl.ts (#729).
            owls: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: FUNDING_CALL_MAX_OWLS,
              description: FUNDING_CALL_MAX_NOTE,
            },
          },
        },
      },
      preHandler: [app.authenticate, app.requireUser],
      handler: async (request, reply) => {
        const result = await contributeToMandate({
          grantId: request.params.id,
          userId: request.auth!.userId!,
          owls: request.body.owls,
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
        return reply.send({ mandate: result.mandate });
      },
    }
  );

  // POST /mandates/:id/withdraw — a funder takes back their share of the
  // mandate's uncommitted money (mandate-terms-service.ts): the uncommitted
  // money in proportion to what they still have in it, or less if asked.
  // Any funder may, at any time; it is how one leaves a mandate whose
  // objective has changed (amend_objective) or no longer serves them.
  app.post<{ Params: { id: string }; Body: { owls?: number } }>(
    "/:id/withdraw",
    {
      schema: {
        tags: ["mandates"],
        summary:
          "Withdraw your share of a mandate's uncommitted money back to your " +
          "balance (all of it, or up to `owls`); money already committed to " +
          "running work stays with it",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: { owls: { type: "number", exclusiveMinimum: 0 } },
        },
      },
      preHandler: [app.authenticate, app.requireUser],
      handler: async (request, reply) => {
        const { withdrawFromMandate } = await import("../services/mandate-terms-service.js");
        const result = await withdrawFromMandate({
          grantId: request.params.id,
          funder: { userId: request.auth!.userId! },
          owls: request.body?.owls ?? null,
        });
        if (!result.ok) {
          return reply.code(409).send({ error: result.message, code: "NOTHING_TO_WITHDRAW" });
        }
        return reply.send({ withdrawn_owls: result.withdrawnOwls });
      },
    }
  );

  app.get<{ Params: { id: string; lookoutId: string }; Querystring: { limit?: number } }>(
    "/:id/lookouts/:lookoutId",
    {
      schema: {
        tags: ["mandates"],
        summary:
          "One of the mandate's lookouts: brief, cadence, triggers, bounds, " +
          "its workspace, its precision, and its recent flags with what " +
          "became of each",
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            lookoutId: { type: "string", format: "uuid" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
      handler: async (request, reply) => {
        const lookout = await getLookout(request.params.lookoutId);
        if (!lookout || lookout.grant_id !== request.params.id) {
          return reply.code(404).send({ error: "Lookout not found", code: "NOT_FOUND" });
        }
        const [flags, precision] = await Promise.all([
          listLookoutFlags(lookout.id, { limit: request.query.limit ?? 50 }),
          lookoutPrecision(lookout.id),
        ]);
        return reply.send({
          lookout: {
            id: lookout.id,
            mandate_id: lookout.grant_id,
            title: lookout.title,
            brief: lookout.brief,
            status: lookout.status,
            heartbeat_hours: lookout.heartbeat_hours,
            triggers: lookout.triggers ?? [],
            model: lookout.model,
            commission_limit_owls: Number(lookout.commission_limit_micro_usd ?? 0) / 1_000_000,
            territory: { claim_ids: lookout.territory_claim_ids ?? [], tag_ids: lookout.territory_tag_ids ?? [] },
            workspace: lookout.workspace,
            last_note: lookout.last_note,
            last_run_at: lookout.last_run_at ? new Date(lookout.last_run_at).toISOString() : null,
            runs: lookout.runs,
            flags: lookout.flags,
            precision,
            created_by: lookout.created_by,
            created_at: new Date(lookout.created_at).toISOString(),
          },
          flags: flags.map((f) => ({
            id: f.id,
            kind: f.kind,
            claim_id: f.claim_id,
            claim_text: f.claim_text,
            url: f.url,
            rationale: f.rationale,
            urgency: f.urgency,
            value_written: f.value_written,
            action_status: f.action_status,
            ran: f.ran,
            moved: f.moved,
            status_at_flag: f.status_at_flag,
            status_now: f.status_now,
            repeats: f.repeats,
            created_at: new Date(f.created_at).toISOString(),
          })),
        });
      },
    }
  );
}
