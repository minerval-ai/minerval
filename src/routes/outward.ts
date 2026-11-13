/**
 * A private graph acting on the public graph other than by showing a page,
 * and what comes back (docs/outward-acts.md). Mounted only where
 * READS=members, beside the outbound routes.
 *
 *   GET  /outside/account: the organization's account on the public graph:
 *     its public owls and its public mandates.
 *   GET  /outside/log: every act this deployment made on the public graph.
 *   GET  /outside/choices, PUT /outside/choices/:key: the standing choices
 *     about what goes out with nobody acting.
 *   GET  /outside/requests: the public graph's requests, from the mirror,
 *     with what this deployment has done about each.
 *   POST /outside/requests/:public_request_id/adopt: make one an ordinary
 *     request here. Says nothing outside.
 *   POST /outside/requests/adopted/:adoption_id/take-up, .../decline: say in
 *     public that the graph is taking it up; say later that it will not.
 *   POST /outside/mandates, POST /outside/mandates/conversations/:id/messages,
 *     GET /outside/mandates/conversations/:id: a new public mandate, in a
 *     person's own words to the public Grantmaker.
 *   POST /outside/mandates/conversations/:id/fund, POST
 *     /outside/mandates/:mandate_id/back: pay for one with public owls.
 *   POST /outside/nodes/:node_id/fund, .../raise: pay for the public
 *     assessment of a mirrored node, or ask a public mandate to.
 *   GET  /outside/keep-current, POST and DELETE /outside/keep-current/leave-out.
 *   GET  /outside/said-back: what the public said about published pages.
 *   GET  /outside/reports, POST /outside/reports/:sending_id/send, .../send-facts.
 *   POST /outside/work/:action_id/commission: pay for the reading of what
 *     the public said, or the redaction of a report.
 *
 * Where the line is. Every write here that reaches the public graph shows
 * something outside, so each takes a person who holds the permission for
 * it: in a signed-in session, or pressing the card the Assistant shows for
 * an outward act (llm/tools/assistant-tools.ts, kind send_outside). A key
 * or a token alone does not act. Two kinds of write are narrower still and
 * take the signed-in session itself, so they are not tools: words a person
 * writes for the outside (a mandate's scope, a message to the public
 * Grantmaker), because a draft an agent wrote would be an agent's words
 * leaving without redaction; and a standing choice, because it decides
 * what leaves from then on with nobody acting.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actingAsAssistant } from "../llm/assistant-acting.js";
import { rawQuery } from "../db/client.js";
import { requirePermission } from "../server/require-permission.js";
import { commissionAction } from "../services/commission-service.js";
import { inboundOverview } from "../services/inbound-service.js";
import { owlsToMicroUsd } from "../services/owl.js";
import {
  FUND_NODE_TOLD,
  OutwardError,
  PUBLIC_MANDATE_TOLD,
  STANDING_CHOICES,
  TAKE_UP_TOLD,
  adoptRequest,
  backPublicMandate,
  declineInPublic,
  fundPublicMandate,
  fundPublicNode,
  keepCurrentOverview,
  leaveOut,
  openPublicMandate,
  outwardLog,
  publicAccount,
  publicActsPermission,
  publicRequests,
  raisePublicNode,
  readPublicConversation,
  sayToPublicGrantmaker,
  setStandingChoice,
  standingChoices,
  takeBackLeaveOut,
  takeUpInPublic,
  type StandingChoiceKey,
} from "../services/outward-acts-service.js";
import { ReportSendingError, SEND_REPORT_TOLD, reportsOverview, sendFacts, sendReport } from "../services/report-sending-service.js";
import { DECLINE_REASONS } from "../services/request-take-up-service.js";
import { ownOrganizationParty } from "../services/showing-service.js";
import { actorOf } from "./outbound.js";

const UUID = { type: "string", format: "uuid" } as const;
const TAG = ["the public graph, from inside"];

export async function outwardRoutes(app: FastifyInstance): Promise<void> {
  const signedIn = [app.authenticate, app.requireUser];
  const acts = publicActsPermission();
  /** A person is present: a signed-in session, or the Assistant acting on a card its user pressed or a kind of act they allowed. */
  const personPresent = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    const isSession = auth?.isSession === true || (auth?.method === "dev_bypass" && auth.userId !== null);
    if (isSession || actingAsAssistant()) return;
    return reply.code(403).send({
      error:
        "Acting on the public graph in the organization's name takes a person: do it from a signed-in session, or ask the Assistant, which shows you a card to approve. A key or a token alone does not act.",
      code: "PERSON_REQUIRED",
    });
  };
  const byPerson = [app.authenticate, app.requireUser, requirePermission(acts), personPresent];
  const inSession = (permission: Parameters<typeof requirePermission>[0]) => [app.authenticate, app.requireSession, app.requireUser, requirePermission(permission)];
  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof OutwardError || err instanceof ReportSendingError) return reply.code(err.status).send({ error: err.message, code: err.code });
    throw err;
  };
  const tried = async (reply: FastifyReply, fn: () => Promise<unknown>, created = false) => {
    try {
      return reply.code(created ? 201 : 200).send(await fn());
    } catch (err) {
      return refuse(reply, err);
    }
  };

  // ---- reads ----

  app.get("/outside/account", {
    schema: {
      tags: TAG,
      summary: "The organization's account on the public graph: its balance of public owls and its public mandates",
      description:
        "Public owls are bought on the public graph and pay for public work only; owls created in this deployment never convert to them. The " +
        "mandates listed are public ones the organization funds there, each public on the public graph. Reads the organization's own account and " +
        "nothing about any node.",
    },
    preHandler: signedIn,
    handler: async (_request, reply) => reply.send(await publicAccount()),
  });

  app.get<{ Querystring: { limit?: number } }>("/outside/log", {
    schema: {
      tags: TAG,
      summary: "Every act this deployment made on the public graph besides sending pages: who did it, what was sent, and what the public graph answered",
      description:
        "Each act is a call to a route any account on the public graph could call, made under the organization's account. The entry holds exactly " +
        "what was sent. An act that nobody made in person names the standing choice it went under.",
      querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send({ acts: await outwardLog({ limit: request.query.limit }) }),
  });

  app.get("/outside/choices", {
    schema: {
      tags: TAG,
      summary: "The deployment's standing choices about what goes to the public graph with nobody acting, each with what it shows outside",
      description: "Each choice is on or off, says in full what it shows outside, and names who set it and when.",
    },
    preHandler: signedIn,
    handler: async (_request, reply) => reply.send({ choices: await standingChoices() }),
  });

  app.get<{ Querystring: { node_id?: string; limit?: number } }>("/outside/requests", {
    schema: {
      tags: TAG,
      summary: "The public graph's requests, as the mirror last brought them, with what this deployment has done about each",
      description:
        "A request records something someone could do that would improve what the graph knows, and may be addressed to whoever holds the evidence. " +
        "Reading these tells the public graph nothing. With node_id, the requests that bear on that node. Each lists the requests adopted from it " +
        "here that you read, and whether this graph has said in public that it is taking it up.",
      querystring: { type: "object", properties: { node_id: UUID, limit: { type: "integer", minimum: 1, maximum: 200 } } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send(await publicRequests({ nodeId: request.query.node_id, limit: request.query.limit })),
  });

  app.get<{ Querystring: { node_id?: string } }>("/outside/said-back", {
    schema: {
      tags: TAG,
      summary: "What readers on the public graph said about the pages this deployment published: each contribution received, as it was written, and where the reassessment it opened stands",
      description:
        "A contribution made on the public graph through a published page comes in with the mirror, once the public graph's own review has " +
        "admitted it. This gives each one as it was made: its text, which was written outside this deployment, its type and date, the addresses " +
        "it cites and its id on the public graph. The node's Steward at the label the page came from is given the same, and a reassessment is " +
        "opened there that runs when it is paid for.",
      querystring: { type: "object", properties: { node_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send(await inboundOverview({ nodeId: request.query.node_id })),
  });

  app.get("/outside/keep-current", {
    schema: {
      tags: TAG,
      summary: "Keeping the public versions of nodes current: the setting as it stands, what has been asked of the public graph, and what was not, with why",
      description:
        "When a version of a public node changes here, the deployment can ask a public mandate the organization funds for a fresh public assessment " +
        "of the node. This says whether that is on, whether anything pays for it, the changed versions at labels you read with what became of " +
        "each, and the mandates and nodes left out.",
    },
    preHandler: signedIn,
    handler: async (_request, reply) => reply.send(await keepCurrentOverview()),
  });

  app.get<{ Querystring: { limit?: number } }>("/outside/reports", {
    schema: {
      tags: TAG,
      summary: "The agents' reports of problems written at labels you read: what each is about, its facts, its words as written and as they would go to Minerval's maintainers, and what came back",
      description:
        "A report stays in this deployment unless a person sends it on. Audit's triage says whether it is about Minerval's machinery or about this " +
        "deployment, and only the first kind is offered for sending, after a Redactor's pass over the agent's words.",
      querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send(await reportsOverview({ limit: request.query.limit })),
  });

  app.get<{ Params: { conversation_id: string } }>("/outside/mandates/conversations/:conversation_id", {
    schema: {
      tags: TAG,
      summary: "The organization's conversation with the public Grantmaker about a public mandate, as the public graph serves it to the organization's account",
      description: "Waits up to 20 seconds for the Grantmaker's turn to end. What it returns was written on the public graph.",
      params: { type: "object", required: ["conversation_id"], properties: { conversation_id: UUID } },
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission(acts)],
    handler: async (request, reply) => tried(reply, () => readPublicConversation(request.params.conversation_id)),
  });

  // ---- standing choices ----

  app.put<{ Params: { key: string }; Body: { on: boolean; public_mandate_id?: string | null; delay_hours?: number; batch_hours?: number } }>("/outside/choices/:key", {
    schema: {
      tags: TAG,
      summary: "Turn a standing choice on or off (from a signed-in session, by a person who could do each act it covers)",
      description:
        "What the choice shows outside is returned by GET /outside/choices and stored with the choice as it read when you made it. For " +
        "keep_public_current, public_mandate_id names the public mandate that is asked, delay_hours waits that long after a version changes, and " +
        "batch_hours sends what is due together at that interval.",
      params: { type: "object", required: ["key"], properties: { key: { type: "string", enum: Object.keys(STANDING_CHOICES) } } },
      body: {
        type: "object",
        required: ["on"],
        properties: {
          on: { type: "boolean" },
          public_mandate_id: { type: "string", format: "uuid", nullable: true },
          delay_hours: { type: "number", minimum: 0, maximum: 2160 },
          batch_hours: { type: "number", minimum: 0, maximum: 2160 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireSession, app.requireUser],
    handler: async (request, reply) => {
      const key = request.params.key as StandingChoiceKey;
      const actor = await actorOf(request);
      // Whoever sets a choice must be able to do each act it covers.
      const own = key === "send_redacted_reports" ? await ownOrganizationParty() : null;
      const may =
        key === "send_redacted_reports"
          ? own !== null && actor.releaseParties.includes(own.id)
          : key === "send_failure_facts"
            ? actor.direct
            : actor.holding.includes(acts);
      if (!may) {
        return reply.code(403).send({
          error:
            key === "send_redacted_reports"
              ? "This choice sends words written at a label without anyone reading them first, so it takes release for the organization's own material."
              : key === "send_failure_facts"
                ? "This choice takes the permission to direct the graph."
                : `This choice takes the ${acts} permission, which is what acting on the public graph in the organization's name takes here.`,
          code: "PERMISSION_REQUIRED",
        });
      }
      return tried(reply, () =>
        setStandingChoice({ key, on: request.body.on, publicMandateId: request.body.public_mandate_id, delayHours: request.body.delay_hours, batchHours: request.body.batch_hours, actor })
      );
    },
  });

  // ---- public requests ----

  app.post<{ Params: { public_request_id: string }; Body: { label?: string } }>("/outside/requests/:public_request_id/adopt", {
    schema: {
      tags: TAG,
      summary: "Adopt a public request: make it an ordinary request in this deployment, at a label you read (people who direct the graph, from a signed-in session)",
      description:
        "The request here carries the public request's own words and the nodes it bears on, and is linked to the public one. Nothing is said " +
        "outside. The work runs when a mandate or a person pays for it, like any request's.",
      params: { type: "object", required: ["public_request_id"], properties: { public_request_id: UUID } },
      body: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 100 } } },
    },
    preHandler: inSession("direct"),
    handler: async (request, reply) =>
      tried(reply, async () => adoptRequest({ publicRequestId: request.params.public_request_id, label: request.body?.label ?? null, actor: await actorOf(request) }), true),
  });

  app.post<{ Params: { adoption_id: string } }>("/outside/requests/adopted/:adoption_id/take-up", {
    schema: {
      tags: TAG,
      summary: "Say on the public graph, in the organization's name, that this graph is taking a request up",
      description: TAKE_UP_TOLD,
      params: { type: "object", required: ["adoption_id"], properties: { adoption_id: UUID } },
    },
    preHandler: byPerson,
    handler: async (request, reply) => tried(reply, async () => takeUpInPublic({ adoptionId: request.params.adoption_id, actor: await actorOf(request) })),
  });

  app.post<{ Params: { adoption_id: string }; Body: { reason: string } }>("/outside/requests/adopted/:adoption_id/decline", {
    schema: {
      tags: TAG,
      summary: "Say on the public graph that this graph will not do work it said it was taking up, with a reason from a fixed list",
      description:
        "A refusal is a complete answer to a request and stays on its public record beside the statement that it was taken up. The reason is one of: " +
        Object.entries(DECLINE_REASONS).map(([k, v]) => `${k} (${v})`).join("; ") +
        ". It shows outside that the organization decided not to do this work, and the reason chosen.",
      params: { type: "object", required: ["adoption_id"], properties: { adoption_id: UUID } },
      body: { type: "object", required: ["reason"], properties: { reason: { type: "string", enum: Object.keys(DECLINE_REASONS) } } },
    },
    preHandler: byPerson,
    handler: async (request, reply) => tried(reply, async () => declineInPublic({ adoptionId: request.params.adoption_id, reason: request.body.reason, actor: await actorOf(request) })),
  });

  // ---- public mandates and public owls ----

  app.post<{ Body: { message: string } }>("/outside/mandates", {
    schema: {
      tags: TAG,
      summary: "Open a conversation with the public Grantmaker about a new public mandate, in your own words (from a signed-in session)",
      description: PUBLIC_MANDATE_TOLD,
      body: { type: "object", required: ["message"], properties: { message: { type: "string", minLength: 1, maxLength: 10000 } } },
    },
    preHandler: inSession(acts),
    handler: async (request, reply) => tried(reply, async () => openPublicMandate({ message: request.body.message, actor: await actorOf(request) }), true),
  });

  app.post<{ Params: { conversation_id: string }; Body: { message: string } }>("/outside/mandates/conversations/:conversation_id/messages", {
    schema: {
      tags: TAG,
      summary: "Write to the public Grantmaker in a conversation about a public mandate, in your own words (from a signed-in session)",
      description: "What you write is sent as you wrote it, under the organization's account. Nothing from this deployment is added.",
      params: { type: "object", required: ["conversation_id"], properties: { conversation_id: UUID } },
      body: { type: "object", required: ["message"], properties: { message: { type: "string", minLength: 1, maxLength: 10000 } } },
    },
    preHandler: inSession(acts),
    handler: async (request, reply) =>
      tried(reply, async () => sayToPublicGrantmaker({ conversationId: request.params.conversation_id, message: request.body.message, actor: await actorOf(request) })),
  });

  app.post<{ Params: { conversation_id: string }; Body: { budget_owls: number } }>("/outside/mandates/conversations/:conversation_id/fund", {
    schema: {
      tags: TAG,
      summary: "Fund the public mandate the public Grantmaker drafted, from the organization's public owls",
      description:
        "Escrows the budget from the organization's balance on the public graph and starts the mandate there. The mandate is public at once: its " +
        "scope, its funder and its budget. What it does not spend comes back to the organization's public balance.",
      params: { type: "object", required: ["conversation_id"], properties: { conversation_id: UUID } },
      body: { type: "object", required: ["budget_owls"], properties: { budget_owls: { type: "number", exclusiveMinimum: 0 } } },
    },
    preHandler: byPerson,
    handler: async (request, reply) =>
      tried(reply, async () => fundPublicMandate({ conversationId: request.params.conversation_id, budgetOwls: request.body.budget_owls, actor: await actorOf(request) })),
  });

  app.post<{ Params: { mandate_id: string }; Body: { owls: number } }>("/outside/mandates/:mandate_id/back", {
    schema: {
      tags: TAG,
      summary: "Add public owls to a public mandate, from the organization's balance on the public graph",
      description: "The contribution is public on the mandate's page under the organization's account. Unspent budget refunds to its funders pro rata.",
      params: { type: "object", required: ["mandate_id"], properties: { mandate_id: UUID } },
      body: { type: "object", required: ["owls"], properties: { owls: { type: "number", exclusiveMinimum: 0 } } },
    },
    preHandler: byPerson,
    handler: async (request, reply) => tried(reply, async () => backPublicMandate({ mandateId: request.params.mandate_id, owls: request.body.owls, actor: await actorOf(request) })),
  });

  app.post<{ Params: { node_id: string }; Body: { owls: number } }>("/outside/nodes/:node_id/fund", {
    schema: {
      tags: TAG,
      summary: "Fund this on the public graph: pay, from the organization's public owls, for the public graph's assessment of a node the mirror holds",
      description: FUND_NODE_TOLD,
      params: { type: "object", required: ["node_id"], properties: { node_id: UUID } },
      body: { type: "object", required: ["owls"], properties: { owls: { type: "number", exclusiveMinimum: 0, maximum: 100 } } },
    },
    preHandler: byPerson,
    handler: async (request, reply) => tried(reply, async () => fundPublicNode({ nodeId: request.params.node_id, owls: request.body.owls, actor: await actorOf(request) })),
  });

  app.post<{ Params: { node_id: string }; Body: { mandate_id: string } }>("/outside/nodes/:node_id/raise", {
    schema: {
      tags: TAG,
      summary: "Ask one of the organization's public mandates for a fresh public assessment of a node the mirror holds",
      description:
        "Puts the node in front of that mandate's officers on the public graph, who decide under its operating policy whether its money pays. It " +
        "carries the node and no words. It shows on the mandate's public page that the organization asked about this node, and when.",
      params: { type: "object", required: ["node_id"], properties: { node_id: UUID } },
      body: { type: "object", required: ["mandate_id"], properties: { mandate_id: UUID } },
    },
    preHandler: byPerson,
    handler: async (request, reply) =>
      tried(reply, async () => raisePublicNode({ nodeId: request.params.node_id, mandateId: request.body.mandate_id, by: { actor: await actorOf(request) } })),
  });

  // ---- keeping the public version current: what is left out ----

  app.post<{ Body: { mandate_id?: string; node_id?: string; label?: string } }>("/outside/keep-current/leave-out", {
    schema: {
      tags: TAG,
      summary: "Leave a mandate's work, or one node, out of keeping public versions current (people who direct the graph, from a signed-in session)",
      description:
        "With mandate_id, nothing that mandate pays for is passed on to the public graph; with node_id as well, that node alone. With node_id " +
        "alone, the node is left out whoever pays, and label says which label the record is kept at. Which nodes are left out says which are " +
        "worked on, so the record is kept at the mandate's label or the one you name.",
      body: { type: "object", properties: { mandate_id: UUID, node_id: UUID, label: { type: "string", minLength: 1, maxLength: 100 } } },
    },
    preHandler: inSession("direct"),
    handler: async (request, reply) =>
      tried(reply, async () => leaveOut({ grantId: request.body.mandate_id, nodeId: request.body.node_id, label: request.body.label, actor: await actorOf(request) }), true),
  });

  app.delete<{ Params: { id: string } }>("/outside/keep-current/leave-out/:id", {
    schema: {
      tags: TAG,
      summary: "Take back a leaving-out (people who direct the graph, from a signed-in session)",
      params: { type: "object", required: ["id"], properties: { id: UUID } },
    },
    preHandler: inSession("direct"),
    handler: async (request, reply) => tried(reply, () => takeBackLeaveOut({ id: request.params.id })),
  });

  // ---- agents' reports ----

  app.post<{ Params: { sending_id: string } }>("/outside/reports/:sending_id/send", {
    schema: {
      tags: TAG,
      summary: "Send an agent's report, as redacted, to Minerval's maintainers",
      description: SEND_REPORT_TOLD,
      params: { type: "object", required: ["sending_id"], properties: { sending_id: UUID } },
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission("release"), personPresent],
    handler: async (request, reply) => tried(reply, async () => sendReport({ sendingId: request.params.sending_id, by: { actor: await actorOf(request) } })),
  });

  app.post<{ Params: { sending_id: string } }>("/outside/reports/:sending_id/send-facts", {
    schema: {
      tags: TAG,
      summary: "Send the facts of a tool failure to Minerval's maintainers, without any of the agent's words",
      description: STANDING_CHOICES.send_failure_facts.told.replace(/^When one of your graph's agents reports that a tool failed and Audit finds the report to be about Minerval's machinery, your graph sends/, "This sends"),
      params: { type: "object", required: ["sending_id"], properties: { sending_id: UUID } },
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission("direct"), personPresent],
    handler: async (request, reply) => tried(reply, async () => sendFacts({ sendingId: request.params.sending_id, by: { actor: await actorOf(request) } })),
  });

  // ---- paying ----

  app.post<{ Params: { action_id: string }; Body: { owls: number } }>("/outside/work/:action_id/commission", {
    schema: {
      tags: TAG,
      summary: "Pay for the redaction of a report offered for sending",
      description:
        "It is a run on the ledger that happens when it is paid for. You set its budget in owls and pay it whole; what the run does not spend " +
        "comes back. Paying buys the work, not what it finds or removes.",
      params: { type: "object", required: ["action_id"], properties: { action_id: UUID } },
      body: { type: "object", required: ["owls"], properties: { owls: { type: "number", exclusiveMinimum: 0 } } },
    },
    preHandler: [...signedIn, requirePermission("fund")],
    handler: async (request, reply) => {
      const [action] = await rawQuery<{ id: string; kind: string; status: string }>(`SELECT id, kind, status FROM actions WHERE id = $1 AND kind = 'redact_report'`, [
        request.params.action_id,
      ]);
      if (!action) return reply.code(404).send({ error: "No such work is open at a label you read.", code: "NOT_FOUND" });
      if (action.status !== "open") return reply.code(409).send({ error: "This work is not waiting to be paid for.", code: "NOTHING_OPEN" });
      const result = await commissionAction({
        payer: { kind: "user", userId: request.auth!.userId! },
        actionId: action.id,
        budgetMicroUsd: owlsToMicroUsd(request.body.owls),
        reason: "A member commissioned it.",
        commissionedBy: "person",
      });
      if (!result.ok) return reply.code(result.code === "INSUFFICIENT_OWLS" ? 402 : 400).send({ error: result.message, code: result.code });
      return reply.send({
        status: result.status,
        work: "the redaction of the report",
        ...(result.status === "already_commissioned" ? { note: "This work is already paid for; nothing was charged." } : {}),
      });
    },
  });
}
