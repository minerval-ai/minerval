/**
 * Page routes (#646): things made for a user to keep.
 *
 *   POST   /pages       — save a page: create one, or with `id` replace one.
 *   GET    /pages       — the user's pages.
 *   GET    /pages/:id   — one page, with the nodes it embeds as they stand.
 *   DELETE /pages/:id   — delete one. The signed-in user only.
 *
 * A page is private to its user and free to save and read. Saving is open
 * to anything that holds the user's key, so their Assistant and their own
 * agent can both make one; deleting takes the dashboard session, because a
 * page is the user's to throw away and nothing an agent reads should be
 * able to do it for them.
 */
import type { FastifyInstance } from "fastify";
import {
  deletePage,
  getPage,
  listPages,
  PAGE_MAX_BODY_CHARS,
  PAGE_MAX_DECOMPOSITIONS,
  PAGE_MAX_NODES,
  PAGE_MAX_TITLE_CHARS,
  PAGE_VERSIONS_KEPT,
  getSharedPage,
  savePage,
  serializePage,
  serializeSharedPage,
  sharePage,
  unsharePage,
  serializePageSummary,
} from "../services/page-service.js";

const SAVE_DESCRIPTION =
  "Save a page for your user: something they will keep or hand to someone (a brief, a ranked " +
  "list, a table of nodes), in place of a long reply. Private to them; they read, edit, export " +
  "and delete it on its page_url. Free. Omit `id` to create a page; give it to replace one, and " +
  `the earlier text is kept as a version (the last ${PAGE_VERSIONS_KEPT}).\n\n` +
  "The body is markdown. It can show nodes of the graph live: whoever opens the page sees each " +
  "one as the graph holds it then, marked where it has moved since you saved. Nothing else in a " +
  "page is live, and no code in it runs.\n" +
  "- `[claim:<uuid>]` inline: a numbered citation with the node's current status.\n" +
  "- `{{node <uuid>}}` on a line of its own: the node as a card.\n" +
  "- `{{nodes <uuid> <uuid> ...}}` on a line of its own: a table of those nodes that the reader " +
  "can sort by judgment or confidence.\n" +
  "- `{{decomposition <uuid>}}` on a line of its own: the node with the parts it rests on.\n\n" +
  `Limits, each because a page is read in one request: a body of ${PAGE_MAX_BODY_CHARS} ` +
  `characters, ${PAGE_MAX_NODES} distinct embedded nodes, ${PAGE_MAX_DECOMPOSITIONS} ` +
  "decompositions. An id the graph does not hold is reported back as unresolved and shown as such.";

const ID_PARAMS = {
  type: "object",
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export async function pageRoutes(app: FastifyInstance) {
  const guards = [app.authenticate, app.requireUser];
  const sessionGuards = [app.authenticate, app.requireSession, app.requireUser];

  app.post<{ Body: { id?: string; title: string; body: string } }>("/", {
    schema: {
      tags: ["pages"],
      summary: "Save a page for your user: markdown with live embeds of graph nodes",
      description: SAVE_DESCRIPTION,
      body: {
        type: "object",
        required: ["title", "body"],
        properties: {
          id: {
            type: "string",
            format: "uuid",
            description: "The page to replace. Omit to create a new one.",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: PAGE_MAX_TITLE_CHARS,
            description:
              "Your user's title for it. It is shown above the body, so the body should not open by repeating it.",
          },
          body: {
            type: "string",
            minLength: 1,
            maxLength: PAGE_MAX_BODY_CHARS,
            description: "The page, in markdown, with any embeds.",
          },
        },
      },
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const result = await savePage({
        userId: request.auth!.userId!,
        id: request.body.id ?? null,
        title: request.body.title,
        body: request.body.body,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 400)
          .send({ error: result.message, code: result.code });
      }
      const page = await serializePage(result.page);
      // The saver wants the address and what did not resolve, not its own text back.
      return reply.code(request.body.id ? 200 : 201).send({
        page: {
          id: page.id,
          title: page.title,
          page_url: page.page_url,
          saved_at: page.saved_at,
          embedded_nodes: Object.keys(page.nodes).length,
          unresolved: page.unresolved,
        },
      });
    },
  });

  app.get<{ Querystring: { offset?: number; limit?: number } }>("/", {
    schema: {
      tags: ["pages"],
      summary: "List the pages saved to your account, newest first, a page at a time",
      querystring: {
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
        },
      },
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const pages = await listPages(request.auth!.userId!, request.query.limit ?? 100, request.query.offset ?? 0);
      return reply.send({ pages: pages.map(serializePageSummary) });
    },
  });

  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["pages"],
      summary:
        "Get one of your pages: its markdown, and every node it embeds as the graph holds it now, with what it held when the page was saved where that differs",
      params: ID_PARAMS,
    },
    preHandler: guards,
    handler: async (request, reply) => {
      const page = await getPage(request.params.id, request.auth!.userId!);
      if (!page) return reply.code(404).send({ error: "Page not found", code: "NOT_FOUND" });
      return reply.send({ page: await serializePage(page) });
    },
  });

  app.post<{ Params: { id: string } }>("/:id/share", {
    schema: {
      tags: ["pages"],
      summary: "Share one of your pages: anyone who holds the link can read it",
      params: ID_PARAMS,
    },
    preHandler: sessionGuards,
    handler: async (request, reply) => {
      const result = await sharePage(request.params.id, request.auth!.userId!);
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 409)
          .send({ error: result.message, code: result.code });
      }
      return reply.send({ page: serializePageSummary(result.page) });
    },
  });

  app.delete<{ Params: { id: string } }>("/:id/share", {
    schema: {
      tags: ["pages"],
      summary: "Stop sharing one of your pages: its link stops working",
      params: ID_PARAMS,
    },
    preHandler: sessionGuards,
    handler: async (request, reply) => {
      const done = await unsharePage(request.params.id, request.auth!.userId!);
      if (!done) return reply.code(404).send({ error: "Page not found", code: "NOT_FOUND" });
      return reply.send({ shared: false });
    },
  });

  app.delete<{ Params: { id: string } }>("/:id", {
    schema: { tags: ["pages"], summary: "Delete one of your pages", params: ID_PARAMS },
    preHandler: sessionGuards,
    handler: async (request, reply) => {
      const deleted = await deletePage(request.params.id, request.auth!.userId!);
      if (!deleted) return reply.code(404).send({ error: "Page not found", code: "NOT_FOUND" });
      return reply.send({ deleted: true });
    },
  });
}

/**
 * GET /shared-pages/:token — a page its owner shared, read by its link. No
 * account is needed: holding the link is the permission. It returns the
 * page and the nodes it embeds as they stand now, and nothing about whose
 * it is.
 */
export async function sharedPageRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>("/:token", {
    schema: {
      tags: ["pages"],
      summary:
        "Read a page its owner shared by link: its markdown, and the nodes it embeds as the graph holds them now",
      params: {
        type: "object",
        properties: { token: { type: "string", minLength: 20, maxLength: 64 } },
      },
    },
    handler: async (request, reply) => {
      const page = await getSharedPage(request.params.token);
      if (!page) return reply.code(404).send({ error: "No page is shared at this link", code: "NOT_FOUND" });
      return reply.send({ page: await serializeSharedPage(page) });
    },
  });
}
