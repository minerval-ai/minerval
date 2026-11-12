import crypto from "crypto";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { loadConfig } from "../config.js";
import { featureOn } from "../features.js";
import { registerSwagger } from "./plugins/swagger.js";
import { registerCors } from "./plugins/cors.js";
import { registerAuth } from "./plugins/auth.js";
import { registerQuota } from "./plugins/quota.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerRouteCatalog } from "./plugins/route-catalog.js";
import { registerPartialResponse } from "./plugins/partial-response.js";
import { registerPublicRead } from "./plugins/public-read.js";
import { registerClaimAliasResolution } from "./plugins/claim-alias.js";
import { registerAnonymousRateLimit } from "./plugins/anonymous-rate-limit.js";
import { healthRoutes } from "../routes/health.js";
import { claimRoutes } from "../routes/claims.js";
import { argumentRoutes } from "../routes/arguments.js";
import { formalizationsRoutes } from "../routes/formalizations.js";
import { attemptsRoutes } from "../routes/attempts.js";
import { setupRoutes } from "../routes/setup.js";
import { preflightRoutes } from "../routes/preflight.js";
import { runRoutes } from "../routes/runs.js";
import { prizesRoutes } from "../routes/prizes.js";
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
import { queueRoutes } from "../routes/queue.js";
import { monitorRoutes } from "../routes/monitors.js";
import { changeRoutes } from "../routes/changes.js";
import { sqlRoutes } from "../routes/sql.js";
import { correspondentRoutes } from "../routes/correspondents.js";
import { consistencyRoutes } from "../routes/consistency.js";
import { grantRoutes } from "../routes/grants.js";
import { grantConversationRoutes } from "../routes/grant-conversations.js";
import { assistantRoutes } from "../routes/assistant.js";
import { pageRoutes } from "../routes/pages.js";
import { mandateRoutes } from "../routes/mandates.js";
import { platformMandateRoutes } from "../routes/platform-mandates.js";
import { reportRoutes } from "../routes/reports.js";
import { findingRoutes } from "../routes/findings.js";
import { tagRoutes } from "../routes/tags.js";
import { requestRoutes } from "../routes/requests.js";

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
  // The per-address limit on requests with no recognised credential.
  await registerAnonymousRateLimit(app);
  // `fields=` on GET routes. Before the catalog, so the catalog (and the MCP
  // tools built from it) records each GET route with `fields` in its schema.
  await registerPartialResponse(app);
  // A merged id on /claims/:claim_id resolves to its survivor on reads and
  // is refused on writes (#884). After `fields=`, so `resolved_from` is
  // served whatever a caller trims the response to.
  await registerClaimAliasResolution(app);
  // Before any route: MCP builds its route tools from the catalog.
  await registerRouteCatalog(app);
  // Before any route too: it classifies each route as it registers and
  // attaches the cache policy (public reads cacheable, the rest no-store).
  await registerPublicRead(app);

  // Routes
  await app.register(healthRoutes);
  await app.register(claimRoutes, { prefix: "/claims" });
  await app.register(argumentRoutes, { prefix: "/arguments" });
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
  await app.register(queueRoutes, { prefix: "/queue" });
  await app.register(monitorRoutes, { prefix: "/monitors" });
  // The change stream (#562) and Correspondents (#563).
  await app.register(changeRoutes, { prefix: "/changes" });
  await app.register(sqlRoutes, { prefix: "/sql" });
  await app.register(correspondentRoutes, { prefix: "/correspondents" });
  // The Consistency Checker's record (#330): sweeps, flags, precision.
  await app.register(consistencyRoutes, { prefix: "/consistency" });
  await app.register(grantRoutes, { prefix: "/grants" });
  await app.register(grantConversationRoutes, {
    prefix: "/grant-conversations",
  });
  // The Assistant (#646): a user's conversations with their own agent.
  await app.register(assistantRoutes, { prefix: "/assistant" });
  // Pages (#646): what an agent saves for a user to keep.
  await app.register(pageRoutes, { prefix: "/pages" });
  await app.register(mandateRoutes, { prefix: "/mandates" });
  // Operator-key routes for platform mandates (#529): fund a pinned draft,
  // and mint the key that holds the platform's granting conversations.
  await app.register(platformMandateRoutes, { prefix: "/operator" });
  await app.register(reportRoutes, { prefix: "/reports" });
  await app.register(findingRoutes, { prefix: "/findings" });
  await app.register(tagRoutes, { prefix: "/tags" });
  // The versioned setups agent runs ran under (#552 groundwork).
  await app.register(setupRoutes, { prefix: "/setup" });
  // Whether this deployment is ready to run, for its operator (src/preflight.ts).
  await app.register(preflightRoutes, { prefix: "/setup" });
  // Agent runs (#553): public ones in full, the rest withheld with reasons.
  await app.register(runRoutes, { prefix: "/runs" });
  await app.register(requestRoutes, { prefix: "/requests" });
  await app.register(mcpRoutes, { prefix: "/mcp" });
  // The route groups of a feature are mounted only while it is on
  // (src/features.ts). A route that is not mounted is not an MCP tool
  // either: the tools are built from the catalog of mounted routes.
  //
  // The mathematics surfaces span /claims/:id/..., /attempts, /prizes,
  // /prize-claims, /bounties, /lean-checks, and /attachments,
  // so they register without a prefix (docs/mathematics.md §11.1).
  if (featureOn("mathematics", config)) {
    await app.register(formalizationsRoutes);
    await app.register(attemptsRoutes);
  }
  if (featureOn("prizes", config)) {
    await app.register(prizesRoutes);
  }
  // OAuth endpoints live at absolute paths (/.well-known/*, /oauth/*), so no prefix.
  await app.register(oauthRoutes);
  if (featureOn("extension", config)) {
    await app.register(extensionRoutes, { prefix: "/extension" });
  }

  return app;
}
