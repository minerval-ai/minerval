/**
 * /setup: the versioned parts of the setups agent runs ran under
 * (services/setup-service.ts). Read-only and public, like claim reads.
 *
 *   GET /setup/parts                         every part's versions, newest
 *     first: kind, name, version, hash, when and under which commit it was
 *     first seen, and its source file at that commit. No text.
 *   GET /setup/parts/:kind/:name/:version    one version, with its text when
 *     the part is public (the constitution, role prompts matching the code).
 */
import type { FastifyInstance } from "fastify";
import { getSetupPart, listSetupParts } from "../services/setup-service.js";

const KINDS = ["constitution", "role", "tool"] as const;

const PART_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...KINDS] },
    name: { type: "string" },
    version: { type: "integer" },
    hash: { type: "string" },
    public: { type: "boolean" },
    first_seen_at: { type: "string", format: "date-time" },
    first_seen_commit: { type: "string", nullable: true },
    source_path: { type: "string", nullable: true },
    source_url: { type: "string", nullable: true },
  },
} as const;

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { kind?: string; name?: string; hash?: string } }>("/parts", {
    schema: {
      tags: ["setup"],
      summary:
        "The versioned parts agent runs were set up with (constitution, role prompts, " +
        "tools): every version, newest first, with the commit it was first seen under",
      querystring: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...KINDS] },
          name: { type: "string", maxLength: 200 },
          // A run's setup record names its parts by kind and hash.
          hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: { parts: { type: "array", items: PART_SCHEMA } },
        },
      },
    },
    handler: async (request, reply) => {
      const parts = await listSetupParts({
        kind: request.query.kind,
        name: request.query.name,
        hash: request.query.hash,
      });
      return reply.send({ parts });
    },
  });

  app.get<{ Params: { kind: string; name: string; version: number } }>(
    "/parts/:kind/:name/:version",
    {
      schema: {
        tags: ["setup"],
        summary:
          "One version of a setup part, with its text when the part is public; " +
          "previous_version names the version to compare against",
        params: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...KINDS] },
            name: { type: "string", maxLength: 200 },
            version: { type: "integer", minimum: 1 },
          },
          required: ["kind", "name", "version"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ...PART_SCHEMA.properties,
              // Null when the part is not public: recorded by hash only.
              content: { type: "string", nullable: true },
              previous_version: { type: "integer", nullable: true },
            },
          },
        },
      },
      handler: async (request, reply) => {
        const { kind, name, version } = request.params;
        const part = await getSetupPart(kind, name, version);
        if (!part) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: `No version ${version} of ${kind} "${name}"`,
              request_id: request.id,
            },
          });
        }
        return reply.send(part);
      },
    }
  );
}
