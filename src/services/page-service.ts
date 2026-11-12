/**
 * Pages (#646): things made for a user to keep. A page is markdown with
 * embeds, and an embed names nodes of the graph by id; whoever reads the
 * page sees those nodes as the graph holds them at that moment, beside what
 * it held when the page was saved. Nothing a page's author writes is run:
 * an embed is a reference the site renders with its own components.
 *
 * Embeds, in the body:
 *
 *   [claim:<uuid>]                 inline, a numbered citation
 *   {{node <uuid>}}                on a line of its own: the node as a card
 *   {{nodes <uuid> <uuid> ...}}    a table of nodes the reader can sort
 *   {{decomposition <uuid>}}       the node with what it rests on
 *
 * A page is private to its user. It is saved by the user's Assistant or by
 * their own agent over MCP (save_page), and edited by the user on its page.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { assistantPages, type AssistantPage } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { getClaimCards, CLAIM_CARDS_MAX_IDS, type ClaimCard } from "./claim-card-service.js";
import { getClaimTree } from "./tree-service.js";
import { currentLabel } from "../llm/usage-context.js";

export const PAGE_MAX_BODY_CHARS = 200_000;
export const PAGE_MAX_TITLE_CHARS = 200;
/** Earlier saves kept beside the current one. */
export const PAGE_VERSIONS_KEPT = 20;
/** Distinct nodes one page may embed: what one card read returns. */
export const PAGE_MAX_NODES = CLAIM_CARDS_MAX_IDS;
/** Decompositions one page may embed; each is a tree read. */
export const PAGE_MAX_DECOMPOSITIONS = 10;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const INLINE_RE = new RegExp(`\\[claim:(${UUID})\\]`, "gi");
const BLOCK_RE = new RegExp(
  `^[ \\t]*\\{\\{\\s*(node|nodes|decomposition)\\s+((?:${UUID}[\\s,]*)+)\\}\\}[ \\t]*$`,
  "gim"
);
const UUID_RE = new RegExp(UUID, "gi");

export interface PageEmbeds {
  /** Every node the body names, in order of first use. */
  ids: string[];
  /** The nodes whose decomposition is embedded. */
  decompositions: string[];
}

export function pageEmbeds(body: string): PageEmbeds {
  const ids: string[] = [];
  const decompositions: string[] = [];
  const add = (list: string[], id: string) => {
    const lower = id.toLowerCase();
    if (!list.includes(lower)) list.push(lower);
  };
  for (const m of body.matchAll(INLINE_RE)) add(ids, m[1]!);
  for (const m of body.matchAll(BLOCK_RE)) {
    for (const id of m[2]!.match(UUID_RE) ?? []) {
      add(ids, id);
      if (m[1]!.toLowerCase() === "decomposition") add(decompositions, id);
    }
  }
  return { ids, decompositions };
}

/** What the graph held for a node, small enough to keep with a page. */
interface Held {
  status: string | null;
  standing: string | null;
  estimate: unknown | null;
}

function heldOf(card: ClaimCard): Held {
  return { status: card.assessment_status, standing: card.standing, estimate: card.estimate };
}

function sameHeld(a: Held | undefined, b: Held): boolean {
  if (!a) return true;
  return (
    a.status === b.status &&
    a.standing === b.standing &&
    JSON.stringify(a.estimate ?? null) === JSON.stringify(b.estimate ?? null)
  );
}

export type PageResult =
  | { ok: true; page: AssistantPage }
  | {
      ok: false;
      code: "NOT_FOUND" | "EMPTY" | "TOO_LONG" | "TOO_MANY_NODES";
      message: string;
    };

/**
 * Create a page, or with `id` replace one: the earlier title and text are
 * kept as a version. Records what the graph holds now for every node the
 * body embeds.
 */
export async function savePage(input: {
  userId: string;
  id?: string | null;
  title: string;
  body: string;
}): Promise<PageResult> {
  const title = input.title.replace(/\s+/g, " ").trim();
  const body = input.body.trim();
  if (!title || !body) {
    return { ok: false, code: "EMPTY", message: "A page needs a title and a body" };
  }
  if (title.length > PAGE_MAX_TITLE_CHARS || body.length > PAGE_MAX_BODY_CHARS) {
    return {
      ok: false,
      code: "TOO_LONG",
      message: `A title holds ${PAGE_MAX_TITLE_CHARS} characters and a body ${PAGE_MAX_BODY_CHARS}; this body is ${body.length}`,
    };
  }
  const embeds = pageEmbeds(body);
  if (embeds.ids.length > PAGE_MAX_NODES || embeds.decompositions.length > PAGE_MAX_DECOMPOSITIONS) {
    return {
      ok: false,
      code: "TOO_MANY_NODES",
      message:
        `A page embeds at most ${PAGE_MAX_NODES} distinct nodes and ${PAGE_MAX_DECOMPOSITIONS} decompositions; ` +
        `this one names ${embeds.ids.length} and ${embeds.decompositions.length}. Split it, or link the rest by page_url`,
    };
  }
  const cards = await getClaimCards(embeds.ids);
  const snapshot: Record<string, Held> = {};
  for (const [id, card] of cards) snapshot[id] = heldOf(card);
  const now = new Date();
  const db = getDb();

  if (!input.id) {
    const [page] = await db
      .insert(assistantPages)
      // A new page carries the label of the run or request that makes it; a
      // later save lands on the row and leaves it (src/labels.ts).
      .values({ userId: input.userId, title, body, snapshot, savedAt: now, sensitivityLabel: currentLabel() })
      .returning();
    return { ok: true, page: page! };
  }

  const existing = await getPage(input.id, input.userId);
  if (!existing) return { ok: false, code: "NOT_FOUND", message: "Page not found" };
  const versions = [
    ...((existing.versions ?? []) as unknown[]),
    { title: existing.title, body: existing.body, saved_at: existing.savedAt.toISOString() },
  ].slice(-PAGE_VERSIONS_KEPT);
  const [page] = await db
    .update(assistantPages)
    .set({ title, body, snapshot, versions, savedAt: now })
    .where(and(eq(assistantPages.id, existing.id), eq(assistantPages.userId, input.userId)))
    .returning();
  return { ok: true, page: page! };
}

export async function getPage(id: string, userId: string): Promise<AssistantPage | null> {
  const [page] = await getDb()
    .select()
    .from(assistantPages)
    .where(eq(assistantPages.id, id))
    .limit(1);
  return page && page.userId === userId ? page : null;
}

export async function listPages(userId: string, limit = 100): Promise<AssistantPage[]> {
  return getDb()
    .select()
    .from(assistantPages)
    .where(eq(assistantPages.userId, userId))
    .orderBy(desc(assistantPages.savedAt))
    .limit(limit);
}

export async function deletePage(id: string, userId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(assistantPages)
    .where(and(eq(assistantPages.id, id), eq(assistantPages.userId, userId)))
    .returning({ id: assistantPages.id });
  return rows.length > 0;
}

export function pageUrl(id: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/ask/pages/${id}`;
}

/** A page as a list shows it. */
export function serializePageSummary(page: AssistantPage) {
  return {
    id: page.id,
    title: page.title,
    saved_at: page.savedAt.toISOString(),
    created_at: page.createdAt.toISOString(),
    page_url: pageUrl(page.id),
  };
}

/**
 * A page in full: its text, and every node it embeds as the graph holds it
 * now, with what it held when the page was saved where that differs.
 */
export async function serializePage(page: AssistantPage) {
  const embeds = pageEmbeds(page.body);
  const snapshot = (page.snapshot ?? {}) as Record<string, Held>;

  // A decomposition embed shows the node's direct parts; their cards are
  // read with the rest.
  const decompositions: Record<
    string,
    Array<{ id: string; relation: string | null; argument: string | null; stance: string | null }>
  > = {};
  const ids = [...embeds.ids];
  for (const id of embeds.decompositions) {
    const tree = await getClaimTree(id, 1).catch(() => null);
    if (!tree) continue;
    decompositions[id] = (tree.children ?? []).map((child) => ({
      id: child.id,
      relation: child.relation_type,
      argument: child.argument_name,
      stance: child.argument_stance,
    }));
    for (const child of decompositions[id]!) if (!ids.includes(child.id)) ids.push(child.id);
  }

  const cards = await getClaimCards(ids.slice(0, CLAIM_CARDS_MAX_IDS));
  const nodes: Record<string, ClaimCard & { saved?: Held }> = {};
  for (const [id, card] of cards) {
    const was = snapshot[id];
    nodes[id] = sameHeld(was, heldOf(card)) ? card : { ...card, saved: was! };
  }
  return {
    ...serializePageSummary(page),
    body: page.body,
    nodes,
    decompositions,
    /** Ids the body names that the graph does not hold. */
    unresolved: embeds.ids.filter((id) => !cards.has(id)),
    versions: ((page.versions ?? []) as Array<{ title: string; saved_at: string }>).map((v) => ({
      title: v.title,
      saved_at: v.saved_at,
    })),
  };
}
