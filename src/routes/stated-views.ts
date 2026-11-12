/**
 * Views stated to the graph directly (constitution §4): stating one, and
 * reading where stated views and the judgments in force differ. Registered
 * without a prefix because the paths span /claims and /stated-views.
 *
 * Stating a view is a contribution, so it passes the same gate as any
 * contribution on an existing node (server/contributor-gate.ts): a resolved
 * account, not suspended, in good standing, inside the hourly limit that
 * bounds review nobody pays for. Reads are public.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { paginationSchema, uuidSchema, STATED_VIEW_STANCES } from "../schemas/common.js";
import { gateContributor } from "../server/contributor-gate.js";
import { getClaimById } from "../services/claim-service.js";
import { loadConfig } from "../config.js";
import type { NodeKind } from "../schemas/kinds.js";
import {
  createStatedView,
  listStatedViews,
  parseStatedView,
  REASONS_MAX_CHARS,
  STATEMENT_MAX_CHARS,
  statedViewsForClaim,
} from "../services/stated-view-service.js";
import { PROBABILITY_GAP, VIEW_RELATIONS } from "../services/stated-view-compare.js";
import { INTEREST_STAKE_MAX_CHARS } from "../services/source-interest-service.js";

const errorEnvelope = {
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

const looseObject = { type: "object", additionalProperties: true } as const;

const ALL_STANCES = [...new Set(Object.values(STATED_VIEW_STANCES).flat())];

const listParams = paginationSchema.extend({
  claim_id: uuidSchema.optional(),
  speaker_id: uuidSchema.optional(),
  relation: z.enum(VIEW_RELATIONS).optional(),
  earlier: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional(),
});

export async function statedViewRoutes(app: FastifyInstance): Promise<void> {
  // POST /claims/:claim_id/stated-views
  app.post<{ Params: { claim_id: string }; Body: Record<string, unknown> }>(
    "/claims/:claim_id/stated-views",
    {
      schema: {
        tags: ["stated views"],
        summary:
          "State your own view on a claim, a quantity or a question to the graph directly (constitution §4): " +
          "what you hold, in your own words, with how you stand toward the node, your reasons if you give any, " +
          "and your stake in the answer",
        params: {
          type: "object",
          properties: { claim_id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["statement", "stance"],
          properties: {
            statement: {
              type: "string",
              minLength: 1,
              maxLength: STATEMENT_MAX_CHARS,
              description:
                "The view, in the speaker's own words. It is shown as written and never edited. " +
                "The case for it goes in reasons.",
            },
            stance: {
              type: "string",
              enum: ALL_STANCES,
              description:
                "How the speaker stands toward the node as it is worded. On a claim: affirms, denies, " +
                "qualifies (holds it only with a condition or limit the statement gives), gives_probability " +
                "(a probability and no side), or open (treats it as unsettled). On a quantity: states (with " +
                "figure) or open. On a question: answers (the statement is the answer) or open.",
            },
            probability: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description:
                "On a claim only: the probability the speaker gives that the claim as worded is true. " +
                "Optional with any stance; required with gives_probability.",
            },
            figure: {
              type: "object",
              additionalProperties: true,
              description:
                'On a quantity with stance states: the figure, in the quantity\'s own unit. One figure ' +
                '{"form":"point","central":N}, a range {"form":"interval","low":N,"high":N}, or a side of a ' +
                'figure {"form":"bound","bound":{"side":"above"|"below","value":N}}.',
            },
            reasons: {
              type: "string",
              maxLength: REASONS_MAX_CHARS,
              description:
                "Optional. Why the speaker holds the view. Where they go against the assessment they are " +
                "heard as a challenge: the node's Steward weighs them and answers, and the exchange is kept " +
                "on the contribution's record.",
            },
            evidence_urls: {
              type: "array",
              items: { type: "string" },
              description: "Optional. Links the reasons rest on.",
            },
            stake: {
              type: "string",
              maxLength: INTEREST_STAKE_MAX_CHARS,
              description:
                "What the speaker stands to gain or lose by how this is answered, in a sentence. It is " +
                "recorded and shown as a fact about the statement, not as a finding against it. Give this " +
                "or no_stake.",
            },
            no_stake: {
              type: "boolean",
              description: "True when the speaker has no stake in the answer. Give this or stake.",
            },
            contributor_display_name: { type: "string" },
          },
        },
        response: {
          202: {
            type: "object",
            properties: {
              stated_view: {
                type: "object",
                properties: { id: { type: "string", format: "uuid" } },
              },
              contribution: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  contribution_type: { type: "string" },
                  review_status: { type: "string" },
                  record_url: { type: "string" },
                },
              },
              source_id: { type: "string", format: "uuid" },
              message: { type: "string" },
            },
          },
          402: errorEnvelope,
          403: errorEnvelope,
          404: errorEnvelope,
          // The alias plugin's refusal of a merged node, in its flat shape
          // ({error, code, merged_into, stance_relation}).
          409: looseObject,
          422: errorEnvelope,
          429: errorEnvelope,
        },
      },
      // In a members-only deployment, stating the organization's own view is
      // part of the permission to direct the graph. That guard goes in this
      // list, after app.authenticate: requirePermission("direct")
      // (src/server/require-permission.ts, on the claude/permissions branch).
      // On the public graph an account speaks for itself and needs none.
      preHandler: app.authenticate,
      handler: async (request, reply) => {
        const claimId = request.params.claim_id;
        const claim = await getClaimById(claimId);
        if (!claim) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No claim, quantity or question has that id" } });
        }
        // A node merged into another never reaches this handler: the alias
        // plugin (server/plugins/claim-alias.ts) refuses a write to it with
        // 409 CLAIM_MERGED and names the survivor, whose wording is the one
        // to stand toward. Any other inactive node is refused here, in the
        // same flat shape.
        if (claim.state !== "active") {
          return reply.code(409).send({
            error: `This node is ${claim.state}; a view is stated on an active node.`,
            code: "CLAIM_NOT_ACTIVE",
          });
        }

        const kind = (claim.kind ?? "claim") as NodeKind;
        const parsed = parseStatedView(kind, request.body ?? {});
        if (!parsed.ok) {
          return reply.code(422).send({ error: { code: parsed.code, message: parsed.message } });
        }

        const displayName =
          typeof request.body?.contributor_display_name === "string"
            ? request.body.contributor_display_name.trim() || undefined
            : undefined;
        const contributor = await gateContributor(request, reply, { displayName });
        if (!contributor) return;

        const created = await createStatedView({
          claimId: claim.id,
          contributorId: contributor.id,
          speakerDisplayName: contributor.displayName,
          view: parsed.view,
        });

        const base = loadConfig().publicWebBaseUrl.replace(/\/$/, "");
        return reply.code(202).send({
          stated_view: { id: created.statedViewId },
          contribution: {
            id: created.contributionId,
            contribution_type: "state_view",
            review_status: "pending",
            record_url: `${base}/contributions/${created.contributionId}`,
          },
          source_id: created.sourceId,
          message:
            `Received as a statement by "${contributor.displayName}". It is reviewed for form and good faith, ` +
            `never for whether the view is right. Once admitted it is shown on the node's page under that name, ` +
            `in these words, with the stake declared` +
            (parsed.view.reasons ? ", and its reasons go to the node's Steward to be answered" : "") +
            `. A statement is not edited or withdrawn afterwards: a later one is shown as current and this one stays, dated.`,
        });
      },
    }
  );

  // GET /stated-views
  app.get<{ Querystring: Record<string, string> }>("/stated-views", {
    schema: {
      tags: ["stated views"],
      summary:
        "Views stated to the graph directly, each beside the judgment in force on its node: where they " +
        "differ and which way, where they agree, where the node has not been assessed, and where the two " +
        "cannot be compared",
      querystring: {
        type: "object",
        properties: {
          speaker_id: {
            type: "string",
            format: "uuid",
            description: "Only the statements of one account (a contributor id). Omit for every speaker.",
          },
          claim_id: {
            type: "string",
            format: "uuid",
            description: "Only the statements on one claim, quantity or question.",
          },
          relation: {
            type: "string",
            enum: [...VIEW_RELATIONS],
            description:
              "Only the statements that stand this way to the judgment: differs, agrees, not_assessed " +
              "(the node has no judgment yet, which is not agreement), or not_comparable.",
          },
          earlier: {
            type: "boolean",
            description:
              "With claim_id: also the earlier statements a speaker has since restated, marked current: false, " +
              "and any the node's Steward detached. Leaves out summary and paging.",
          },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
      response: { 200: looseObject, 422: errorEnvelope },
    },
    handler: async (request, reply) => {
      const params = listParams.parse(request.query);
      const how =
        "Each statement is its speaker's, in its own words; the judgment beside it is the graph's. `comparison` " +
        "reads only what each recorded (a stance with a status, a probability with a credence, a figure with an " +
        `estimate's range) and never the statement's words or reasons. A stated probability counts as differing ` +
        `when it is ${PROBABILITY_GAP} or more from the credence. Where it is shown gives a statement no weight in ` +
        "the assessment.";
      if (params.earlier) {
        if (!params.claim_id) {
          return reply.code(422).send({
            error: { code: "CLAIM_ID_REQUIRED", message: "earlier goes with claim_id: the node whose every statement is wanted." },
          });
        }
        return reply.send({ stated_views: await statedViewsForClaim(params.claim_id), how_to_read: how });
      }
      const list = await listStatedViews({
        speakerId: params.speaker_id,
        claimId: params.claim_id,
        relation: params.relation,
        limit: params.limit,
        offset: params.offset,
      });
      return reply.send({ ...list, how_to_read: how });
    },
  });
}
