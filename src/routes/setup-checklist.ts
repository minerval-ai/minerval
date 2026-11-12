/**
 * GET /setup/checklist: what a members-only deployment's administrators
 * read to see what has been set up and what is still to do
 * (services/setup-checklist-service.ts; docs/deployment.md, "The setup
 * checklist"). Mounted only where READS=members (server/app.ts), so the
 * public graph does not have it.
 *
 * It carries the preflight's report. The preflight's own route
 * (routes/preflight.ts) takes the operator key, because a deployment being
 * installed has no accounts yet and its answer is for whoever runs it.
 * Once a deployment has administrators they are who sets it up, and the
 * web tier, which they work through, does not hold the operator key. So
 * the same report is served here to a holder of the permission to
 * administer. The operator's route is unchanged.
 *
 * A read, and an MCP tool like the other administrators' reads
 * (mcp/route-tools.ts). Each call runs the preflight's checks afresh, the
 * run log's test included.
 */
import type { FastifyInstance } from "fastify";
import { requirePermission } from "../server/require-permission.js";
import { setupChecklist } from "../services/setup-checklist-service.js";

export async function setupChecklistRoutes(app: FastifyInstance): Promise<void> {
  app.get("/setup/checklist", {
    schema: {
      tags: ["setup"],
      summary:
        "What this deployment's setup has done and what is still to do, as facts it can see about itself (administrators)",
      description:
        "One read for the administrators of a members-only deployment. `preflight` is the " +
        "preflight's report: each check with pass, fail or not applicable and a sentence saying " +
        "why, and whether agent work may start. `permissions` says how many accounts and groups " +
        "hold each permission now, by label and by party where the permission is granted at one. " +
        "`labels` lists every label besides public with the model providers and outside services " +
        "cleared to receive text at it, and the roles whose model's provider is not cleared, " +
        "whose runs at that label are refused. `undefined_labels_in_provider_setting` names " +
        "labels the provider setting uses that are not defined here; while there is one, every " +
        "call to a provider is refused. `standing_mandates` are the General and Governance " +
        "mandates and whether each is set up. `owls` says whether the deployment creates its own " +
        "owls and which configured models have no price. `usage_report` says whether usage is " +
        "reported, where to, and how many reports wait to be sent. `connections` counts the " +
        "connections and names those that need a look. `material` counts the sources recorded, " +
        "by the party each belongs to, the submitted sources waiting for review, and the nodes " +
        "the graph holds. Nothing here is marked done because a person said so, and no row's " +
        "label is returned.",
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission("administer")],
    handler: async (_request, reply) => reply.send(await setupChecklist()),
  });
}
