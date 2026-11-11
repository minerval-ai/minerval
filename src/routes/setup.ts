/**
 * /setup: the versioned parts of the setups agent runs ran under
 * (services/setup-service.ts). Read-only and public, like claim reads.
 *
 *   GET /setup/parts                         every part's versions, newest
 *     first: kind, name, version, hash, when and under which commit it was
 *     first seen, and its source file at that commit. No text.
 *   GET /setup/parts/:kind/:name/:version    one version, with its text when
 *     the part is public (the constitution, role prompts matching the code).
 *   GET /setup/prompt-set                    the prompt set this deployment's
 *     code builds: one hash over the constitution, every role prompt and
 *     every skill, with the hash of each (services/prompt-set.ts).
 *   GET /setup/features                      the optional parts of the
 *     product (src/features.ts), each with whether this deployment has it
 *     on and what switching it off removes.
 */
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config.js";
import { FEATURE_NAMES, listFeatures } from "../features.js";
import { getPromptSet } from "../services/prompt-set.js";
import { getSetupPart, listSetupParts } from "../services/setup-service.js";

const KINDS = ["constitution", "role", "tool"] as const;

const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

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

  app.get("/prompt-set", {
    schema: {
      tags: ["setup"],
      summary:
        "The prompt set this deployment runs: one hash over the constitution, every role " +
        "prompt and every skill, with each one's own hash. A run names the prompt set it " +
        "ran under (get_run, setup.promptSet), and its role part's hash is one of these " +
        "when the run was given the published prompt",
      response: {
        200: {
          type: "object",
          properties: {
            format: { type: "integer" },
            hash: HASH,
            // The commit the running code was built from, when it is known.
            commit: { type: "string", nullable: true },
            constitution: {
              type: "object",
              properties: { hash: HASH, source_path: { type: "string" } },
            },
            roles: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  source_path: { type: "string" },
                  // The role's system blocks in order, hashed as a run's role parts are.
                  blocks: { type: "array", items: HASH },
                },
              },
            },
            skills: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  version: { type: "integer" },
                  hash: HASH,
                },
              },
            },
          },
        },
      },
    },
    handler: async (_request, reply) =>
      reply.send({ ...getPromptSet(), commit: loadConfig().gitSha ?? null }),
  });

  app.get("/features", {
    schema: {
      tags: ["setup"],
      summary:
        "The optional parts of the product and whether this deployment has each one on. " +
        "A feature that is off has no routes mounted, no tools offered and no workers " +
        "started here, so a tool or route missing from this deployment is explained by " +
        "this list",
      response: {
        200: {
          type: "object",
          properties: {
            features: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", enum: [...FEATURE_NAMES] },
                  on: { type: "boolean" },
                  // What the feature is, and what switching it off removes.
                  description: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    handler: async (_request, reply) => reply.send({ features: listFeatures() }),
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
