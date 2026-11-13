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
import { registerMembersOnly } from "./plugins/members-only.js";
import { registerRequestLabel } from "./plugins/request-label.js";
import { membersOnly } from "../permissions.js";
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
import { pageRoutes, sharedPageRoutes } from "../routes/pages.js";
import { mandateRoutes } from "../routes/mandates.js";
import { platformMandateRoutes } from "../routes/platform-mandates.js";
import { reportRoutes } from "../routes/reports.js";
import { findingRoutes } from "../routes/findings.js";
import { tagRoutes } from "../routes/tags.js";
import { requestRoutes } from "../routes/requests.js";
import { permissionRoutes } from "../routes/permissions.js";
import { showingRoutes } from "../routes/showings.js";
import { outboundRoutes } from "../routes/outbound.js";
import { outwardRoutes } from "../routes/outward.js";
import { publishedPageRoutes } from "../routes/published-pages.js";
import { mirrorRoutes } from "../routes/mirror.js";
import { mirrorRoles } from "../services/mirror-roles.js";
import { connectionRoutes } from "../routes/connections.js";
import { fileSetRoutes } from "../routes/file-sets.js";
import { setupChecklistRoutes } from "../routes/setup-checklist.js";
import { createdOwlRoutes, standingMandateRoutes } from "../routes/owls.js";
import { usageReportReceivingRoutes, usageReportSendingRoutes } from "../routes/usage-reports.js";
import { owlsCreatedHere } from "../services/owl.js";
import { statedViewRoutes } from "../routes/stated-views.js";

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
  // A members-only deployment authenticates every request here, before its
  // route runs, and resolves what it may do and read (src/permissions.ts).
  // After the rate limit, so a made-up key is counted before it costs a
  // lookup. On the public graph this registers nothing.
  await registerMembersOnly(app);
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
  // After the catalog, so the MCP tool built from a route has no `label`
  // parameter: gives each request that writes the label it works at, in a
  // members-only deployment (server/request-labels.ts). On the public graph
  // this registers nothing.
  await registerRequestLabel(app);

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
  await app.register(sharedPageRoutes, { prefix: "/shared-pages" });
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
  // The mirror feed (docs/mirror.md): mounted only on a deployment that is
  // configured to publish one or to apply one, and then only that side.
  // Registered before /mcp like every route that may be a tool.
  const mirror = mirrorRoles(config);
  if (mirror.publisher || mirror.applier) {
    await app.register(mirrorRoutes, { prefix: "/mirror" });
  }
  // Spans /claims and /stated-views, so no prefix.
  await app.register(statedViewRoutes);
  await app.register(mcpRoutes, { prefix: "/mcp" });
  // Permissions, parties and labels exist only where a deployment is
  // members-only (src/permissions.ts). The public graph mounts none of
  // these routes, so it has none of their tools either.
  if (membersOnly(config)) {
    await app.register(permissionRoutes);
    // Showing a page below its label needs a second label and the
    // permissions that say who may ask and who may release.
    await app.register(showingRoutes);
    // A page shown outside leaves from here (docs/published-pages.md).
    await app.register(outboundRoutes);
    await app.register(outwardRoutes);
    // Connections to an organization's own systems are an administrator's
    // to add (src/connections.ts), so they exist where administrators do.
    await app.register(connectionRoutes);
    // Sets of files are added by people who hold the permission to direct
    // (src/file-sets.ts), so they exist where permissions do.
    await app.register(fileSetRoutes);
    // The deployment's own standing mandates, set up by an administrator
    // in place of the seed script (routes/owls.ts), and what it reports of
    // its own owl spend (routes/usage-reports.ts).
    await app.register(standingMandateRoutes);
    await app.register(usageReportSendingRoutes);
    // Creating owls exists only where the deployment creates its own
    // (OWLS=created, which needs READS=members).
    if (owlsCreatedHere(config)) await app.register(createdOwlRoutes);
    // What the administrators read to see how far setup has got, the
    // preflight's report included (routes/setup-checklist.ts).
    await app.register(setupChecklistRoutes);
  }
  // Every graph admits pages other graphs publish, as sources their
  // publishers submit (docs/published-pages.md). It is the public graph
  // that these are built for and tested on.
  await app.register(publishedPageRoutes);
  // Where a private deployment's usage report is received. On every
  // deployment, and of use on the public graph, which private deployments
  // report to.
  await app.register(usageReportReceivingRoutes);
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
