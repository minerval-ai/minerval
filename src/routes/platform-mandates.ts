/**
 * Operator routes for platform mandates (#529), registered under /operator.
 *
 *   POST   /operator/platform-mandates/fund       fund a platform
 *     conversation's drafted mandate under a public approval: buy the
 *     budget at cost, escrow it, create the grant (is_platform) with the
 *     approval recorded. Called by the workflow that runs after a merged
 *     pull request adds a request file under mandates/platform/.
 *   POST   /operator/platform-grantmaking-keys    mint the key that holds
 *     the platform's granting conversations (plaintext returned once).
 *   GET    /operator/platform-grantmaking-keys    list those keys.
 *   DELETE /operator/platform-grantmaking-keys/:id  revoke one.
 *
 * Every route requires the operator key (requireOperator) and nothing else:
 * the service key acts for any user through the acting-user header, so it
 * cannot be what moves the platform's money or mints its credentials.
 * Nothing here designs a mandate: the Grantmaker does that in the
 * conversation, and this route funds only the draft the approval pinned.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createPlatformGrantmakingKey,
  fundPlatformConversation,
  listPlatformGrantmakingKeys,
  revokePlatformGrantmakingKey,
} from "../services/platform-mandate-service.js";
import { serializeKey } from "./api-keys.js";

function operatorActor(request: FastifyRequest): string {
  const who = request.headers["x-operator-actor"];
  const name = Array.isArray(who) ? who[0] : who;
  return (name ?? "").toString().trim().slice(0, 120) || "operator";
}

export async function platformMandateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      conversation_id: string;
      budget_owls: number;
      mandate_sha256: string;
      approval_url: string;
      approved_by: string;
    };
  }>("/platform-mandates/fund", {
    schema: {
      tags: ["grants"],
      summary:
        "Fund a platform conversation's drafted mandate under a public approval (operator key)",
      body: {
        type: "object",
        required: [
          "conversation_id",
          "budget_owls",
          "mandate_sha256",
          "approval_url",
          "approved_by",
        ],
        properties: {
          conversation_id: { type: "string", format: "uuid" },
          budget_owls: { type: "number", exclusiveMinimum: 0, maximum: 10000 },
          mandate_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          approval_url: { type: "string", minLength: 1, maxLength: 500 },
          approved_by: { type: "string", minLength: 1, maxLength: 120 },
        },
      },
    },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const body = request.body;
      const result = await fundPlatformConversation({
        conversationId: body.conversation_id,
        budgetOwls: body.budget_owls,
        mandateSha256: body.mandate_sha256,
        approvalUrl: body.approval_url,
        approvedBy: body.approved_by,
      });
      if (!result.ok) {
        const status =
          result.code === "NOT_FOUND"
            ? 404
            : result.code === "BAD_APPROVAL"
              ? 400
              : 409;
        return reply
          .code(status)
          .send({ error: result.message, code: result.code });
      }
      request.log.info(
        {
          operator: operatorActor(request),
          conversation_id: body.conversation_id,
          grant_id: result.grantId,
          budget_owls: body.budget_owls,
          approval_url: body.approval_url,
          already_funded: result.alreadyFunded,
        },
        "platform mandate funded under a public approval"
      );
      return reply.code(result.alreadyFunded ? 200 : 201).send({
        grant_id: result.grantId,
        already_funded: result.alreadyFunded,
      });
    },
  });

  app.post<{ Body: { name: string } }>("/platform-grantmaking-keys", {
    schema: {
      tags: ["grants"],
      summary:
        "Mint a key that holds the platform's granting conversations and nothing else (operator key; plaintext returned once)",
      body: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const created = await createPlatformGrantmakingKey(request.body.name.trim());
      request.log.info(
        { operator: operatorActor(request), key_id: created.key.id },
        "platform-grantmaking key minted"
      );
      return reply
        .code(201)
        .send({ key: serializeKey(created.key), plaintext: created.plaintext });
    },
  });

  app.get("/platform-grantmaking-keys", {
    schema: {
      tags: ["grants"],
      summary: "List the platform-grantmaking keys (operator key)",
    },
    preHandler: [app.requireOperator],
    handler: async (_request, reply) => {
      const keys = await listPlatformGrantmakingKeys();
      return reply.send({ keys: keys.map(serializeKey) });
    },
  });

  app.delete<{ Params: { id: string } }>("/platform-grantmaking-keys/:id", {
    schema: {
      tags: ["grants"],
      summary: "Revoke a platform-grantmaking key (operator key)",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const revoked = await revokePlatformGrantmakingKey(request.params.id);
      if (!revoked) {
        return reply.code(404).send({
          error: "No live platform-grantmaking key has that id",
          code: "NOT_FOUND",
        });
      }
      request.log.info(
        { operator: operatorActor(request), key_id: revoked.id },
        "platform-grantmaking key revoked"
      );
      return reply.send({ key: serializeKey(revoked) });
    },
  });
}
