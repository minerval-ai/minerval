/**
 * API-key management (#70). Users mint, name, and revoke keys from the
 * dashboard. The plaintext key is returned exactly once, at creation.
 *
 * Creation and revocation require dashboard-session trust (requireSession):
 * a leaked consumer key must never be able to mint fresh keys or revoke
 * others. Listing is allowed to any resolved user identity.
 */
import type { FastifyInstance } from "fastify";
import type { ApiKey } from "../db/schema.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../services/api-key-service.js";

export function serializeKey(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    key_prefix: key.keyPrefix,
    scope: key.scope,
    created_at: key.createdAt?.toISOString(),
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
  };
}

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  // GET /api-keys — list the acting user's keys (metadata only, never hashes).
  app.get("/", {
    schema: {
      tags: ["api-keys"],
      summary: "List the authenticated user's API keys",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const keys = await listApiKeys(request.auth!.userId!);
      return reply.send({ keys: keys.map(serializeKey) });
    },
  });

  // POST /api-keys — mint a key. Returns the plaintext ONCE.
  app.post("/", {
    schema: {
      tags: ["api-keys"],
      summary: "Create an API key (plaintext returned once)",
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireSession, app.requireUser],
    handler: async (request, reply) => {
      const { name } = request.body as { name: string };
      // Dashboard-minted keys are always consumer keys; service keys are
      // provisioned by operators out-of-band.
      const created = await createApiKey({
        userId: request.auth!.userId!,
        name,
        scope: "user",
      });
      return reply.code(201).send({
        key: created.plaintext,
        ...serializeKey(created.key),
      });
    },
  });

  // DELETE /api-keys/:key_id — revoke (soft; usage attribution is preserved).
  app.delete("/:key_id", {
    schema: {
      tags: ["api-keys"],
      summary: "Revoke an API key",
      params: {
        type: "object",
        required: ["key_id"],
        properties: { key_id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireSession, app.requireUser],
    handler: async (request, reply) => {
      const { key_id } = request.params as { key_id: string };
      const revoked = await revokeApiKey(request.auth!.userId!, key_id);
      if (!revoked) {
        return reply
          .code(404)
          .send({ error: "Key not found or already revoked" });
      }
      return reply.send({ revoked: serializeKey(revoked) });
    },
  });
}
