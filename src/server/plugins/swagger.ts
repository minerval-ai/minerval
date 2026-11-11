import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../config.js";

/**
 * The API's description in the OpenAPI document. It states the terms an
 * anonymous caller works under (the cache policy and the rate limit, with
 * the reason for each) so nobody meets a limit they were not told about.
 * The figures come from config, the same values the server acts on.
 */
export function apiDescription(): string {
  const config = loadConfig();
  return [
    "Knowledge graph of claims, quantities, and questions with transparent provenance and assessment.",
    "",
    "**Public reads.** GET routes that need no key are open to any caller, " +
      "including a browser on another site: they answer " +
      "`access-control-allow-origin: *`. Asked without credentials, a " +
      "successful read may be reused for a short time " +
      `(\`cache-control: public, max-age=${config.publicReadMaxAgeSeconds}, ` +
      `stale-while-revalidate=${config.publicReadStaleWhileRevalidateSeconds}\`) ` +
      "and carries an `ETag`; send it back in `If-None-Match` to get a `304` " +
      "when nothing changed. So an anonymous read can be about a minute behind " +
      "the graph. A request that presents a key is never cached and is always " +
      "answered fresh.",
    "",
    "**Anonymous rate limit.** Requests without credentials are limited to " +
      `${config.anonymousRateLimitPerMinute} requests per minute per IP address. ` +
      "Every counted response says so in `RateLimit-Policy: " +
      `${config.anonymousRateLimitPerMinute};w=60\`; past the limit the answer ` +
      "is `429` with `Retry-After` and a body that restates the limit. The " +
      "reason: an account's use is bounded by its budget, and an anonymous " +
      "caller has no account or budget to bound it, so a count per address is " +
      "the only measure there is. Requests that present a valid API key are " +
      "not subject to this limit; an unrecognised key is counted like no key. " +
      "Each API instance counts on its own, and reads answered from the edge " +
      "cache are not counted, so the limit is a floor on what one address may " +
      "ask, not an exact quota.",
  ].join("\n");
}

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  const swagger = await import("@fastify/swagger");
  const swaggerUi = await import("@fastify/swagger-ui");

  await app.register(swagger.default, {
    openapi: {
      info: {
        title: "Minerval API",
        description: apiDescription(),
        version: "0.1.0",
      },
      tags: [
        { name: "health", description: "Health check" },
        { name: "claims", description: "Claim management" },
        { name: "sources", description: "Source submission" },
        { name: "jobs", description: "Job status tracking" },
      ],
    },
  });

  await app.register(swaggerUi.default, {
    routePrefix: "/docs",
  });
}
