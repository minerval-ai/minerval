/**
 * Showing a node's page below its label: the routes
 * (docs/showing-a-page.md; services/showing-service.ts,
 * services/release-gate-service.ts). Mounted only where READS=members
 * (server/app.ts): the public graph has one label and nothing to show
 * below it.
 *
 *   GET    /showings: the showings the caller reads, from either side.
 *   GET    /showings/:showing_id: one showing as its destination side
 *     reads it: each node's state, every version, every act.
 *   GET    /showings/:showing_id/pages/:page_id: one shown page, with
 *     what is needed to check it against its fingerprint.
 *   POST   /showings: ask for a page to be shown (direct, session).
 *   POST   /showings/:showing_id/end: end a standing showing (direct, session).
 *   POST   /showings/:showing_id/pages/:page_id/hold: hold a page not yet
 *     shown, or lift that hold (direct, session).
 *   POST   /showings/:showing_id/pages/:page_id/commission: pay for the
 *     page's redaction or its check (fund).
 *   GET    /release/queue: what waits on the caller at the gate (release).
 *   POST   /release/decisions: release, hold or lift, item by item or in
 *     bulk (release, session).
 *   GET    /release/rules, POST /release/rules, DELETE /release/rules/:rule_id:
 *     a party's standing rules (release; the writes from a session).
 *   GET    /redaction-policies, GET /redaction-policies/:policy_id: the
 *     policies the caller reads.
 *   PUT    /redaction-policies: save a new version of a boundary's policy
 *     (administer, session).
 *
 * Where the line is. Asking for a page to be shown, ending a showing,
 * holding, releasing, setting a rule and saving a policy each decide what
 * leaves a label, and each is recorded with the person who did it and the
 * permissions they held. They are acts of a signed-in person, as changing
 * who may read is: a key or a token that leaked, or an agent following
 * text it read, cannot ask for a page to be shown or open the gate. So they
 * are not MCP tools (mcp/route-tools.ts). Reading a showing, reading the
 * queue and paying for the work are tools: the first two change nothing,
 * and money buys the redaction and its check, never what they conclude or
 * what is released.
 *
 * The acts write on both sides of a boundary, which may share no label, so
 * each route checks the person's permission and the service then writes as
 * the tables' owner. The reads run with the caller's own clearance.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { holdsPermission, standingOf } from "../permissions.js";
import { requirePermission } from "../server/require-permission.js";
import { rawQuery } from "../db/client.js";
import { commissionAction } from "../services/commission-service.js";
import { owlsToMicroUsd } from "../services/owl.js";
import { listParties } from "../services/party-service.js";
import { policyById, readablePolicies, savePolicyVersion } from "../services/redaction-policy.js";
import {
  HOLD_REASONS,
  RULE_CONDITIONS,
  askedShowings,
  decideAtGate,
  endReleaseRule,
  holdPage,
  releaseQueue,
  releaseRulesFor,
  setReleaseRule,
  shownPage,
  shownShowing,
  shownShowings,
  type GateActor,
} from "../services/release-gate-service.js";
import {
  END_REASONS,
  SHOWING_FORMS,
  SHOWING_SCOPES,
  ShowingError,
  askShowing,
  endShowing,
  showingPage,
} from "../services/showing-service.js";

const UUID = { type: "string", format: "uuid" } as const;

const STATUS: Record<string, number> = {
  NODE_NOT_FOUND: 404,
  SHOWING_NOT_FOUND: 404,
  PAGE_NOT_FOUND: 404,
  RULE_NOT_FOUND: 404,
  UNKNOWN_LABEL: 404,
  ALREADY_STANDING: 409,
  PASS_RUNNING: 409,
  ALREADY_ENDED: 409,
  ALREADY_SHOWN: 409,
  ALREADY_HELD: 409,
  NOT_HELD: 409,
  NOT_YOUR_PARTY: 403,
  NEEDS_DIRECT: 403,
};

/** The person acting, with the permissions they hold as the record will show them. */
async function actorOf(request: FastifyRequest): Promise<GateActor> {
  const standing = standingOf(request.auth);
  const names = new Map((await listParties()).map((p) => [p.id, p.name]));
  const holding: string[] = [];
  for (const g of standing.grants) {
    // A reading permission names a label, which is not shown to people who may not read it.
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

export async function showingRoutes(app: FastifyInstance): Promise<void> {
  const signedIn = [app.authenticate, app.requireUser];
  const session = (permission: "direct" | "release" | "administer") => [
    app.authenticate,
    app.requireSession,
    app.requireUser,
    requirePermission(permission),
  ];

  const refuse = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => {
    if (err instanceof ShowingError) {
      return reply.code(STATUS[err.code] ?? 400).send({ error: err.message, code: err.code });
    }
    throw err;
  };

  // ---- reading ----

  app.get<{ Querystring: { node_id?: string } }>("/showings", {
    schema: {
      tags: ["showings"],
      summary: "The pages shown to readers who do not read their label, as far as you can read them: those shown to a label you read, and those asked for at a label you read",
      description:
        "A node's page written at one label can be shown to readers who may not read that label, with what a policy " +
        "removed marked in its place and what is held named. `shown` lists showings from the side they are shown " +
        "to; `asked` lists them from the side they were asked for at, with where each page's redaction stands.",
      querystring: { type: "object", properties: { node_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) =>
      reply.send({ shown: await shownShowings({ nodeId: request.query.node_id }), asked: await askedShowings() }),
  });

  app.get<{ Params: { showing_id: string } }>("/showings/:showing_id", {
    schema: {
      tags: ["showings"],
      summary: "One showing as the readers it is shown to see it: each node's state, every version made while it stood, and every act on it",
      description:
        "Each node under the showing is in one of four states: not_yet_assessed, released_whole, " +
        "released_in_part (with how many parts are held and of which kinds), or held (with why, in fixed words, and " +
        "for how long). No state carries any of the page's text. Each act names who did it and the permissions they " +
        "held, so you can see when a person who directed the work also released it.",
      params: { type: "object", required: ["showing_id"], properties: { showing_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => {
      const showing = await shownShowing(request.params.showing_id);
      if (!showing) return reply.code(404).send({ error: "No showing with that id is shown to a label you read.", code: "SHOWING_NOT_FOUND" });
      return reply.send(showing);
    },
  });

  app.get<{ Params: { showing_id: string; page_id: string } }>("/showings/:showing_id/pages/:page_id", {
    schema: {
      tags: ["showings"],
      summary: "One shown page: what is always shown, each released part as written with its removals marked, each held part named, and the check against its fingerprint",
      description:
        "A released part is its author's text, with `[redacted: <category>]` where a policy removed a passage. A " +
        "held part shows its kind and who holds it. `verification` is the result of rebuilding the fingerprint from " +
        "what you are shown and comparing it with the one recorded before anyone decided what to release; the salts " +
        "and hashes are included so that you can redo it yourself.",
      params: { type: "object", required: ["showing_id", "page_id"], properties: { showing_id: UUID, page_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => {
      const page = await shownPage(request.params.page_id);
      if (!page) return reply.code(404).send({ error: "No page with that id is shown to a label you read.", code: "PAGE_NOT_FOUND" });
      return reply.send(page);
    },
  });

  app.get("/redaction-policies", {
    schema: {
      tags: ["showings"],
      summary: "The redaction policies you can read: the newest version for each boundary a page is shown across",
      description:
        "A policy says what is removed from a page when it is shown across one boundary. You read the policy of " +
        "every boundary whose pages are shown to a label you read, and of every boundary from a label you read.",
    },
    preHandler: signedIn,
    handler: async (_request, reply) =>
      reply.send({
        policies: (await readablePolicies()).map((p) => ({
          policy_id: p.id,
          boundary_id: p.boundary_id,
          version: p.version,
          hash: p.hash,
          saved_at: p.saved_at,
          starting_text: p.starting_text,
          ...(p.side === "page"
            ? { from_label: p.from, shown_to: p.to_outside ? "outside this deployment" : p.to }
            : { shown_to: p.to_outside ? "outside this deployment" : p.to }),
          categories: p.categories.map((c) => c.name),
        })),
      }),
  });

  app.get<{ Params: { policy_id: string } }>("/redaction-policies/:policy_id", {
    schema: {
      tags: ["showings"],
      summary: "One version of a redaction policy in full",
      params: { type: "object", required: ["policy_id"], properties: { policy_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => {
      const policy = await policyById(request.params.policy_id);
      if (!policy) return reply.code(404).send({ error: "No policy with that id is one you can read.", code: "POLICY_NOT_FOUND" });
      return reply.send({ policy_id: policy.id, boundary_id: policy.boundary_id, version: policy.version, hash: policy.hash, saved_at: policy.saved_at, categories: policy.categories, text: policy.body });
    },
  });

  // ---- asking ----

  app.post<{ Body: { node_id: string; page_label: string; to_label?: string | null; outside?: boolean; form: "once" | "standing"; scope: "node" | "under" } }>(
    "/showings",
    {
      schema: {
        tags: ["showings"],
        summary: "Ask for a node's page to be shown to readers who do not read its label (people who direct the graph, from a signed-in session)",
        description:
          "The page at `page_label` is shown to readers at `to_label`, or outside the deployment with `outside`. " +
          "`form` is `once` (the page as it stands, dated, with nothing undertaken about later versions) or " +
          "`standing` (each later version follows). `scope` is `node` or `under` (the node with what sits under it). " +
          "Nothing is shown by asking: the page is redacted under the boundary's policy when that work is paid for, " +
          "checked, and then released or held part by part by the people who hold the permission to release.",
        body: {
          type: "object",
          required: ["node_id", "page_label", "form", "scope"],
          properties: {
            node_id: UUID,
            page_label: { type: "string", minLength: 1 },
            to_label: { type: ["string", "null"] },
            outside: { type: "boolean" },
            form: { type: "string", enum: [...SHOWING_FORMS] },
            scope: { type: "string", enum: [...SHOWING_SCOPES] },
          },
        },
      },
      preHandler: session("direct"),
      handler: async (request, reply) => {
        const actor = await actorOf(request);
        const { node_id, page_label, form, scope } = request.body;
        const outside = request.body.outside === true;
        const toLabel = outside ? null : (request.body.to_label ?? null);
        if (!outside && !toLabel) {
          return reply.code(400).send({ error: "Say where the page is to be shown: to_label, or outside.", code: "NO_DESTINATION" });
        }
        // A person asks for the showing of a page they can read.
        if (!actor.clearance.includes(page_label)) {
          return reply.code(404).send({ error: `No active node with that id is read at "${page_label}".`, code: "NODE_NOT_FOUND" });
        }
        try {
          return reply.code(201).send(await askShowing({ nodeId: node_id, pageLabel: page_label, toLabel, form, scope, actor }));
        } catch (err) {
          return refuse(reply, err);
        }
      },
    }
  );

  app.post<{ Params: { showing_id: string }; Body: { reason: keyof typeof END_REASONS } }>("/showings/:showing_id/end", {
    schema: {
      tags: ["showings"],
      summary: "End a standing showing (people who direct the graph, from a signed-in session)",
      description: "Later versions no longer follow. What was shown stays shown, and the showing stays on the record with the date and the reason.",
      params: { type: "object", required: ["showing_id"], properties: { showing_id: UUID } },
      body: { type: "object", required: ["reason"], properties: { reason: { type: "string", enum: Object.keys(END_REASONS) } } },
    },
    preHandler: session("direct"),
    handler: async (request, reply) => {
      const actor = await actorOf(request);
      const [mine] = await rawQuery(`SELECT 1 FROM showings WHERE id = $1`, [request.params.showing_id]);
      if (!mine) return reply.code(404).send({ error: "No showing with that id was asked for at a label you read.", code: "SHOWING_NOT_FOUND" });
      try {
        await endShowing({ showingId: request.params.showing_id, reason: request.body.reason, actor });
        return reply.send(await shownShowing(request.params.showing_id).then((s) => s ?? { ended: true }));
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.post<{ Params: { showing_id: string; page_id: string }; Body: { lift?: boolean; reason?: keyof typeof HOLD_REASONS } }>(
    "/showings/:showing_id/pages/:page_id/hold",
    {
      schema: {
        tags: ["showings"],
        summary: "Hold a page that has not been shown, or lift that hold (people who direct the graph, from a signed-in session)",
        description:
          "The hold shows on the other side with its date and its reason, which is one of a fixed list. It can be lifted and is never deleted. A page already shown cannot be held.",
        params: { type: "object", required: ["showing_id", "page_id"], properties: { showing_id: UUID, page_id: UUID } },
        body: { type: "object", properties: { lift: { type: "boolean" }, reason: { type: "string", enum: Object.keys(HOLD_REASONS) } } },
      },
      preHandler: session("direct"),
      handler: async (request, reply) => {
        try {
          await holdPage({ actor: await actorOf(request), pageId: request.params.page_id, lift: request.body?.lift === true, reason: request.body?.reason });
          return reply.send({ ok: true });
        } catch (err) {
          return refuse(reply, err);
        }
      },
    }
  );

  // ---- paying ----

  app.post<{ Params: { showing_id: string; page_id: string }; Body: { owls: number } }>(
    "/showings/:showing_id/pages/:page_id/commission",
    {
      schema: {
        tags: ["showings"],
        summary: "Pay for the next piece of work on a page that is to be shown: its redaction, or the check of its redaction",
        description:
          "Each is a run on the ledger that happens when it is paid for. You set its budget in owls and pay it " +
          "whole; what the run does not spend comes back. Paying buys the work, not what it removes or concludes.",
        params: { type: "object", required: ["showing_id", "page_id"], properties: { showing_id: UUID, page_id: UUID } },
        body: { type: "object", required: ["owls"], properties: { owls: { type: "number", exclusiveMinimum: 0 } } },
      },
      preHandler: [...signedIn, requirePermission("fund")],
      handler: async (request, reply) => {
        const page = await showingPage(request.params.page_id);
        if (!page) return reply.code(404).send({ error: "No page under a showing has that id at a label you read.", code: "PAGE_NOT_FOUND" });
        let actionId: string | null = null;
        if (page.stage === "to_redact") actionId = page.redact_action_id;
        if (page.stage === "to_check") {
          const [audit] = await rawQuery<{ action_id: string | null }>(
            `SELECT a.action_id FROM showing_pages p JOIN audit_runs a ON a.id = p.audit_run_id WHERE p.id = $1`,
            [page.id]
          );
          actionId = audit?.action_id ?? null;
        }
        if (!actionId) {
          return reply.code(409).send({ error: "No work on this page is waiting to be paid for.", code: "NOTHING_OPEN" });
        }
        const result = await commissionAction({
          payer: { kind: "user", userId: request.auth!.userId! },
          actionId,
          budgetMicroUsd: owlsToMicroUsd(request.body.owls),
          reason: "A member commissioned it.",
          commissionedBy: "person",
        });
        if (!result.ok) {
          return reply.code(result.code === "INSUFFICIENT_OWLS" ? 402 : 400).send({ error: result.message, code: result.code });
        }
        return reply.send({
          status: result.status,
          work: page.stage === "to_redact" ? "the redaction" : "the check of the redaction",
          ...(result.status === "already_commissioned" ? { note: "This work is already paid for; nothing was charged." } : {}),
        });
      },
    }
  );

  // ---- the gate ----

  app.get<{ Querystring: { limit?: number } }>("/release/queue", {
    schema: {
      tags: ["showings"],
      summary: "What waits on you at the release gate: the parts of redacted pages that rest on a party whose material you release",
      description:
        "Each item is one part of a page, or the page itself with its verdict, with the Redactor's removals as " +
        "differences with their categories, the parts it was least sure of first, and Audit's answer. An item is " +
        "released or held whole. Nothing is released by time passing.",
      querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
    },
    preHandler: [...signedIn, requirePermission("release")],
    handler: async (request, reply) => reply.send(await releaseQueue(await actorOf(request), { limit: request.query.limit })),
  });

  app.post<{ Body: { party_id: string; decision: "release" | "hold" | "lift"; reason?: string; items: Array<{ page_id: string; part?: number | null }> } }>(
    "/release/decisions",
    {
      schema: {
        tags: ["showings"],
        summary: "Release, hold, or lift a hold on parts of pages for one party (holders of release for that party, from a signed-in session)",
        description:
          "Each item is a page and a part number, or a page alone for the page itself with its verdict. A decision " +
          "acts on the whole item: no route changes the text of a part. A hold gives a reason from a fixed list, " +
          "shows on the other side, can be lifted, and stays on the record. A release is not taken back.",
        body: {
          type: "object",
          required: ["party_id", "decision", "items"],
          properties: {
            party_id: UUID,
            decision: { type: "string", enum: ["release", "hold", "lift"] },
            reason: { type: "string", enum: Object.keys(HOLD_REASONS) },
            items: {
              type: "array",
              minItems: 1,
              items: { type: "object", required: ["page_id"], properties: { page_id: UUID, part: { type: ["integer", "null"] } } },
            },
          },
        },
      },
      preHandler: session("release"),
      handler: async (request, reply) => {
        try {
          return reply.send(
            await decideAtGate({
              actor: await actorOf(request),
              partyId: request.body.party_id,
              items: request.body.items,
              decision: request.body.decision,
              reason: request.body.reason,
            })
          );
        } catch (err) {
          return refuse(reply, err);
        }
      },
    }
  );

  app.get("/release/rules", {
    schema: {
      tags: ["showings"],
      summary: "The standing rules of the parties whose material you release, and the conditions a rule may have",
    },
    preHandler: [...signedIn, requirePermission("release")],
    handler: async (request, reply) =>
      reply.send({ rules: await releaseRulesFor(await actorOf(request)), conditions: RULE_CONDITIONS }),
  });

  app.post<{ Body: { party_id: string; page_label: string; to_label?: string | null; outside?: boolean; condition: keyof typeof RULE_CONDITIONS; covers_verdict?: boolean } }>(
    "/release/rules",
    {
      schema: {
        tags: ["showings"],
        summary: "Set a standing rule that releases parts for one party at one boundary without a person deciding each (holders of release for that party, from a signed-in session)",
        description:
          "A rule is a condition the system tests from the record with no judgment in it. It applies to pages that " +
          "reach the gate after it is set, and each release it makes is recorded as made under it.",
        body: {
          type: "object",
          required: ["party_id", "page_label", "condition"],
          properties: {
            party_id: UUID,
            page_label: { type: "string", minLength: 1 },
            to_label: { type: ["string", "null"] },
            outside: { type: "boolean" },
            condition: { type: "string", enum: Object.keys(RULE_CONDITIONS) },
            covers_verdict: { type: "boolean" },
          },
        },
      },
      preHandler: session("release"),
      handler: async (request, reply) => {
        const outside = request.body.outside === true;
        const toLabel = outside ? null : (request.body.to_label ?? null);
        if (!outside && !toLabel) {
          return reply.code(400).send({ error: "Say which boundary the rule is for: to_label, or outside.", code: "NO_DESTINATION" });
        }
        try {
          return reply.code(201).send(
            await setReleaseRule({
              actor: await actorOf(request),
              partyId: request.body.party_id,
              pageLabel: request.body.page_label,
              toLabel,
              condition: request.body.condition,
              coversVerdict: request.body.covers_verdict === true,
            })
          );
        } catch (err) {
          return refuse(reply, err);
        }
      },
    }
  );

  app.delete<{ Params: { rule_id: string } }>("/release/rules/:rule_id", {
    schema: {
      tags: ["showings"],
      summary: "End a standing rule (holders of release for its party, from a signed-in session)",
      params: { type: "object", required: ["rule_id"], properties: { rule_id: UUID } },
    },
    preHandler: session("release"),
    handler: async (request, reply) => {
      try {
        await endReleaseRule({ actor: await actorOf(request), ruleId: request.params.rule_id });
        return reply.send({ ok: true });
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  // ---- the policy ----

  app.put<{ Body: { from_label: string; to_label?: string | null; outside?: boolean; categories: Array<{ name: string; covers: string; examples?: string }> } }>(
    "/redaction-policies",
    {
      schema: {
        tags: ["showings"],
        summary: "Save a new version of one boundary's redaction policy (administrators, from a signed-in session)",
        description:
          "Give the whole list of categories for the boundary. How removal works and what is shown whenever a page " +
          "is shown are the same at every boundary and are not part of what is saved. A category defined by whether " +
          "a passage is favorable, or one that names something always shown, is refused with the reason.",
        body: {
          type: "object",
          required: ["from_label", "categories"],
          properties: {
            from_label: { type: "string", minLength: 1 },
            to_label: { type: ["string", "null"] },
            outside: { type: "boolean" },
            categories: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "covers"],
                properties: { name: { type: "string" }, covers: { type: "string" }, examples: { type: "string" } },
              },
            },
          },
        },
      },
      preHandler: session("administer"),
      handler: async (request, reply) => {
        const outside = request.body.outside === true;
        const to = outside ? null : (request.body.to_label ?? null);
        if (!outside && !to) {
          return reply.code(400).send({ error: "Say which boundary the policy is for: to_label, or outside.", code: "NO_DESTINATION" });
        }
        const labels = new Set((await rawQuery<{ name: string }>(`SELECT name FROM labels`)).map((r) => r.name));
        if (!labels.has(request.body.from_label) || (to !== null && !labels.has(to))) {
          return reply.code(404).send({ error: "One of those labels is not defined in this deployment.", code: "UNKNOWN_LABEL" });
        }
        const saved = await savePolicyVersion({
          boundary: { from: request.body.from_label, to },
          categories: request.body.categories.map((c) => ({ name: c.name, covers: c.covers, examples: c.examples ?? "" })),
          savedBy: request.auth!.userId!,
        });
        if (!saved.ok) return reply.code(400).send({ error: saved.message, code: saved.code, problems: saved.problems });
        return reply.code(201).send({ policy_id: saved.policy.id, boundary_id: saved.policy.boundary_id, version: saved.policy.version, hash: saved.policy.hash, text: saved.policy.body });
      },
    }
  );
}
