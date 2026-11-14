/**
 * Owls a deployment creates for itself, and its standing mandates
 * (docs/accounts.md, "Owls a deployment creates for itself").
 *
 * Mounted only in a members-only deployment (server/app.ts), so the public
 * graph has none of these.
 *
 *   GET  /standing-mandates: the General mandate, and whether it has
 *     been set up. Any member.
 *   POST /standing-mandates/:name: set it up, in place of the seed
 *     script and the operator key the public graph uses.
 *
 * And only where the deployment creates its own owls (OWLS=created):
 *
 *   GET  /owls/created: how much has been created, by whom, and how
 *     much has been spent. Any member.
 *   POST /owls/created: create owls into an account's balance or a
 *     mandate's budget.
 *
 * The two writes need the permission to administer and a signed-in
 * session, like every administrative write (routes/permissions.ts): a key
 * that leaked, or an agent following text it read, must not be able to
 * create a budget. So they are not MCP tools; the reads are. Each write is
 * logged in `administrative_events`, which every member can read
 * (GET /permissions/log).
 */
import type { FastifyInstance } from "fastify";
import { requirePermission } from "../server/require-permission.js";
import { CREATED_OWLS_STATEMENT, owlsCreatedHere } from "../services/owl.js";
import {
  OWL_CREATION_NOTE_MAX_CHARS,
  createOwls,
  createdOwlsSummary,
  isStandingMandateName,
  listStandingMandates,
  setUpStandingMandate,
} from "../services/owl-creation-service.js";

const UUID = { type: "string", format: "uuid" } as const;

export async function standingMandateRoutes(app: FastifyInstance): Promise<void> {
  const member = [app.authenticate, app.requireUser];
  const administratorSession = [
    app.authenticate,
    app.requireSession,
    app.requireUser,
    requirePermission("administer"),
  ];

  app.get("/standing-mandates", {
    schema: {
      tags: ["mandates"],
      summary:
        "The deployment's standing mandate, General, and whether it has been set up",
      description:
        "General pays for the upkeep whose value is spread across the whole graph, the audits of " +
        "the graph's decisions among it. Until it is set up, upkeep and audits have no mandate " +
        "to fund them. Where the deployment holds material at more than one label, `by_label` " +
        "says, for each label the caller reads, whether it is set up there: a mandate's work " +
        "runs at its label.",
    },
    preHandler: member,
    handler: async (_request, reply) =>
      reply.send({ standing_mandates: await listStandingMandates() }),
  });

  app.post<{
    Params: { name: string };
    Body: { budget_owls?: number; daily_owls?: number };
  }>("/standing-mandates/:name", {
    schema: {
      tags: ["mandates"],
      summary:
        "Set up the General mandate (administrators, from a signed-in session)",
      description:
        "Creates the mandate with its starting operating policy, which its Grantmaker revises " +
        "from then on. Where this deployment creates its own owls, budget_owls is created " +
        "with it and the act is logged; where owls are sold, leave it out and fund the " +
        "mandate from a balance. daily_owls sets its pace: at most that many owls committed in " +
        "any rolling day, or 0 for as needed, where the budget is the only bound; left out, it " +
        "starts at 30 owls a day. Its Grantmaker may change the pace from then on. Where the " +
        "deployment holds material at more than one label, `label` names the label the mandate " +
        "works at: a mandate's work runs at its label, so each label whose upkeep or audits are " +
        "to be paid for has a General mandate of its own, set up by an administrator who reads it.",
      params: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", enum: ["general"] } },
      },
      body: {
        type: "object",
        properties: {
          budget_owls: { type: "number", minimum: 0 },
          daily_owls: { type: "number", minimum: 0 },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const name = request.params.name;
      if (!isStandingMandateName(name)) {
        return reply.code(404).send({ error: "The standing mandate is general.", code: "NOT_FOUND" });
      }
      const result = await setUpStandingMandate({
        name,
        actorId: request.auth!.userId!,
        budgetOwls: request.body?.budget_owls,
        dailyOwls: request.body?.daily_owls,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "ALREADY_SET_UP" ? 409 : 400)
          .send({ error: result.message, code: result.code });
      }
      const all = await listStandingMandates();
      return reply.code(201).send({ standing_mandate: all.find((m) => m.name === name) });
    },
  });
}

export async function createdOwlRoutes(app: FastifyInstance): Promise<void> {
  // Registered only where the deployment creates its own owls; the check
  // here is so that the file cannot be mounted by mistake where it sells them.
  if (!owlsCreatedHere()) return;

  const member = [app.authenticate, app.requireUser];
  const administratorSession = [
    app.authenticate,
    app.requireSession,
    app.requireUser,
    requirePermission("administer"),
  ];

  app.get<{ Querystring: { limit?: number } }>("/owls/created", {
    schema: {
      tags: ["billing"],
      summary:
        "How many owls this deployment's administrators have created, who created them, and how many its runs have spent",
      description:
        `${CREATED_OWLS_STATEMENT} Any member may read this. There is no ceiling on what an ` +
        "administrator may create, because it is the organization's own budget; what stands " +
        "in a ceiling's place is that every act is listed here with who made it.",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Acts to list, newest first (default 50)" },
        },
      },
    },
    preHandler: member,
    handler: async (request, reply) => reply.send(await createdOwlsSummary(request.query.limit ?? 50)),
  });

  app.post<{
    Body: { amount_owls: number; account_id?: string; mandate_id?: string; note?: string };
  }>("/owls/created", {
    schema: {
      tags: ["billing"],
      summary:
        "Create owls into an account's balance or a mandate's budget (administrators, from a signed-in session)",
      description:
        `${CREATED_OWLS_STATEMENT} Name one recipient: account_id, whose holder can then put ` +
        "the owls behind mandates if they hold the permission to fund, or mandate_id, whose " +
        "budget grows at once (a mandate at a label the administrator reads). The act is logged " +
        "with the amount, the recipient and who made it, and every member can read the log; a " +
        "mandate at a label a reader does not read is named there by its id alone.",
      body: {
        type: "object",
        required: ["amount_owls"],
        properties: {
          amount_owls: { type: "number", exclusiveMinimum: 0 },
          account_id: UUID,
          mandate_id: UUID,
          note: {
            type: "string",
            maxLength: OWL_CREATION_NOTE_MAX_CHARS,
            description: "What the owls are for, shown with the act in the log",
          },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await createOwls({
        actorId: request.auth!.userId!,
        amountOwls: request.body.amount_owls,
        accountId: request.body.account_id ?? null,
        mandateId: request.body.mandate_id ?? null,
        note: request.body.note ?? null,
      });
      if (!result.ok) {
        const status = result.code.endsWith("_NOT_FOUND") ? 404 : result.code === "MANDATE_NOT_OPEN" ? 409 : 400;
        return reply.code(status).send({ error: result.message, code: result.code });
      }
      return reply.code(201).send({
        created_owls: result.amount_owls,
        ...(result.account ? { account: result.account } : {}),
        ...(result.mandate ? { mandate: result.mandate } : {}),
      });
    },
  });
}
