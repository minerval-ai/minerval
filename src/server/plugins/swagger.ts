import type { FastifyInstance } from "fastify";

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  const swagger = await import("@fastify/swagger");
  const swaggerUi = await import("@fastify/swagger-ui");

  await app.register(swagger.default, {
    openapi: {
      info: {
        title: "Minerval API",
        description:
          "Knowledge graph of claims with transparent provenance and validity assessment",
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
