/**
 * /consistency (#330): the Consistency Checker's record, read-only.
 *
 * What an operator (or the Audit Agent's reader) needs to judge whether the
 * sweeps earn their spend: the partitions and when each was last swept,
 * the recent sweeps with their notes, the flags they raised with whether
 * the passes they bought moved anything, and the precision over all flags
 * (services/consistency-service.ts).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config.js";
import {
  consistencyPrecision,
  listConsistencyFlags,
  listPartitions,
  listSweeps,
} from "../services/consistency-service.js";

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

export async function consistencyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Record<string, string> }>(
    "/",
    {
      schema: {
        tags: ["consistency"],
        summary:
          "The Consistency Checker's record: partitions and coverage, recent " +
          "sweeps, their flags and what became of them, and precision (#330)",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { limit } = query.parse(request.query);
      const [partitions, sweeps, flags, precision] = await Promise.all([
        listPartitions(loadConfig().consistencyMinTagClaims),
        listSweeps(limit),
        listConsistencyFlags({ limit: limit * 5 }),
        consistencyPrecision(),
      ]);
      return reply.send({ precision, partitions, sweeps, flags });
    }
  );
}
