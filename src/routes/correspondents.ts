/**
 * Correspondents (#563) — public reads of the readers mandates fund for an
 * audience, and their updates.
 *
 *   GET  /correspondents                     — discovery; ?claim_id= answers
 *     "which correspondents cover this claim?"
 *   GET  /correspondents/:id                 — one correspondent: its brief,
 *     audience, scope, cadence, record, and its funding mandate
 *   GET  /correspondents/:id/updates         — its updates, newest first:
 *     structured items for agents, the prose for people, what each left out
 *   GET  /correspondents/:id/updates/:update_id — one update
 *   GET  /correspondents/:id/feed            — the same updates as Atom
 *   POST /correspondents/:id/poke            — the mandate's manager asks for
 *     an update now
 *
 * Reads are public, as mandates are. Everything a correspondent reads to
 * write these is public too (the graph reads and GET /changes), so an
 * outside correspondent needs none of these routes.
 */
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import {
  CORRESPONDENT_BOUNDS,
  correspondentAtom,
  correspondentPublic,
  getCorrespondent,
  isUuid,
  listAllCorrespondents,
  listCorrespondentUpdates,
  listCorrespondentsCovering,
  listPlanItems,
  queueCorrespondentEvent,
  renderUpdateText,
  type CorrespondentUpdateRow,
} from "../services/correspondent-service.js";

const idParam = {
  type: "object",
  properties: { id: { type: "string", format: "uuid" } },
  required: ["id"],
} as const;

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

async function mandateFor(grantId: string): Promise<{ title: string; url: string }> {
  const [g] = await rawQuery<{ title: string }>(
    `SELECT COALESCE(mandate->>'title', name) AS title FROM grants WHERE id = $1`,
    [grantId]
  );
  return {
    title: g?.title ?? "a Minerval mandate",
    url: `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/mandates/${grantId}`,
  };
}

function updateView(u: CorrespondentUpdateRow, mandate: { title: string; url: string }) {
  return {
    id: u.id,
    correspondent_id: u.correspondent_id,
    mandate_id: u.grant_id,
    funded_by: mandate,
    title: u.title,
    body: u.body,
    items: u.items,
    not_covered: u.not_covered,
    // The body, what it left out, and who paid, as one text for a reader.
    text: renderUpdateText(u, mandate),
    changes_from: u.changes_from,
    changes_to: u.changes_to,
    created_at: new Date(u.created_at).toISOString(),
  };
}

export async function correspondentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { claim_id?: string; limit?: number; offset?: number } }>("/", {
    schema: {
      tags: ["correspondents"],
      summary:
        "Correspondents: the readers mandates fund for an audience. With claim_id, the " +
        "ones whose scope covers that claim (it, or a claim above it, or one of its tags)",
      querystring: {
        type: "object",
        properties: {
          claim_id: { type: "string", format: "uuid" },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
    },
    handler: async (request, reply) => {
      const q = request.query;
      const rows = q.claim_id
        ? await listCorrespondentsCovering(q.claim_id)
        : await listAllCorrespondents({ limit: q.limit, offset: q.offset });
      return reply.send({ correspondents: rows.map(correspondentPublic) });
    },
  });

  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["correspondents"],
      summary:
        "One correspondent: its brief, audience, scope, cadence and triggers, how many " +
        "runs and updates, its last note, its plan, and the mandate that funds it",
      params: idParam,
    },
    handler: async (request, reply) => {
      const c = await getCorrespondent(request.params.id);
      if (!c) return reply.code(404).send(errorBody("NOT_FOUND", "Correspondent not found"));
      const plan = await listPlanItems(c.id, { limit: 100 });
      return reply.send({
        correspondent: {
          ...correspondentPublic(c),
          mandate: await mandateFor(c.grant_id),
          plan: plan.map((p) => ({
            id: p.id,
            status: p.status,
            text: p.text,
            note: p.note,
            created_at: new Date(p.created_at).toISOString(),
            updated_at: new Date(p.updated_at).toISOString(),
          })),
        },
      });
    },
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>("/:id/updates", {
    schema: {
      tags: ["correspondents"],
      summary:
        "A correspondent's updates, newest first: structured items (a node, the reason it " +
        "deserves attention, the change ids behind it), the prose, and what each did not " +
        "cover (the changes in its window it did not mention, and what in scope it had not examined)",
      params: idParam,
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
    },
    handler: async (request, reply) => {
      const c = await getCorrespondent(request.params.id);
      if (!c) return reply.code(404).send(errorBody("NOT_FOUND", "Correspondent not found"));
      const mandate = await mandateFor(c.grant_id);
      const { updates, total } = await listCorrespondentUpdates(c.id, request.query);
      return reply.send({ updates: updates.map((u) => updateView(u, mandate)), total });
    },
  });

  app.get<{ Params: { id: string; update_id: string } }>("/:id/updates/:update_id", {
    schema: {
      tags: ["correspondents"],
      summary: "One correspondent update",
      params: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          update_id: { type: "string", format: "uuid" },
        },
        required: ["id", "update_id"],
      },
    },
    handler: async (request, reply) => {
      const [u] = await rawQuery<CorrespondentUpdateRow>(
        `SELECT id, correspondent_id, grant_id, title, body, items, not_covered,
                changes_from, changes_to, created_at
           FROM correspondent_updates WHERE id = $1 AND correspondent_id = $2`,
        [request.params.update_id, request.params.id]
      );
      if (!u) return reply.code(404).send(errorBody("NOT_FOUND", "Update not found"));
      return reply.send({ update: updateView(u, await mandateFor(u.grant_id)) });
    },
  });

  app.get<{ Params: { id: string } }>("/:id/feed", {
    schema: { tags: ["correspondents"], summary: "A correspondent's updates as an Atom feed", params: idParam },
    handler: async (request, reply) => {
      const c = await getCorrespondent(request.params.id);
      if (!c) return reply.code(404).send(errorBody("NOT_FOUND", "Correspondent not found"));
      const { updates } = await listCorrespondentUpdates(c.id, { limit: 50 });
      const apiBase = `${request.protocol}://${request.hostname}`;
      return reply
        .header("content-type", "application/atom+xml; charset=utf-8")
        .send(correspondentAtom(c, updates, { apiBase, mandate: await mandateFor(c.grant_id) }));
    },
  });

  app.post<{ Params: { id: string }; Body: { note: string } }>("/:id/poke", {
    schema: {
      tags: ["correspondents"],
      summary:
        "Ask a correspondent for an update now, with a note it reads. The mandate's " +
        "manager only: the run is paid from the mandate's escrow",
      params: idParam,
      body: {
        type: "object",
        properties: { note: { type: "string", minLength: 1, maxLength: CORRESPONDENT_BOUNDS.noteChars } },
        required: ["note"],
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const c = isUuid(request.params.id) ? await getCorrespondent(request.params.id) : null;
      if (!c) return reply.code(404).send(errorBody("NOT_FOUND", "Correspondent not found"));
      const [g] = await rawQuery<{ funder_user_id: string }>(`SELECT funder_user_id FROM grants WHERE id = $1`, [
        c.grant_id,
      ]);
      // The mandate pays for the run it asks for, so asking is its
      // manager's to do, as the rest of the mandate's spending is.
      if (!g || g.funder_user_id !== request.auth!.userId) {
        return reply
          .code(403)
          .send(errorBody("NOT_MANAGER", "Only the mandate's manager can ask its correspondent for an update"));
      }
      const res = await queueCorrespondentEvent({
        correspondentId: c.id,
        kind: "manual",
        payload: { note: request.body.note.trim(), from: "the mandate's manager" },
      });
      if (!res.queued) return reply.code(409).send(errorBody("NOT_ACTIVE", "The correspondent is not active"));
      return reply.send({ queued: true });
    },
  });
}
