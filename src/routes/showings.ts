/**
 * The gate: the routes (docs/the-gate.md, docs/showing-a-page.md;
 * services/gate-service.ts, gate-settings-service.ts, showing-service.ts,
 * release-gate-service.ts). Mounted only where READS=members
 * (server/app.ts): the public graph has one label and no gate.
 *
 *   GET    /gates: the gates the caller has a say over or reads, with
 *     their settings.
 *   PUT    /gates/:gate_id: what holds for a gate as a whole: what flows,
 *     whether the backlog is shown, whether what is released outside is
 *     sent (administer).
 *   PUT    /gates/:gate_id/settings: open, the Redactor decides, or a
 *     person decides as well, for a kind and a scope (administer for the
 *     gate as a whole; release for a party's material).
 *   DELETE /gates/settings/:setting_id: end a setting.
 *   GET    /gate/backlog: how much waits at each gate, of what kinds, for
 *     how long and on whom. No content.
 *   GET    /gate/queue: what waits on the caller at a gate (release).
 *   POST   /gate/decisions: release, approve, remove, hold, delay or lift,
 *     many items at once (release).
 *   GET    /gate/items: what came through a gate to a label the caller
 *     reads, other than nodes' pages.
 *   POST   /gate/offers: offer a mandate, or a mandate's funding of work,
 *     to a gate (direct).
 *   GET    /showings, /showings/:showing_id, /showings/:showing_id/pages/:page_id:
 *     flows of nodes' pages and what they showed, from either side.
 *   POST   /showings: set a flow of pages for a node, what sits under it,
 *     a mandate's work or a whole boundary (direct).
 *   POST   /showings/:showing_id/end: end a standing flow (direct).
 *   POST   /showings/:showing_id/pages/:page_id/hold: hold an item not yet
 *     shown, or lift that hold (direct).
 *   POST   /showings/:showing_id/pages/:page_id/commission: pay by hand
 *     for an item's redaction or its check (fund).
 *   GET    /redaction-policies, GET /redaction-policies/:policy_id.
 *   PUT    /redaction-policies: save a new version of a boundary's policy
 *     (administer).
 *
 * Who may act. Each act at a gate takes a permission (`release` for a
 * party, `direct`, `administer`) and is recorded with the account that
 * made it and the permissions it held. The account may act from a
 * signed-in session or through a key or token of its own, so the person a
 * gate's authorities put there can use their own agent or a script: every
 * route here is an MCP tool (mcp/route-tools.ts). A key carries its
 * account's permissions and no others.
 *
 * The acts write on both sides of a boundary, which may share no label, so
 * each route checks the account's permission and the service then writes
 * as the tables' owner. The reads run with the caller's own clearance.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { holdsPermission, standingOf } from "../permissions.js";
import { requirePermission } from "../server/require-permission.js";
import { rawQuery } from "../db/client.js";
import { commissionAction } from "../services/commission-service.js";
import { owlsToMicroUsd } from "../services/owl.js";
import { listParties } from "../services/party-service.js";
import { GATE_ACTS, GATE_KINDS, GATE_MODES, GATE_SCOPES } from "../services/gate-kinds.js";
import { fundBelow, offerToGate } from "../services/gate-service.js";
import { FLOW_WORDS, GateError, endGateSetting, gatesFor, keepCurrentWords, setGate, setGateMode } from "../services/gate-settings-service.js";
import { policyById, readablePolicies, savePolicyVersion } from "../services/redaction-policy.js";
import {
  HOLD_REASONS,
  askedShowings,
  decideAtGate,
  gateBacklog,
  gateQueue,
  holdPage,
  settleWaiting,
  shownItems,
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

/** What a person is told before they offer a mandate to the gate to outside. */
export const OFFERING_OUTSIDE_SHOWS =
  "It shows outside that your organization runs a graph that takes such requests, the mandate's name and terms as the gate lets them " +
  "through, and how the gate to outside is set for its work, which is restated there, with its date, whenever a setting changes. What is " +
  "asked of it is paid for from the mandate's own budget here: owls on the public graph do not pay for work in this deployment.";

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
  NOT_YOURS_TO_SET: 403,
  GATE_NOT_FOUND: 404,
  SETTING_NOT_FOUND: 404,
  MANDATE_NOT_FOUND: 404,
};

/** The person acting, with the permissions they hold as the record will show them. */
async function actorOf(request: FastifyRequest): Promise<GateActor & { administer: boolean }> {
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
    administer: holdsPermission(standing, "administer"),
  };
}

export async function showingRoutes(app: FastifyInstance): Promise<void> {
  const signedIn = [app.authenticate, app.requireUser];
  // An account that holds the permission, from a session or through a key or token of its own.
  const holder = (permission: "direct" | "release" | "administer") => [app.authenticate, app.requireUser, requirePermission(permission)];
  // An authority of some gate: an administrator, or a holder of release for a party.
  const authority = [
    app.authenticate,
    app.requireUser,
    async (request: FastifyRequest, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
      const standing = standingOf(request.auth);
      if (!holdsPermission(standing, "administer") && !standing.grants.some((g) => g.permission === "release")) {
        return reply.code(403).send({ error: "A gate is set by an administrator, or by someone who holds release for a party.", code: "NOT_YOURS_TO_SET" });
      }
    },
  ];

  const refuse = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => {
    if (err instanceof ShowingError || err instanceof GateError) {
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
        "to; `asked` lists them from the side they were asked for at, with where each page's redaction stands and, " +
        "for a page at the release gate, which kinds of part wait on which party (`waiting_on`: kind and party, " +
        "never text). `hold_reasons` and `end_reasons` are the fixed lists a hold and an ending give their reason from.",
      querystring: { type: "object", properties: { node_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) =>
      reply.send({
        shown: await shownShowings({ nodeId: request.query.node_id }),
        asked: await askedShowings(),
        // The two fixed lists a hold and an ending take their reason from, each key with the words the other side is told.
        hold_reasons: HOLD_REASONS,
        end_reasons: END_REASONS,
      }),
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

  app.post<{ Body: { node_id?: string; mandate_id?: string; page_label: string; to_label?: string | null; outside?: boolean; form?: "once" | "standing"; scope: "node" | "under" | "mandate" | "boundary" } }>(
    "/showings",
    {
      schema: {
        tags: ["gate"],
        summary: "Set a flow of nodes' pages through a gate: for one node, a node with what sits under it, one mandate's work, or everything at the label (people who direct the graph)",
        description:
          "Pages written at `page_label` are offered to the gate toward `to_label`, or toward outside the deployment with `outside`. " +
          "`scope` says which: `node` (with `node_id`), `under` (the node with what sits under it), `mandate` (with `mandate_id`: " +
          "every node that mandate's work assessed) or `boundary` (every node assessed at the label). `form` is `standing` (each later " +
          "version follows as it is finished; the default) or, for a node, `once` (the page as it stands, dated). " +
          "Setting a flow shows nothing by itself: each page goes through the gate under its setting. Its redaction and the " +
          "check of it are paid from the budget of the work that produced the page, with no further act.",
        body: {
          type: "object",
          required: ["page_label", "scope"],
          properties: {
            node_id: UUID,
            mandate_id: UUID,
            page_label: { type: "string", minLength: 1 },
            to_label: { type: ["string", "null"] },
            outside: { type: "boolean" },
            form: { type: "string", enum: [...SHOWING_FORMS] },
            scope: { type: "string", enum: SHOWING_SCOPES.filter((x) => x !== "item") },
          },
        },
      },
      preHandler: holder("direct"),
      handler: async (request, reply) => {
        const actor = await actorOf(request);
        const { node_id, mandate_id, page_label, scope } = request.body;
        const form = request.body.form ?? "standing";
        const outside = request.body.outside === true;
        const toLabel = outside ? null : (request.body.to_label ?? null);
        if (!outside && !toLabel) {
          return reply.code(400).send({ error: "Say where the pages are to go: to_label, or outside.", code: "NO_DESTINATION" });
        }
        // A person sets a flow of pages they can read.
        if (!actor.clearance.includes(page_label)) {
          return reply.code(404).send({ error: `No active node with that id is read at "${page_label}".`, code: "NODE_NOT_FOUND" });
        }
        try {
          return reply.code(201).send(await askShowing({ nodeId: node_id ?? null, scopeRef: mandate_id ?? null, pageLabel: page_label, toLabel, form, scope, actor }));
        } catch (err) {
          return refuse(reply, err);
        }
      },
    }
  );

  app.post<{ Params: { showing_id: string }; Body: { reason: keyof typeof END_REASONS } }>("/showings/:showing_id/end", {
    schema: {
      tags: ["showings"],
      summary: "End a standing flow of pages (people who direct the graph)",
      description: "Later versions no longer follow. What was shown stays shown, and the showing stays on the record with the date and the reason.",
      params: { type: "object", required: ["showing_id"], properties: { showing_id: UUID } },
      body: { type: "object", required: ["reason"], properties: { reason: { type: "string", enum: Object.keys(END_REASONS) } } },
    },
    preHandler: holder("direct"),
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
        summary: "Hold an item that has not been shown, or lift that hold (people who direct the graph)",
        description:
          "The hold shows on the other side with its date and its reason, which is one of a fixed list. It can be lifted and is never deleted. A page already shown cannot be held.",
        params: { type: "object", required: ["showing_id", "page_id"], properties: { showing_id: UUID, page_id: UUID } },
        body: { type: "object", properties: { lift: { type: "boolean" }, reason: { type: "string", enum: Object.keys(HOLD_REASONS) } } },
      },
      preHandler: holder("direct"),
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

  app.get("/gates", {
    schema: {
      tags: ["gate"],
      summary: "The gates you have a say over or read, each with what is set for it",
      description:
        "There is one gate for each boundary: the pair of the label a thing is produced at and where it goes, a label or outside. " +
        "For each: what flows to it without anyone asking item by item, whether its backlog is shown to the other side, and its " +
        "settings by kind of thing, scope and party. A setting is `open`, `redactor` or `person`; `starting_positions` says " +
        "what holds for a kind where nothing is set. `you_may_set` says what you can change here.",
    },
    preHandler: signedIn,
    handler: async (request, reply) =>
      reply.send({ gates: await gatesFor(await actorOf(request)), modes: GATE_MODES, kinds: GATE_KINDS, scopes: GATE_SCOPES, flows: FLOW_WORDS, acts: GATE_ACTS }),
  });

  app.put<{
    Params: { gate_id: string };
    Body: { flow?: "asked" | "everything"; backlog_shown?: boolean; send_as_released?: boolean; keep_current_mandate?: string | null; keep_current_owls?: number };
  }>("/gates/:gate_id", {
    schema: {
      tags: ["gate"],
      summary: "Set what holds for a gate as a whole: what flows to it, whether its backlog is shown, whether what is released outside is sent, and which mandate is asked to keep the other side current (administrators)",
      description:
        "`flow` is `asked` (" + FLOW_WORDS.asked + ") or `everything` (" + FLOW_WORDS.everything + ") " +
        "`backlog_shown` says whether readers on the other side see how much waits and on whom; it starts true. " +
        "For the gate to outside, `send_as_released` says whether what is released is sent to the public graph as it is released, " +
        "with no person sending each package; it starts true. `keep_current_mandate` names the mandate that is asked to pay for a fresh " +
        "assessment on the other side each time a version here changes on a node the other side holds, or null to ask nothing, which is " +
        "where a gate starts. Between two labels it is a mandate at the label things come from, and `keep_current_owls` is what it pays for " +
        "each pass. For the gate to outside it is a public mandate your organization funds on the public graph, which pays there in public " +
        "owls. Each asking is an item at this gate of the kind `funding`, so it goes under the gate's setting for that kind, with any delay " +
        "or batches the setting has, and shows the other side which nodes are worked on here and when. Versions made before a mandate was " +
        "named are not asked about. Send only what you are changing. Sending what already stands changes nothing.",
      params: { type: "object", required: ["gate_id"], properties: { gate_id: UUID } },
      body: {
        type: "object",
        properties: {
          flow: { type: "string", enum: ["asked", "everything"] },
          backlog_shown: { type: "boolean" },
          send_as_released: { type: "boolean" },
          keep_current_mandate: { type: "string", format: "uuid", nullable: true },
          keep_current_owls: { type: "number", minimum: 0 },
        },
      },
    },
    preHandler: holder("administer"),
    handler: async (request, reply) => {
      try {
        const actor = await actorOf(request);
        const gate = await setGate({
          boundaryId: request.params.gate_id,
          flow: request.body.flow,
          backlogShown: request.body.backlog_shown,
          sendAsReleased: request.body.send_as_released,
          keepCurrentMandate: request.body.keep_current_mandate,
          keepCurrentOwls: request.body.keep_current_owls,
          actor,
        });
        // "Everything" is a standing flow of every page at the label, set under this administrator's name; "asked" ends it.
        if (request.body.flow === "everything") {
          await askShowing({ pageLabel: gate.from_label, toLabel: gate.to_label, form: "standing", scope: "boundary", actor }).catch((err: unknown) => {
            if (!(err instanceof ShowingError && err.code === "ALREADY_STANDING")) throw err;
          });
        }
        if (request.body.flow === "asked") {
          const [flow] = await rawQuery<{ id: string }>(
            `SELECT id FROM shown_showings WHERE boundary_id = $1 AND scope = 'boundary' AND ended_at IS NULL`,
            [gate.boundary_id]
          );
          if (flow) await endShowing({ showingId: flow.id, reason: "no_longer_needed", actor });
        }
        return reply.send({
          gate_id: gate.boundary_id,
          flow: gate.flow,
          flow_in_words: FLOW_WORDS[gate.flow],
          backlog_shown_to_the_other_side: gate.backlog_shown,
          ...(gate.to_outside ? { send_as_released: gate.send_as_released } : {}),
          keeps_the_other_side_current: keepCurrentWords(gate),
          keep_current_mandate: gate.keep_current_mandate,
        });
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.put<{ Params: { gate_id: string }; Body: { mode: string; kind?: string; scope?: string; scope_ref?: string; party_id?: string; delay_hours?: number; batch_hours?: number } }>("/gates/:gate_id/settings", {
    schema: {
      tags: ["gate"],
      summary: "Set how a gate treats a kind of thing in a scope: open, the Redactor decides, or a person decides as well",
      description:
        "`mode` is `open` (" + GATE_MODES.open + "), `redactor` (" + GATE_MODES.redactor + ") or `person` (" + GATE_MODES.person + ") " +
        "`kind` is one kind of thing (" + Object.keys(GATE_KINDS).join(", ") + ") or `*` for every kind, which is the default. " +
        "`scope` is `boundary` (the default), or `mandate`, `under` or `request` with `scope_ref` naming the mandate, the node or the request. " +
        "With `party_id` the setting is for that party's material and is set by someone who holds release for the party; without it the " +
        "setting is for every party that has not said, and is an administrator's. A party's own setting is taken before the gate's, the " +
        "narrowest scope that covers an item before a wider one, and a setting for the item's kind before one for every kind. " +
        "`delay_hours` keeps what the setting lets through back that long from when it was produced, and `batch_hours` then sends it at the " +
        "next multiple of that interval, so that items go together and when one was made is not told by when it arrived; left out, neither. " +
        "For the gate to outside, a setting is part of what each mandate the organization has published says of itself on the public graph, " +
        "so changing one is shown there with its date. " +
        "It applies from now to everything not yet released. Setting what already stands changes nothing.",
      params: { type: "object", required: ["gate_id"], properties: { gate_id: UUID } },
      body: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: { type: "string", enum: Object.keys(GATE_MODES) },
          kind: { type: "string", enum: ["*", ...Object.keys(GATE_KINDS)] },
          scope: { type: "string", enum: Object.keys(GATE_SCOPES) },
          scope_ref: UUID,
          party_id: UUID,
          delay_hours: { type: "integer", minimum: 0, maximum: 2160 },
          batch_hours: { type: "integer", minimum: 0, maximum: 2160 },
        },
      },
    },
    preHandler: authority,
    handler: async (request, reply) => {
      try {
        const set = await setGateMode({
          boundaryId: request.params.gate_id,
          kind: request.body.kind,
          scope: request.body.scope,
          scopeRef: request.body.scope_ref ?? null,
          partyId: request.body.party_id ?? null,
          mode: request.body.mode,
          delayHours: request.body.delay_hours,
          batchHours: request.body.batch_hours,
          actor: await actorOf(request),
        });
        // A loosened setting lets through what was waiting on it.
        const let_through = set.changed ? await settleWaiting({ boundaryId: request.params.gate_id }) : 0;
        return reply.send({ ...set, let_through_now: let_through });
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.delete<{ Params: { setting_id: string } }>("/gates/settings/:setting_id", {
    schema: {
      tags: ["gate"],
      summary: "End one setting of a gate, so that what it covered falls under the next widest setting or the starting position",
      params: { type: "object", required: ["setting_id"], properties: { setting_id: UUID } },
    },
    preHandler: authority,
    handler: async (request, reply) => {
      try {
        const ended = await endGateSetting({ settingId: request.params.setting_id, actor: await actorOf(request) });
        if (ended.changed) await settleWaiting();
        return reply.send(ended);
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.get<{ Querystring: { gate_id?: string } }>("/gate/backlog", {
    schema: {
      tags: ["gate"],
      summary: "How much has not gone through each gate toward a label you read: how many items, of what kinds, for how long, and what each waits on",
      description:
        "Counts and fixed words: the budget, the Redactor's run, Audit's check, the Redactor's hold, a person's hold or decision by party, a delay. " +
        "Nothing says what any item contains, and the label things come from is named only to someone who has a say over the gate. " +
        "A long wait on a hold or on a person suggests the policy or the setting needs changing.",
      querystring: { type: "object", properties: { gate_id: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send(await gateBacklog(await actorOf(request), { boundaryId: request.query.gate_id })),
  });

  app.get<{ Querystring: { limit?: number; kind?: string } }>("/gate/queue", {
    schema: {
      tags: ["gate"],
      summary: "What waits on you at a gate, with everything needed to decide each item",
      description:
        "The items that rest on the material of a party you release for and have not gone through: those whose gate is set to a " +
        "person's decision, and those the Redactor or a person holds or has delayed. Each item is a part, or the item itself, as it " +
        "would be shown: after removals, with the marks, with what is always shown of it. It carries what the Redactor proposes " +
        "(let through, hold or delay), its removals by category, whether it flagged the part, Audit's answer, the parties to decide " +
        "for and the setting each is under. A person who also reads the label the item was written at is given the part as written, " +
        "each removed passage with the Redactor's note, and why a part was flagged. `kind` narrows it to one kind of thing.",
      querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 }, kind: { type: "string", enum: Object.keys(GATE_KINDS) } } },
    },
    preHandler: holder("release"),
    handler: async (request, reply) => reply.send(await gateQueue(await actorOf(request), { limit: request.query.limit, kind: request.query.kind })),
  });

  app.post<{
    Body: {
      decision?: keyof typeof GATE_ACTS;
      party_id?: string;
      reason?: string;
      until?: string;
      items: Array<{ item_id?: string; page_id?: string; part?: number | null; decision?: keyof typeof GATE_ACTS; party_id?: string; reason?: string; until?: string; passage?: string; occurrence?: number; category?: string }>;
    };
  }>("/gate/decisions", {
    schema: {
      tags: ["gate"],
      summary: "Act at a gate on many items at once: release, approve as the Redactor left it, remove a passage, hold, delay, or lift (holders of release)",
      description:
        "Each item names an item (`item_id`, from the queue) and a part number, or the item alone for the item itself. `decision` is one of: " +
        Object.entries(GATE_ACTS).map(([k, v]) => `\`${k}\` (${v})`).join(" ") +
        " Give it once for the whole call or on each item. `hold` takes a `reason` from the fixed list; `delay` takes `until`, a date and time; " +
        "`remove` takes `passage` exactly as it appears in the part and a `category` of the boundary's policy, and can be done until the item " +
        "itself has been shown. An act is made for every party of yours the item rests on, or for `party_id` alone. No act changes a word. " +
        "A release is not taken back. Sending the same decision again changes nothing and is counted under `unchanged`; an item that cannot " +
        "be acted on as asked is listed under `refused` with the reason, and the others are decided.",
      body: {
        type: "object",
        required: ["items"],
        properties: {
          decision: { type: "string", enum: Object.keys(GATE_ACTS) },
          party_id: UUID,
          reason: { type: "string", enum: Object.keys(HOLD_REASONS) },
          until: { type: "string", format: "date-time" },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 500,
            items: {
              type: "object",
              properties: {
                item_id: UUID,
                page_id: UUID,
                part: { type: ["integer", "null"] },
                decision: { type: "string", enum: Object.keys(GATE_ACTS) },
                party_id: UUID,
                reason: { type: "string", enum: Object.keys(HOLD_REASONS) },
                until: { type: "string", format: "date-time" },
                passage: { type: "string" },
                occurrence: { type: "integer", minimum: 1 },
                category: { type: "string" },
              },
            },
          },
        },
      },
    },
    preHandler: holder("release"),
    handler: async (request, reply) => {
      try {
        return reply.send(
          await decideAtGate({
            actor: await actorOf(request),
            partyId: request.body.party_id,
            items: request.body.items,
            decision: request.body.decision,
            reason: request.body.reason,
            until: request.body.until,
          })
        );
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.get<{ Querystring: { kind?: string; answers?: string } }>("/gate/items", {
    schema: {
      tags: ["gate"],
      summary: "What has come through a gate to a label you read, other than nodes' pages: answers, that a request was taken up, mandates, funding",
      description:
        "Each with its kind, when it was offered, where it stands in fixed words and, once through, the source its text is in. " +
        "`answers` narrows it to what answers one request or message at your label.",
      querystring: { type: "object", properties: { kind: { type: "string", enum: Object.keys(GATE_KINDS).filter((k) => k !== "page") }, answers: UUID } },
    },
    preHandler: signedIn,
    handler: async (request, reply) => reply.send({ items: await shownItems({ kind: request.query.kind, replyRef: request.query.answers }) }),
  });

  app.post<{ Body: { kind: "mandate" | "funding"; mandate_id: string; to_label?: string; outside?: boolean; node_id?: string; owls?: number } }>("/gate/offers", {
    schema: {
      tags: ["gate"],
      summary: "Offer to a gate that a mandate exists, with its terms, or a mandate's funding of a fresh assessment of a node on the other side (people who direct the graph)",
      description:
        "`mandate`: the mandate's name, terms and budget are offered to readers at `to_label`, who do not read the mandate's label. " +
        "With `outside` in place of `to_label`, the mandate is offered to the gate to outside: once through, it stands on the organization's " +
        "record on the public graph, with how that gate is set for the mandate's work, and requests on the public graph can be addressed " +
        "to it. Its Grantmaker decides which of those to take up, under the mandate's terms, with no person acting each time; that one was " +
        "taken up or declined, and the page of each node it bears on, then go to the gate to outside as they are ready. " + OFFERING_OUTSIDE_SHOWS + " " +
        "`funding`: the mandate pays `owls` for a pass on `node_id` at `to_label`; the pass is commissioned there from the mandate's budget " +
        "when the offer is through the gate. " +
        "Either goes through the gate under its setting. Offering the same thing again returns the item already there. Ending the offer " +
        "(POST /showings/:showing_id/end, with the offer's id) withdraws a mandate that was offered outside.",
      body: {
        type: "object",
        required: ["kind", "mandate_id"],
        properties: {
          kind: { type: "string", enum: ["mandate", "funding"] },
          mandate_id: UUID,
          to_label: { type: "string", minLength: 1 },
          outside: { type: "boolean" },
          node_id: UUID,
          owls: { type: "number", minimum: 0 },
        },
      },
    },
    preHandler: holder("direct"),
    handler: async (request, reply) => {
      const { kind, mandate_id, node_id, owls } = request.body;
      const outside = request.body.outside === true;
      const to_label = request.body.to_label ?? "";
      if (outside === (to_label !== "")) return reply.code(400).send({ error: "Say where it goes: `to_label`, or `outside`.", code: "NO_DESTINATION" });
      if (outside && kind !== "mandate") {
        return reply.code(400).send({ error: "A fresh public assessment is asked of a public mandate by naming it on the gate to outside (keep_current_mandate), or by a person from the node's page.", code: "NOT_OUTSIDE" });
      }
      const [grant] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM grants WHERE id = $1`, [mandate_id]);
      if (!grant) return reply.code(404).send({ error: "No mandate with that id is at a label you read.", code: "MANDATE_NOT_FOUND" });
      if (kind === "funding" && !node_id) return reply.code(400).send({ error: "Say which node the funding is for.", code: "NO_NODE" });
      try {
        const offered =
          kind === "funding"
            ? await fundBelow({ grantId: mandate_id, nodeId: node_id!, toLabel: to_label, amountMicroUsd: owlsToMicroUsd(owls ?? 0) })
            : await offerToGate({ kind: "mandate", fromLabel: grant.label, toLabel: outside ? null : to_label, subject: { grantId: mandate_id } });
        if (!offered) {
          return reply.code(409).send({
            error: outside
              ? "There is nothing to offer: this deployment has not said which party is the organization itself, or holds one label only."
              : `Readers at "${to_label}" already read the mandate's label, or there is nothing to offer.`,
            code: "NOTHING_TO_OFFER",
          });
        }
        if (outside) {
          const [offer] = await rawQuery<{ showing_id: string }>(`SELECT showing_id FROM shown_pages WHERE id = $1`, [offered.item_id]);
          return reply.code(201).send({ ...offered, offer_id: offer?.showing_id ?? null, addressed_on_the_public_graph_as: offer?.showing_id ?? null, what_it_shows_outside: OFFERING_OUTSIDE_SHOWS });
        }
        return reply.code(201).send(offered);
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
        summary: "Save a new version of one boundary's redaction policy, which is how a gate is mostly tightened or loosened (administrators)",
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
      preHandler: holder("administer"),
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
