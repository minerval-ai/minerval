import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../config.js";

/**
 * The origins CORS is restricted to, or null when the API is open to every
 * origin (the default). Only production honours CORS_ORIGINS, as before.
 */
export function restrictedCorsOrigins(): string[] | null {
  const config = loadConfig();
  if (config.env !== "production" || !config.corsOrigins) return null;
  const origins = config.corsOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : null;
}

/**
 * CORS, on purpose: the public reads are a browser-facing surface, so any
 * site may call them from the page (docs/infrastructure.md, "Request flow").
 *
 * The answer is `access-control-allow-origin: *`, not the caller's origin
 * reflected back. Cloudflare caches the public reads and does not key its
 * cache on `Vary: Origin`, so a reflected origin stored at the edge would be
 * served to the next site that asks, and the browser there would refuse it.
 * `*` is safe because no route reads a cookie: credentials travel only in
 * the x-api-key and Authorization headers, which a page has to set itself.
 *
 * CORS_ORIGINS still restricts the API to a list of origins. That brings
 * the reflected origin back, so public reads then stay out of shared caches
 * (src/server/plugins/public-read.ts).
 */
export async function registerCors(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin: restrictedCorsOrigins() ?? "*",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  });
}
