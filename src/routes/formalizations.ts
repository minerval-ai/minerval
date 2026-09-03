/**
 * Routes for the formalizations surfaces (docs/mathematics.md §11.1). Registered without
 * a prefix because the paths span /claims, /formalizations, and the record routes. The
 * handlers arrive with their slice.
 */
import type { FastifyInstance } from "fastify";

export async function formalizationsRoutes(_app: FastifyInstance): Promise<void> {}
