import type { FastifyInstance } from "fastify";
import { rawQuery } from "../db/client.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", {
    // The image's HEALTHCHECK calls this every 30 seconds (Dockerfile), and
    // the load balancer does in production. At info, each check would add
    // Fastify's `incoming request` and `request completed` lines, which soon
    // push the start-up lines docs/self-hosting.md says to look for off the
    // screen (#1091). Warnings and errors on this route still log, and so does
    // the failed database check below, which is on the app's own logger.
    logLevel: "warn",
    schema: {
      tags: ["health"],
      summary: "Health check",
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["healthy", "degraded"] },
            version: { type: "string" },
            db: { type: "string", enum: ["connected", "disconnected"] },
          },
        },
      },
    },
    handler: async (_request, reply) => {
      let dbStatus = "disconnected";
      try {
        await rawQuery("SELECT 1");
        dbStatus = "connected";
      } catch (err) {
        app.log.error({ err }, "Health check DB connection failed");
      }

      return reply.send({
        status: dbStatus === "connected" ? "healthy" : "degraded",
        version: process.env.npm_package_version ?? "0.1.0",
        db: dbStatus,
      });
    },
  });
}
