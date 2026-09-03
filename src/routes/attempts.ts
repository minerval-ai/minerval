/**
 * Routes for the attempts surfaces (docs/mathematics.md §11.1). Registered without
 * a prefix because the paths span /claims, /attempts, and the record routes. The
 * handlers arrive with their slice.
 */
import type { FastifyInstance } from "fastify";

export async function attemptsRoutes(_app: FastifyInstance): Promise<void> {}
