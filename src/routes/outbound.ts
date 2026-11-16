/**
 * A shown page leaves the deployment: the routes
 * (docs/published-pages.md, "Inside the deployment";
 * services/outbound-service.ts). Mounted only where READS=members, beside
 * the showing routes.
 *
 *   GET  /outbound: where each node under a showing outside stands on
 *     its way out: the node on the public graph or the proposal of it, each
 *     package built, and each time one was sent, with who sent it.
 *   POST /outbound/send: send what waits under one showing (direct, and a
 *     person present).
 *   POST /outbound/packages/:package_id/file: take one package as a file,
 *     to carry where the network does not reach (direct, session).
 *   POST /outbound/proposals: write or approve the words a node that
 *     exists only here is proposed to the public graph in (direct, session).
 *   POST /outbound/proposals/:proposal_id/release: a party's holder of
 *     `release` releases those words (release, session).
 *   POST /outbound/registration: the signed statement the organization's
 *     account presents on the public graph to register this deployment's
 *     key (administer, session).
 *
 * Where the line is. Everything a package carries has already passed the
 * release gate for outside. Sending it is still an outward act: it tells
 * the outside when this graph assessed a node and what it released. So a
 * send takes a person: a signed-in session, or the card the Assistant
 * shows its user for an outward act, which is the one mechanism for a
 * person approving what an agent proposes (llm/tools/assistant-tools.ts).
 * A key or a token alone does not send. The other way a package goes is the
 * choice a person made when they asked for a standing showing, which the
 * scheduler follows. Writing the words of a proposal, releasing them,
 * taking a file and signing a registration decide what leaves or who
 * speaks for the deployment, and take a signed-in session as the showing
 * routes do.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actingAsAssistant } from "../llm/assistant-acting.js";
import { holdsPermission, standingOf } from "../permissions.js";
import { requirePermission } from "../server/require-permission.js";
import { listParties } from "../services/party-service.js";
import type { GateActor } from "../services/release-gate-service.js";
import {
  OutboundError,
  SEND_CHOICES,
  outboundOverview,
  packageFile,
  publisherIdentity,
  sendOutbound,
  signedRegistration,
  writeProposal,
} from "../services/outbound-service.js";

const UUID = { type: "string", format: "uuid" } as const;

const STATUS: Record<string, number> = {
  NODE_NOT_FOUND: 404,
  SHOWING_NOT_FOUND: 404,
  PACKAGE_NOT_FOUND: 404,
  PROPOSAL_NOT_FOUND: 404,
  NOT_SHOWN_OUTSIDE: 404,
  NOT_YOUR_PARTY: 403,
  ALREADY_PROPOSED: 409,
  ALREADY_PUBLIC: 409,
  ALREADY_RELEASED: 409,
  NOT_WAITING: 409,
  NO_SIGNING_KEY: 409,
  HOSTING_NOT_STATED: 409,
  NO_ROUTE_OUT: 409,
  NO_STANDING_CHOICE: 409,
};

/** The person acting, with the permissions they hold as the record will show them (routes/showings.ts has the same). */
export async function actorOf(request: FastifyRequest): Promise<GateActor> {
  const standing = standingOf(request.auth);
  const names = new Map((await listParties()).map((p) => [p.id, p.name]));
  const holding: string[] = [];
  for (const g of standing.grants) {
    if (g.permission === "read" || g.permission === "read_sources") continue;
    const words = g.permission === "release" ? `release for ${names.get(g.partyId ?? "") ?? "a party"}` : g.permission;
    if (!holding.includes(words)) holding.push(words);
  }
  return {
    id: request.auth!.userId!,
    holding,
    clearance: standing.clearance,
    releaseParties: standing.grants.filter((g) => g.permission === "release" && g.partyId).map((g) => g.partyId!),
    direct: holdsPermission(standing, "direct"),
  };
}

export async function outboundRoutes(app: FastifyInstance): Promise<void> {
  const signedIn = [app.authenticate, app.requireUser];
  const session = (permission: "direct" | "release" | "administer") => [
    app.authenticate,
    app.requireSession,
    app.requireUser,
    requirePermission(permission),
  ];
  /** A person is present: a signed-in session, or the Assistant acting on a card its user pressed or a kind of act they allowed. */
  const personPresent = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    const isSession = auth?.isSession === true || (auth?.method === "dev_bypass" && auth.userId !== null);
    if (isSession || actingAsAssistant()) return;
    return reply.code(403).send({
      error:
        "Sending outside this deployment takes a person: do it from a signed-in session, or ask the Assistant, which shows you a card to approve. A key or a token alone does not send.",
      code: "PERSON_REQUIRED",
    });
  };
  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof OutboundError) return reply.code(STATUS[err.code] ?? 400).send({ error: err.message, code: err.code });
    throw err;
  };

  app.get<{ Querystring: { showing_id?: string } }>("/outbound", {
    schema: {
      tags: ["showings"],
      summary: "Where each node shown outside this deployment stands on its way out: the node on the public graph, each package built, and each time one was sent",
      description:
        "A page shown outside leaves as signed packages, sent to the public graph under the organization's own account there. For each node under a " +
        "showing outside this gives its node on the public graph, or, for a node that exists only here, where its proposal to the public graph stands; " +
        "each package built with the state it carries; and each send or handing over, with who did it and what the public graph answered.",
      querystring: { type: "object", properties: { showing_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send(await outboundOverview({ showingId: request.query.showing_id })),
  });

  app.post<{ Body: { showing_id: string } }>("/outbound/send", {
    schema: {
      tags: ["showings"],
      summary: "Send what waits under one showing outside to the public graph: proposals of nodes that exist only here, then each node's packages in order",
      description:
        "What is sent has passed the release gate: released parts as written, held parts by kind and hash, and the record of how the page was made. " +
        "It is submitted under the organization's account on the public graph, where it is reviewed and weighed as any contribution is. Sending shows " +
        "outside that this graph assessed the node and when. It is recorded here with who sent it.",
      body: { type: "object", required: ["showing_id"], properties: { showing_id: UUID } },
    },
    preHandler: [app.authenticate, app.requireUser, requirePermission("direct"), personPresent],
    handler: async (request, reply) => {
      try {
        return reply.send(await sendOutbound({ showingId: request.body.showing_id, sender: { actor: await actorOf(request) } }));
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.post<{ Params: { package_id: string } }>("/outbound/packages/:package_id/file", {
    schema: {
      tags: ["showings"],
      summary: "Take one package as a file, to submit on the public graph by hand (people who direct the graph, from a signed-in session)",
      description:
        "For a deployment the network does not join to the public graph. The file is the package exactly as signed; the public graph checks it the same " +
        "way however it arrives. Taking it is recorded with who took it.",
      params: { type: "object", required: ["package_id"], properties: { package_id: UUID } },
    },
    preHandler: session("direct"),
    handler: async (request, reply) => {
      try {
        return reply.send(await packageFile({ packageId: request.params.package_id, actor: await actorOf(request) }));
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.post<{ Body: { showing_id: string; node_id: string; text?: string } }>("/outbound/proposals", {
    schema: {
      tags: ["showings"],
      summary: "Write or approve the words a node that exists only here is proposed to the public graph in (people who direct the graph, from a signed-in session)",
      description:
        "The public graph has no page for such a node's page to appear on until it holds the node, so the node is proposed there first, as anyone may " +
        "propose one. Leave `text` out to propose the node's own wording. The words then go to the gate to outside as an item of the kind proposal, " +
        "resting on the parties the node's wording rests on, unless they are word for word a wording that already went through it with the node's " +
        "page. Nothing is sent by this.",
      body: {
        type: "object",
        required: ["showing_id", "node_id"],
        properties: { showing_id: UUID, node_id: UUID, text: { type: "string", minLength: 1, maxLength: 2000 } },
      },
    },
    preHandler: session("direct"),
    handler: async (request, reply) => {
      try {
        return reply.code(201).send(await writeProposal({ showingId: request.body.showing_id, nodeId: request.body.node_id, text: request.body.text, actor: await actorOf(request) }));
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.post<{ Body: { account: string } }>("/outbound/registration", {
    schema: {
      tags: ["showings"],
      summary: "The signed statement that registers this deployment's key to the organization's account on the public graph (administrators, from a signed-in session)",
      description:
        "`account` is the sign-in identity of the organization's account on the public graph. The answer is what that account sends to the public " +
        "graph's POST /publishers: the key's public half, where this deployment runs in fixed words, and a signature that shows the key's holder " +
        "named that account. It decides who speaks for this deployment outside.",
      body: { type: "object", required: ["account"], properties: { account: { type: "string", minLength: 1, maxLength: 300 } } },
    },
    preHandler: session("administer"),
    handler: async (request, reply) => {
      try {
        return reply.send({ ...signedRegistration(request.body.account), key_id: publisherIdentity().key_id, how_packages_are_sent: SEND_CHOICES });
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });
}
