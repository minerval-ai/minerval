/**
 * Routes for the prizes surfaces (docs/mathematics.md §11.1). Registered without
 * a prefix because the paths span /claims, /prizes, and the record routes. The
 * handlers arrive with their slice.
 */
import type { FastifyInstance } from "fastify";

export async function prizesRoutes(_app: FastifyInstance): Promise<void> {}
