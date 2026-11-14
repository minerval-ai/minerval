/**
 * API-key management (#70). Users mint, name, and revoke keys from the
 * dashboard. The plaintext key is returned exactly once, at creation.
 *
 * Creation and revocation require dashboard-session trust (requireSession):
 * a leaked consumer key must never be able to mint fresh keys or revoke
 * others. Listing is allowed to any resolved user identity.
 */
import type { FastifyInstance } from "fastify";
import { deploymentHoldsLabels } from "../db/client.js";
import type { ApiKey } from "../db/schema.js";
import { PUBLIC_LABEL } from "../labels.js";
import { membersOnly } from "../permissions.js";
import { LABEL_FIELD, chooseLabel } from "../server/plugins/request-label.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../services/api-key-service.js";

/**
 * `showLabel` is set where the deployment holds material at more than one
 * label: a key then says which label it works at (server/request-labels.ts).
 */
export function serializeKey(key: ApiKey, showLabel = false) {
  return {
    id: key.id,
    name: key.name,
    key_prefix: key.keyPrefix,
    scope: key.scope,
    ...(showLabel ? { label: key.workLabel } : {}),
    created_at: key.createdAt?.toISOString(),
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
  };
}

/** What the holder of keys is told where the deployment holds more than one label. */
export const KEY_LABEL_NOTE =
  "Each key works at one label, fixed when the key was made: requests made with it read what " +
  "that label reads and add material at that label only. A key made before this deployment " +
  "had a second label works at \"public\". To work at another label, make a new key for it.";

/** Whether keys say and take a label here: a members-only deployment with more than one. */
async function keysCarryLabels(): Promise<boolean> {
  return membersOnly() && (await deploymentHoldsLabels());
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
      const showLabel = await keysCarryLabels();
      return reply.send({
        keys: keys.map((k) => serializeKey(k, showLabel)),
        ...(showLabel ? { note: KEY_LABEL_NOTE } : {}),
      });
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
          // The label the key will work at. Only a members-only deployment
          // has the field: the public graph has one label.
          ...(membersOnly() ? { label: LABEL_FIELD } : {}),
        },
      },
    },
    preHandler: [app.authenticate, app.requireSession, app.requireUser],
    handler: async (request, reply) => {
      const { name, label } = request.body as { name: string; label?: unknown };
      // The person minting says which label the key works at, among the
      // labels they may read. Whoever holds the key afterwards, an agent
      // included, never chooses one.
      let workLabel = PUBLIC_LABEL;
      const showLabel = await keysCarryLabels();
      if (membersOnly()) {
        const chosen = chooseLabel(request.auth, label, showLabel);
        if ("refusal" in chosen) {
          const { status, ...body } = chosen.refusal;
          return reply.code(status).send(body);
        }
        workLabel = chosen.label ?? PUBLIC_LABEL;
      }
      // Dashboard-minted keys are always consumer keys; service keys are
      // provisioned by operators out-of-band.
      const created = await createApiKey({
        userId: request.auth!.userId!,
        name,
        scope: "user",
        workLabel,
      });
      return reply.code(201).send({
        key: created.plaintext,
        ...serializeKey(created.key, showLabel),
        ...(showLabel ? { note: KEY_LABEL_NOTE } : {}),
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
      return reply.send({ revoked: serializeKey(revoked, await keysCarryLabels()) });
    },
  });
}
