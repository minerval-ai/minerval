import crypto from "crypto";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { loadConfig } from "../config.js";
import { registerSwagger } from "./plugins/swagger.js";
import { registerCors } from "./plugins/cors.js";
import { registerAuth } from "./plugins/auth.js";
import { registerQuota } from "./plugins/quota.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { healthRoutes } from "../routes/health.js";
import { claimRoutes } from "../routes/claims.js";
import { sourceRoutes } from "../routes/sources.js";
import { jobRoutes } from "../routes/jobs.js";
import { contributionRoutes } from "../routes/contributions.js";
import { appealRoutes } from "../routes/appeals.js";
import { userRoutes } from "../routes/users.js";
import { contributorRoutes } from "../routes/contributors.js";
import { apiKeyRoutes } from "../routes/api-keys.js";
import { usageRoutes } from "../routes/usage.js";
import { billingRoutes } from "../routes/billing.js";
import { mcpRoutes } from "../routes/mcp.js";
import { oauthRoutes } from "../routes/oauth.js";
import { extensionRoutes } from "../routes/extension.js";
import { orderRoutes } from "../routes/orders.js";
import { budgetJobRoutes } from "../routes/budget-jobs.js";

export async function buildApp() {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        config.env === "development"
          ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss Z" } }
          : undefined,
      redact:
        config.env === "production"
          ? ["req.headers.authorization", 'req.headers["x-api-key"]']
          : undefined,
    },
    genReqId: () => crypto.randomUUID(),
  });

  // Plugins (swagger must be registered before routes)
  // The OAuth token endpoint speaks application/x-www-form-urlencoded (RFC 6749).
  await app.register(formbody);
  await registerSwagger(app);
  await registerCors(app);
  await registerAuth(app);
  await registerQuota(app);
  await registerErrorHandler(app);

  // Routes
  await app.register(healthRoutes);
  await app.register(claimRoutes, { prefix: "/claims" });
  await app.register(sourceRoutes, { prefix: "/sources" });
  await app.register(jobRoutes, { prefix: "/jobs" });
  await app.register(contributionRoutes, { prefix: "/contributions" });
  await app.register(appealRoutes, { prefix: "/appeals" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(contributorRoutes, { prefix: "/contributors" });
  await app.register(apiKeyRoutes, { prefix: "/api-keys" });
  await app.register(usageRoutes, { prefix: "/usage" });
  await app.register(billingRoutes, { prefix: "/billing" });
  await app.register(orderRoutes, { prefix: "/orders" });
  await app.register(budgetJobRoutes, { prefix: "/budget-jobs" });
  await app.register(mcpRoutes, { prefix: "/mcp" });
  // OAuth endpoints live at absolute paths (/.well-known/*, /oauth/*), so no prefix.
  await app.register(oauthRoutes);
  await app.register(extensionRoutes, { prefix: "/extension" });

  return app;
}
