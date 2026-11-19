/**
 * A private graph acting on the public graph other than by releasing a page,
 * and what comes back (docs/outward-acts.md). Mounted only where
 * READS=members, beside the outbound routes.
 *
 *   GET  /outside/account: the organization's account on the public graph:
 *     its public owls, its public mandates, and whether and under what the
 *     deployment's signing key is registered there.
 *   GET  /outside/log: every act this deployment made on the public graph.
 *   GET  /outside/requests: the public graph's requests, from the mirror,
 *     with what this deployment has done about each.
 *   POST /outside/requests/:public_request_id/adopt: make one an ordinary
 *     request here. Says nothing outside.
 *   POST /outside/requests/adopted/:adoption_id/take-up, .../decline: offer
 *     to the gate to outside that the graph is taking it up, or decline it
 *     and offer that the work will not be done.
 *   POST /outside/mandates, POST /outside/mandates/conversations/:id/messages,
 *     GET /outside/mandates/conversations/:id: a new public mandate, in a
 *     person's own words to the public Grantmaker. GET
 *     /outside/mandates/conversations lists them.
 *   POST /outside/mandates/conversations/:id/fund, POST
 *     /outside/mandates/:mandate_id/back: pay for one with public owls.
 *   POST /outside/nodes/:node_id/fund, .../raise: pay for the public
 *     assessment of a mirrored node, or ask a public mandate to.
 *   GET  /outside/said-back: what the public said about published pages.
 *   GET  /outside/reports: agents' reports, and where each stands at the
 *     gate to outside.
 *
 * Where the line is. Every write here that reaches the public graph shows
 * something outside, so each takes a person who holds the permission for
 * it: in a signed-in session, or pressing the card the Assistant shows for
 * an outward act (llm/tools/assistant-tools.ts, kind send_outside). A key
 * or a token alone does not act. Words a person writes for the outside (a
 * mandate's scope, a message to the public Grantmaker) take the signed-in
 * session itself, so they are not tools, because a draft an agent wrote
 * would be an agent's words leaving without redaction. What leaves with
 * nobody acting is decided by the gate to outside's settings (Gates).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actingAsAssistant } from "../llm/assistant-acting.js";
import { requirePermission } from "../server/require-permission.js";
import { inboundOverview } from "../services/inbound-service.js";
import {
  FUND_NODE_TOLD,
  OutwardError,
  PUBLIC_MANDATE_TOLD,
  TAKE_UP_TOLD,
  adoptRequest,
  adoptRequestFromBelow,
  backPublicMandate,
  declineInPublic,
  fundPublicMandate,
  fundPublicNode,
  openPublicMandate,
  outwardLog,
  publicAccount,
  publicActsPermission,
  publicConversations,
  publicRequests,
  raisePublicNode,
  readPublicConversation,
  sayToPublicGrantmaker,
  takeUpInPublic,
} from "../services/outward-acts-service.js";
import { REPORT_AT_GATE_TOLD, ReportSendingError, reportsOverview } from "../services/report-sending-service.js";
import { DECLINE_REASONS } from "../services/request-take-up-service.js";
import { actorOf } from "./outbound.js";
import { DEPLOYMENT_GRANTS, type DeploymentGrant } from "../db/schema.js";
import {
  ConnectionError,
  checkConnect,
  connectWith,
  connectionStatus,
  disconnect,
  refreshConnection,
  replaceConnectionKey,
  startConnect,
  startConnectByHand,
} from "../services/public-graph-connection.js";

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

  // ---- the connection to minerval.ai (docs/organizations.md, "Connecting") ----

  const connectionRefused = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ConnectionError) return reply.code(err.status).send({ error: err.message, code: err.code });
    throw err;
  };

  app.get("/outside/connection", {
    schema: {
      tags: TAG,
      summary:
        "This deployment's connection to minerval.ai: none; waiting, with the code and the link for an admin of the organization; denied or " +
        "expired; or connected, with the organization, the deployment's name there and the grants it holds (read_feed, report_usage, publish, spend, speak, propose, take_up)",
      description:
        "A waiting connection is checked with minerval.ai when this is read, and a connected one read again now and then, so a withdrawn grant " +
        "is seen here. The connection key's private half is never returned. `connect_with` is what connecting would send: the name, " +
        "where it runs (fixed where the operator set DEPLOYMENT_HOSTING), the grants its settings need and why, and its own address.",
    },
    preHandler: signedIn,
    handler: async (_request, reply) => reply.send({ connection: await connectionStatus(), connect_with: await connectWith() }),
  });

  app.post<{ Body: { name: string; hosting?: string; api_url?: string; replace?: boolean; grants?: DeploymentGrant[] } }>("/outside/connection", {
    schema: {
      tags: TAG,
      summary:
        "Connect this deployment to minerval.ai (administrators, from a signed-in session): make a new connection key, say what to call it " +
        "and where it runs, and get a code and a link for an admin of the organization to approve",
      description:
        "The key is made here and kept in this deployment's database, the owner's alone; it never leaves the machine. It asks for no grants: " +
        "it sends which its settings need, and why, and the organization's admin chooses. `hosting` is own_machines, third_party or minerval; " +
        "where the operator set DEPLOYMENT_HOSTING, that is used. Connecting a deployment that is connected already needs `replace`, and a " +
        "new approval. Recorded on the log of acts on the public graph.",
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          hosting: { type: "string", enum: ["own_machines", "third_party", "minerval"] },
          api_url: { type: "string", maxLength: 500 },
          replace: { type: "boolean" },
          // Sent by a page built before the deployment stopped asking for grants; read as nothing.
          grants: { type: "array", items: { type: "string", enum: [...DEPLOYMENT_GRANTS] } },
        },
      },
    },
    preHandler: inSession("administer"),
    handler: async (request, reply) => {
      try {
        return reply.code(201).send({
          connection: await startConnect({
            name: request.body.name,
            hosting: request.body.hosting ?? null,
            apiUrl: request.body.api_url ?? null,
            replace: request.body.replace === true,
            actor: { actor: await actorOf(request) },
          }),
        });
      } catch (err) {
        return connectionRefused(reply, err);
      }
    },
  });

  app.post("/outside/connection/check", {
    schema: {
      tags: TAG,
      summary: "Ask minerval.ai now whether a waiting connection has been approved, or read a connected one's grants again",
    },
    preHandler: signedIn,
    handler: async (_request, reply) => {
      await checkConnect();
      await refreshConnection();
      return reply.send({ connection: await connectionStatus({ check: false }) });
    },
  });

  app.post<{ Body: { name: string; hosting?: string; replace?: boolean } }>("/outside/connection/by-hand", {
    schema: {
      tags: TAG,
      summary:
        "Connect this deployment to minerval.ai by hand (administrators, from a signed-in session), where the network does not join them: " +
        "make a key and a signed connection request for an admin of the organization to paste on its Deployments tab there. Nothing is sent " +
        "over the network; what the deployment sends leaves as files",
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          hosting: { type: "string", enum: ["own_machines", "third_party", "minerval"] },
          replace: { type: "boolean" },
        },
      },
    },
    preHandler: inSession("administer"),
    handler: async (request, reply) => {
      try {
        return reply.code(201).send({
          connection: await startConnectByHand({
            name: request.body.name,
            hosting: request.body.hosting ?? null,
            replace: request.body.replace === true,
            actor: { actor: await actorOf(request) },
          }),
        });
      } catch (err) {
        return connectionRefused(reply, err);
      }
    },
  });

  app.post("/outside/connection/key", {
    schema: {
      tags: TAG,
      summary:
        "Replace this deployment's connection key (administrators, from a signed-in session): a new key is made here, and minerval.ai " +
        "puts it in place of the old one, which stops at once. Grants, the organization and the record stay; no new approval is needed",
    },
    preHandler: inSession("administer"),
    handler: async (request, reply) => {
      try {
        return reply.send({ connection: await replaceConnectionKey({ actor: { actor: await actorOf(request) } }) });
      } catch (err) {
        return connectionRefused(reply, err);
      }
    },
  });

  app.delete("/outside/connection", {
    schema: {
      tags: TAG,
      summary:
        "Disconnect this deployment from minerval.ai (administrators, from a signed-in session): retire it there with one last signed request, " +
        "and forget the key. Connecting again makes a new key and needs a new approval",
    },
    preHandler: inSession("administer"),
    handler: async (request, reply) => {
      try {
        return reply.send(await disconnect({ actor: { actor: await actorOf(request) } }));
      } catch (err) {
        return connectionRefused(reply, err);
      }
    },
  });

  // ---- reads ----

  app.get("/outside/account", {
    schema: {
      tags: TAG,
      summary:
        "The organization's account on the public graph: its balance of public owls, its public mandates, and whether and under what the deployment's signing key is registered there",
      description:
        "Public owls are bought on the public graph and pay for public work only; owls created in this deployment never convert to them. The " +
        "mandates listed are public ones the organization funds there, each public on the public graph, with the conversation with the public " +
        "Grantmaker it was funded from where known. `registration` is the deployment's registration as a publisher: when, which key (by its " +
        "fingerprint), to which account, with what declared interest, whether that key is the one the deployment signs with now, and who " +
        "registered it from here; null where no key is registered. It is read from the public graph's record of the account, or, where that " +
        "cannot be read, from this deployment's log of acts. Reads the organization's own account and nothing about any node.",
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
        "what was sent. An act that nobody made in person says it was the gate to outside, under its setting; older ones name the standing choice they went under.",
      querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send({ acts: await outwardLog({ limit: request.query.limit }) }),
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
        "opened there that runs when it is paid for. Each carries `page_label`, the label the page it was made through was written at, which " +
        "is where its reassessment is paid for; where you do not read that label it is {withheld: true}.",
      querystring: { type: "object", properties: { node_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send(await inboundOverview({ nodeId: request.query.node_id })),
  });

  app.get<{ Querystring: { limit?: number } }>("/outside/reports", {
    schema: {
      tags: TAG,
      summary: "The agents' reports of problems written at labels you read: what each is about, its facts, its words as written, where it stands at the gate to outside, and what came back",
      description: REPORT_AT_GATE_TOLD,
      querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send(await reportsOverview({ limit: request.query.limit })),
  });

  app.get("/outside/mandates/conversations", {
    schema: {
      tags: TAG,
      summary:
        "The organization's conversations with the public Grantmaker, newest first: who opened each and when, its draft's title, and whether it was funded, and as which public mandate",
      description:
        "Who opened each conversation, and what was written and funded from here, is this deployment's own log of acts on the public graph. Each " +
        "one's draft title, its state there and the public mandate it was funded as are read from the organization's own list on the public graph; " +
        "a conversation the account holds there that was not opened from here is listed too, with opened_from_here false. Where the public graph " +
        "cannot be read, the log alone answers and read_from_the_public_graph is false. Read one with GET /outside/mandates/conversations/:conversation_id.",
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission(acts)],
    handler: async (_request, reply) => reply.send(await publicConversations()),
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

  // The same act one layer up: a request filed at a label below one the
  // person reads, taken up at that label (services/request-adoption-service.ts).
  app.post<{ Params: { request_id: string }; Body: { label: string } }>("/requests/:request_id/adopt", {
    schema: {
      tags: ["requests"],
      summary: "Take up, at a label you read, a request filed at a label it reads (people who direct the graph, from a signed-in session)",
      description:
        "The request at your label carries the words of the one below and what it bears on, and is linked to it. The work is funded, done and " +
        "judged at your label, by agents that read what your label reads. That it was taken up, and what the work finds, go to the readers of " +
        "the request below through the gate between the two labels, which may remove from an answer or hold it. A label takes a request up once.",
      params: { type: "object", required: ["request_id"], properties: { request_id: UUID } },
      body: { type: "object", required: ["label"], properties: { label: { type: "string", minLength: 1, maxLength: 100 } } },
    },
    preHandler: inSession("direct"),
    handler: async (request, reply) =>
      tried(reply, async () => adoptRequestFromBelow({ requestId: request.params.request_id, label: request.body?.label ?? null, actor: await actorOf(request) }), true),
  });

  app.post<{ Params: { adoption_id: string } }>("/outside/requests/adopted/:adoption_id/take-up", {
    schema: {
      tags: TAG,
      summary: "Have it said on the public graph, in the organization's name, that this graph is taking a request up: offered to the gate to outside",
      description: TAKE_UP_TOLD,
      params: { type: "object", required: ["adoption_id"], properties: { adoption_id: UUID } },
    },
    preHandler: byPerson,
    handler: async (request, reply) => tried(reply, async () => takeUpInPublic({ adoptionId: request.params.adoption_id, actor: await actorOf(request) })),
  });

  app.post<{ Params: { adoption_id: string }; Body: { reason: string; note?: string } }>("/outside/requests/adopted/:adoption_id/decline", {
    schema: {
      tags: TAG,
      summary: "Decline a request taken up from the public graph, with a reason from a fixed list, and have that said on the public graph: offered to the gate to outside",
      description:
        "A refusal is a complete answer to a request and is part of its public record. The request here is closed as declined, and that the " +
        "work will not be done goes to the gate to outside with the reason, which is one of: " +
        Object.entries(DECLINE_REASONS).map(([k, v]) => `${k} (${v})`).join("; ") +
        ". It goes under that gate's setting, like anything else from a label. It shows outside that the organization decided not to do this " +
        "work, and the reason chosen. `note` is why, in your words, and stays in this deployment.",
      params: { type: "object", required: ["adoption_id"], properties: { adoption_id: UUID } },
      body: { type: "object", required: ["reason"], properties: { reason: { type: "string", enum: Object.keys(DECLINE_REASONS) }, note: { type: "string", maxLength: 2000 } } },
    },
    preHandler: byPerson,
    handler: async (request, reply) =>
      tried(reply, async () => declineInPublic({ adoptionId: request.params.adoption_id, reason: request.body.reason, note: request.body.note, actor: await actorOf(request) })),
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
      tried(reply, async () => raisePublicNode({ nodeId: request.params.node_id, mandateId: request.body.mandate_id, actor: await actorOf(request) })),
  });

}
