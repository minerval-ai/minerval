/**
 * Feeds a lookout follows (#305; docs/allocation.md, "Feeds").
 *
 * A recurring ingestion pipeline is a lookout with feeds: an author's
 * blog, a publication, a LessWrong user or tag, an arXiv category — any
 * RSS or Atom feed, discovered from whatever URL is to hand. There is no
 * per-platform code here, and no relevance filter: which items matter is
 * the lookout's judgment, in its brief's words.
 *
 * Arrival and waking are separate. Polling is code and costs nothing: new
 * items land in the lookout's inbox (lookout_feed_items, unique per feed,
 * so a re-poll never duplicates). Each feed's WAKE RULE says when the
 * waiting items are worth a funded run (feedWakeDue); when it is met the
 * poller queues one `feed` event on the lookout, never one per item, and
 * the reconcile sweep opens the run like any other. `auto_ingest` is the
 * one rule with no run at all: each new item goes onto the mandate's plan
 * as an ingest, priced against the escrow, up to a daily cap — the
 * Grantmaker's explicit decision to trust that feed.
 *
 * The first poll of a feed records what is already there and queues
 * nothing, so subscribing does not flood the inbox with a back-catalogue.
 * Untriaged items expire after the feed's retention, counted and shown,
 * never silently dropped.
 *
 * Everything a feed carries is DATA, never instructions; every fetch goes
 * through url-guard.ts.
 */
import { XMLParser } from "fast-xml-parser";
import { rawQuery } from "../db/client.js";
import { fetchPublicUrl } from "./url-guard.js";
import { decodeEntities, htmlToText, looksLikeHtml } from "./source-map-service.js";
import { segmentText } from "./source-segment-service.js";
import { flagIngest, queueLookoutEvent } from "./lookout-service.js";
import { normalizeFocus } from "./ingest-focus-service.js";

const USER_AGENT = "Minerval/1.0 (lookout feeds; mailto:hello@minerval.ai)";

export const FEED_WAKE_RULES = ["batch", "each", "heartbeat", "paused", "auto_ingest"] as const;
export type FeedWakeRule = (typeof FEED_WAKE_RULES)[number];
/** The rules a lookout may set on its own feeds; auto_ingest is the Grantmaker's. */
export const LOOKOUT_SETTABLE_WAKE_RULES = ["batch", "each", "heartbeat", "paused"] as const;

export const FEED_STATUSES = ["active", "broken", "removed"] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];

/** Bounds every write clamps to. */
export const FEED_BOUNDS = {
  feedsPerLookout: 50,
  batchSize: { min: 1, max: 500, dflt: 10 },
  maxWaitHours: { min: 1, max: 24 * 30, dflt: 24 },
  minWakeHours: { min: 0, max: 24 * 30, dflt: 4 },
  pollHours: { min: 1, max: 24 * 7, dflt: 6 },
  retainDays: { min: 1, max: 90, dflt: 14 },
  dailyIngestCap: { min: 0, max: 50, dflt: 5 },
  /** Items one poll reads from a feed, newest first. */
  itemsPerPoll: 100,
  /** A feed is marked broken after this many failed polls in a row. */
  failuresBeforeBroken: 8,
  summaryChars: 400,
  contentChars: 200_000,
  bodyChars: 2_000_000,
  /** One page of a full read. */
  pageChars: 12_000,
  leadChars: 2_500,
  linksPerRead: 60,
  listingPage: 100,
} as const;

// ---------------------------------------------------------------------------
// Parsing — pure
// ---------------------------------------------------------------------------

export interface ParsedFeedItem {
  key: string;
  url: string | null;
  title: string | null;
  author: string | null;
  published: Date | null;
  /** The feed's own content for the item, as HTML or text (often the whole post). */
  content: string | null;
  summary: string | null;
}

export interface ParsedFeed {
  format: "rss" | "atom" | "rdf";
  title: string | null;
  siteUrl: string | null;
  items: ParsedFeedItem[];
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** The text of a node that may be a string, a number, or {#text, @_attrs}. */
function textOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    if (t !== undefined) return textOf(t);
    const name = (v as Record<string, unknown>).name;
    if (name !== undefined) return textOf(name);
  }
  return null;
}

function dateOf(v: unknown): Date | null {
  const s = textOf(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** An absolute http(s) URL in the same normal form flagIngest stores, or null. */
export function normalizeUrl(raw: string | null | undefined, base?: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base ?? undefined);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * A fragment (a title, a summary, a link's text) as one line of plain text.
 * htmlToText keeps inline markup in text it does not take for a document,
 * so short fragments are stripped here.
 */
function plain(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(html: string | null): string | null {
  if (!html) return null;
  const text = plain(html);
  if (!text) return null;
  return text.length > FEED_BOUNDS.summaryChars ? `${text.slice(0, FEED_BOUNDS.summaryChars - 1)}…` : text;
}

function itemOf(
  fields: {
    key: string | null;
    link: string | null;
    title: string | null;
    author: string | null;
    published: Date | null;
    content: string | null;
    description: string | null;
  },
  base: string | null
): ParsedFeedItem | null {
  const url = normalizeUrl(fields.link, base);
  const key = (fields.key || url || (fields.title ? `${fields.title}|${fields.published?.toISOString() ?? ""}` : null))
    ?.slice(0, 1000);
  if (!key) return null;
  const content = (fields.content || fields.description || null)?.slice(0, FEED_BOUNDS.contentChars) ?? null;
  return {
    key,
    url,
    title: fields.title ? plain(fields.title).slice(0, 500) || null : null,
    author: fields.author?.slice(0, 200) ?? null,
    published: fields.published,
    content,
    summary: summarize(fields.description || fields.content),
  };
}

function atomLink(links: unknown, base: string | null): string | null {
  const all = arr(links as Record<string, unknown> | Array<Record<string, unknown>>);
  const pick =
    all.find((l) => typeof l === "object" && (l["@_rel"] === undefined || l["@_rel"] === "alternate")) ??
    all[0];
  if (!pick) return null;
  if (typeof pick === "string") return normalizeUrl(pick, base);
  return normalizeUrl(String(pick["@_href"] ?? ""), base);
}

/**
 * Parse an RSS 2.0, RSS 1.0 (RDF), or Atom document. Null when the text is
 * not a feed. `baseUrl` resolves relative links.
 */
export function parseFeed(text: string, baseUrl: string | null = null): ParsedFeed | null {
  const head = text.slice(0, 2000);
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(head)) return null;
  let doc: Record<string, any>;
  try {
    doc = xml.parse(text);
  } catch {
    return null;
  }
  if (doc.rss?.channel) {
    const ch = arr(doc.rss.channel)[0] as Record<string, any>;
    const siteUrl = normalizeUrl(textOf(ch.link), baseUrl);
    const base = siteUrl ?? baseUrl;
    const items = arr(ch.item as Record<string, any>[])
      .map((it) =>
        itemOf(
          {
            key: textOf(it.guid),
            link: textOf(it.link),
            title: textOf(it.title),
            author: textOf(it["dc:creator"]) ?? textOf(it.author),
            published: dateOf(it.pubDate) ?? dateOf(it["dc:date"]),
            content: textOf(it["content:encoded"]),
            description: textOf(it.description),
          },
          base
        )
      )
      .filter((i): i is ParsedFeedItem => i !== null);
    return { format: "rss", title: textOf(ch.title), siteUrl, items };
  }
  if (doc.feed) {
    const f = doc.feed as Record<string, any>;
    const siteUrl = atomLink(f.link, baseUrl);
    const base = siteUrl ?? baseUrl;
    const items = arr(f.entry as Record<string, any>[])
      .map((e) =>
        itemOf(
          {
            key: textOf(e.id),
            link: atomLink(e.link, base),
            title: textOf(e.title),
            author: arr(e.author).map((a) => textOf(a)).filter(Boolean).join(", ") || null,
            published: dateOf(e.published) ?? dateOf(e.updated),
            content: textOf(e.content),
            description: textOf(e.summary),
          },
          base
        )
      )
      .filter((i): i is ParsedFeedItem => i !== null);
    return { format: "atom", title: textOf(f.title), siteUrl, items };
  }
  if (doc["rdf:RDF"]) {
    const r = doc["rdf:RDF"] as Record<string, any>;
    const ch = arr(r.channel)[0] as Record<string, any> | undefined;
    const siteUrl = normalizeUrl(textOf(ch?.link), baseUrl);
    const base = siteUrl ?? baseUrl;
    const items = arr(r.item as Record<string, any>[])
      .map((it) =>
        itemOf(
          {
            key: (it["@_rdf:about"] as string | undefined) ?? textOf(it.link),
            link: textOf(it.link),
            title: textOf(it.title),
            author: textOf(it["dc:creator"]),
            published: dateOf(it["dc:date"]),
            content: textOf(it["content:encoded"]),
            description: textOf(it.description),
          },
          base
        )
      )
      .filter((i): i is ParsedFeedItem => i !== null);
    return { format: "rdf", title: textOf(ch?.title), siteUrl, items };
  }
  return null;
}

/** Feed URLs an HTML page advertises (<link rel="alternate" type="application/rss+xml">). */
export function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const url = normalizeUrl(href?.[1] ?? href?.[2] ?? href?.[3] ?? null, baseUrl);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

export interface PageLink {
  url: string;
  text: string | null;
}

/** The links in an HTML document, absolute, de-duplicated, in order. */
export function extractLinks(html: string, baseUrl: string | null, limit = 500): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const url = normalizeUrl(m[1] ?? m[2] ?? m[3] ?? null, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const text = plain(m[4] ?? "").slice(0, 200) || null;
    out.push({ url, text });
    if (out.length >= limit) break;
  }
  return out;
}

/** The <loc> entries of a sitemap or sitemap index, or null when it is not one. */
export function parseSitemap(text: string): { index: boolean; urls: string[] } | null {
  const head = text.slice(0, 2000);
  const index = /<sitemapindex[\s>]/i.test(head);
  if (!index && !/<urlset[\s>]/i.test(head)) return null;
  const urls: string[] = [];
  for (const m of text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const u = normalizeUrl(m[1]!.replace(/&amp;/g, "&"));
    if (u) urls.push(u);
  }
  return { index, urls };
}

// ---------------------------------------------------------------------------
// Discovery and listings — network
// ---------------------------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  return fetchPublicUrl(url, { userAgent: USER_AGENT });
}

export type ResolveFeedResult =
  | { ok: true; feedUrl: string; feed: ParsedFeed }
  | { ok: false; problem: string };

/**
 * Turn whatever URL is to hand into a feed: the URL itself if it is one;
 * else a feed the page advertises; else `/feed` or `/rss` under the URL or
 * its site. Generic on purpose — Substack, LessWrong, most blogs, arXiv,
 * Medium and Bluesky all answer one of these.
 */
export async function resolveFeed(rawUrl: string): Promise<ResolveFeedResult> {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, problem: "Not an http(s) URL" };
  const tried: string[] = [];
  const attempt = async (candidate: string): Promise<ParsedFeed | null> => {
    if (tried.includes(candidate)) return null;
    tried.push(candidate);
    try {
      return parseFeed(await fetchText(candidate), candidate);
    } catch {
      return null;
    }
  };

  let body: string;
  try {
    body = await fetchText(url);
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  tried.push(url);
  const direct = parseFeed(body, url);
  if (direct) return { ok: true, feedUrl: url, feed: direct };

  const advertised = looksLikeHtml(body) ? discoverFeedLinks(body, url) : [];
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "");
  const guesses = [
    ...advertised,
    ...(path ? [`${u.origin}${path}/feed`, `${u.origin}${path}/rss`] : []),
    `${u.origin}/feed`,
    `${u.origin}/rss`,
    `${u.origin}/feed.xml`,
    `${u.origin}/atom.xml`,
  ];
  for (const g of guesses.slice(0, 8)) {
    const feed = await attempt(g);
    if (feed) return { ok: true, feedUrl: g, feed };
  }
  return {
    ok: false,
    problem:
      `No RSS or Atom feed found at ${url} (it advertises none, and ` +
      `${tried.length - 1} common feed locations did not answer with one). ` +
      `Give the feed URL directly if you know it.`,
  };
}

export interface ListingResult {
  ok: true;
  url: string;
  kind: "feed" | "sitemap" | "sitemap_index" | "page";
  total: number;
  offset: number;
  next_offset: number | null;
  rows: Array<{ url: string; text: string | null; published?: string | null }>;
  /** Feeds the page advertises, for setting up a watch. */
  feeds?: string[];
}

/**
 * The links a listing points to — an archive page, an index, a sitemap, a
 * feed — paged. Discovery only: nothing is ingested, and the listing is
 * data, never instructions.
 */
export async function readListing(
  rawUrl: string,
  offset = 0
): Promise<ListingResult | { ok: false; problem: string }> {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, problem: "Not an http(s) URL" };
  let body: string;
  try {
    body = await fetchText(url);
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const page = <T>(all: T[]) => ({
    total: all.length,
    offset: start,
    next_offset: start + FEED_BOUNDS.listingPage < all.length ? start + FEED_BOUNDS.listingPage : null,
    slice: all.slice(start, start + FEED_BOUNDS.listingPage),
  });

  const feed = parseFeed(body, url);
  if (feed) {
    const p = page(feed.items.filter((i) => i.url));
    return {
      ok: true, url, kind: "feed", total: p.total, offset: p.offset, next_offset: p.next_offset,
      rows: p.slice.map((i) => ({ url: i.url!, text: i.title, published: i.published?.toISOString() ?? null })),
    };
  }
  const sitemap = parseSitemap(body);
  if (sitemap) {
    const p = page(sitemap.urls);
    return {
      ok: true, url, kind: sitemap.index ? "sitemap_index" : "sitemap",
      total: p.total, offset: p.offset, next_offset: p.next_offset,
      rows: p.slice.map((u) => ({ url: u, text: null })),
    };
  }
  const links = extractLinks(body, url, 5000);
  const p = page(links);
  return {
    ok: true, url, kind: "page", total: p.total, offset: p.offset, next_offset: p.next_offset,
    rows: p.slice,
    feeds: looksLikeHtml(body) ? discoverFeedLinks(body, url) : [],
  };
}

// ---------------------------------------------------------------------------
// Feed records
// ---------------------------------------------------------------------------

export interface FeedRow {
  id: string;
  lookout_id: string;
  url: string;
  site_url: string | null;
  title: string | null;
  status: FeedStatus;
  wake: FeedWakeRule;
  batch_size: number;
  max_wait_hours: number;
  min_wake_hours: number;
  poll_hours: number;
  retain_days: number;
  daily_ingest_cap: number;
  /** The focus this feed's ingests carry by default; null = the whole document. */
  ingest_focus: string | null;
  seeded_at: Date | null;
  last_polled_at: Date | null;
  next_poll_at: Date;
  last_woke_at: Date | null;
  consecutive_failures: number;
  last_error: string | null;
  created_by: string | null;
  created_at: Date;
}

const FEED_SELECT = `
  SELECT id, lookout_id, url, site_url, title, status, wake, batch_size,
         max_wait_hours, min_wake_hours, poll_hours, retain_days,
         daily_ingest_cap, ingest_focus, seeded_at, last_polled_at, next_poll_at,
         last_woke_at, consecutive_failures, last_error, created_by, created_at
    FROM lookout_feeds`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function clampInt(v: unknown, b: { min: number; max: number }, dflt: number): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return dflt;
  return Math.min(b.max, Math.max(b.min, Math.round(n)));
}

export interface FeedRuleInput {
  wake?: unknown;
  batchSize?: unknown;
  maxWaitHours?: unknown;
  minWakeHours?: unknown;
  pollHours?: unknown;
  retainDays?: unknown;
  dailyIngestCap?: unknown;
}

type FeedRuleColumns = {
  wake: FeedWakeRule;
  batch_size: number;
  max_wait_hours: number;
  min_wake_hours: number;
  poll_hours: number;
  retain_days: number;
  daily_ingest_cap: number;
};

/** Clamp a rule against the current one (or the defaults); a string is a refusal. */
export function normalizeFeedRule(
  input: FeedRuleInput,
  current: Partial<FeedRuleColumns> = {},
  allowed: readonly string[] = FEED_WAKE_RULES
): FeedRuleColumns | string {
  const wake = input.wake === undefined ? current.wake ?? "batch" : String(input.wake).trim();
  if (!allowed.includes(wake)) return `wake must be one of ${allowed.join(", ")}`;
  const B = FEED_BOUNDS;
  return {
    wake: wake as FeedWakeRule,
    batch_size: clampInt(input.batchSize, B.batchSize, current.batch_size ?? B.batchSize.dflt),
    max_wait_hours: clampInt(input.maxWaitHours, B.maxWaitHours, current.max_wait_hours ?? B.maxWaitHours.dflt),
    min_wake_hours: clampInt(input.minWakeHours, B.minWakeHours, current.min_wake_hours ?? B.minWakeHours.dflt),
    poll_hours: clampInt(input.pollHours, B.pollHours, current.poll_hours ?? B.pollHours.dflt),
    retain_days: clampInt(input.retainDays, B.retainDays, current.retain_days ?? B.retainDays.dflt),
    daily_ingest_cap: clampInt(
      input.dailyIngestCap, B.dailyIngestCap, current.daily_ingest_cap ?? B.dailyIngestCap.dflt
    ),
  };
}

export async function getFeed(feedId: string): Promise<FeedRow | null> {
  if (!isUuid(feedId)) return null;
  const [row] = await rawQuery<FeedRow>(`${FEED_SELECT} WHERE id = $1`, [feedId]);
  return row ?? null;
}

export async function listFeeds(lookoutId: string, opts: { includeRemoved?: boolean } = {}): Promise<FeedRow[]> {
  return rawQuery<FeedRow>(
    `${FEED_SELECT} WHERE lookout_id = $1 AND ($2::boolean OR status <> 'removed')
      ORDER BY created_at ASC`,
    [lookoutId, opts.includeRemoved === true]
  );
}

export type AddFeedResult =
  | {
      ok: true;
      feed_id: string;
      feed_url: string;
      title: string | null;
      wake: FeedWakeRule;
      items_now: number;
      latest: Array<{ title: string | null; url: string | null; published: string | null }>;
      note: string;
    }
  | { ok: false; code: string; problem: string };

/**
 * Follow a feed on a lookout the mandate owns. `url` may be the feed or
 * any page that leads to one (resolveFeed). The feed is polled at once:
 * that first poll records what is already there (status `seen`) and
 * queues nothing. Re-adding a removed feed reactivates it, seeded afresh.
 */
export async function addFeed(input: {
  grantId: string;
  lookoutId: string;
  url: string;
  rule?: FeedRuleInput;
  /** Read this feed's items for one subject (a scoped ingest); omit for whole documents. */
  ingestFocus?: string | null;
  createdBy: string;
}): Promise<AddFeedResult> {
  if (!isUuid(input.lookoutId)) return { ok: false, code: "NOT_FOUND", problem: "No such lookout on this mandate" };
  const [lookout] = await rawQuery<{ id: string; grant_id: string; status: string }>(
    `SELECT id, grant_id, status FROM lookouts WHERE id = $1`,
    [input.lookoutId]
  );
  if (!lookout || lookout.grant_id !== input.grantId) {
    return { ok: false, code: "NOT_FOUND", problem: "No such lookout on this mandate" };
  }
  if (lookout.status === "retired") return { ok: false, code: "RETIRED", problem: "That lookout is retired" };
  const rule = normalizeFeedRule(input.rule ?? {});
  if (typeof rule === "string") return { ok: false, code: "RULE", problem: rule };
  const [count] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM lookout_feeds WHERE lookout_id = $1 AND status <> 'removed'`,
    [input.lookoutId]
  );
  if (Number(count?.n ?? 0) >= FEED_BOUNDS.feedsPerLookout) {
    return {
      ok: false,
      code: "TOO_MANY_FEEDS",
      problem: `A lookout follows at most ${FEED_BOUNDS.feedsPerLookout} feeds; remove one, or post another lookout.`,
    };
  }
  const resolved = await resolveFeed(input.url);
  if (!resolved.ok) return { ok: false, code: "NO_FEED", problem: resolved.problem };

  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO lookout_feeds
       (lookout_id, url, site_url, title, wake, batch_size, max_wait_hours,
        min_wake_hours, poll_hours, retain_days, daily_ingest_cap, created_by, ingest_focus)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (lookout_id, url) DO UPDATE
       SET status = 'active', site_url = EXCLUDED.site_url,
           title = COALESCE(EXCLUDED.title, lookout_feeds.title),
           wake = EXCLUDED.wake, batch_size = EXCLUDED.batch_size,
           max_wait_hours = EXCLUDED.max_wait_hours,
           min_wake_hours = EXCLUDED.min_wake_hours,
           poll_hours = EXCLUDED.poll_hours, retain_days = EXCLUDED.retain_days,
           daily_ingest_cap = EXCLUDED.daily_ingest_cap,
           ingest_focus = EXCLUDED.ingest_focus,
           seeded_at = CASE WHEN lookout_feeds.status = 'removed' THEN NULL ELSE lookout_feeds.seeded_at END,
           consecutive_failures = 0, last_error = NULL, updated_at = now()
     RETURNING id`,
    [
      input.lookoutId,
      resolved.feedUrl,
      resolved.feed.siteUrl,
      resolved.feed.title?.slice(0, 300) ?? null,
      rule.wake,
      rule.batch_size,
      rule.max_wait_hours,
      rule.min_wake_hours,
      rule.poll_hours,
      rule.retain_days,
      rule.daily_ingest_cap,
      input.createdBy,
      normalizeFocus(input.ingestFocus),
    ]
  );
  // A lookout that follows feeds wakes on them; keep its trigger list honest.
  await rawQuery(
    `UPDATE lookouts SET triggers = triggers || '["feed"]'::jsonb, updated_at = now()
      WHERE id = $1 AND NOT (triggers ? 'feed')`,
    [input.lookoutId]
  );
  const feed = await getFeed(row!.id);
  if (feed) await pollFeed(feed, { parsed: resolved.feed });

  return {
    ok: true,
    feed_id: row!.id,
    feed_url: resolved.feedUrl,
    title: resolved.feed.title,
    wake: rule.wake,
    items_now: resolved.feed.items.length,
    latest: resolved.feed.items.slice(0, 5).map((i) => ({
      title: i.title,
      url: i.url,
      published: i.published?.toISOString() ?? null,
    })),
    note:
      `Following. The ${resolved.feed.items.length} item(s) the feed carries now are recorded ` +
      `as already seen; new ones land in the lookout's inbox, and the wake rule ` +
      `(${rule.wake}) decides when they are worth a run. To ingest the back-catalogue, ` +
      `read it with read_listing and plan what matters.`,
  };
}

export type UpdateFeedResult = { ok: true; feed_id: string } | { ok: false; code: string; problem: string };

/**
 * Change a feed's rule or status. `by: 'grantmaker'` may set any rule
 * (auto_ingest included) and remove or reactivate the feed; `by: 'lookout'`
 * may set its own feed's wake rule and cadence either way, except to or
 * from auto_ingest, which is the Grantmaker's decision.
 */
export async function updateFeed(input: {
  lookoutId: string;
  feedId: string;
  by: "grantmaker" | "lookout";
  rule?: FeedRuleInput;
  status?: string;
  /** Grantmaker only: the feed's default ingest focus; "" or null clears it. */
  ingestFocus?: string | null;
}): Promise<UpdateFeedResult> {
  const feed = await getFeed(input.feedId);
  if (!feed || feed.lookout_id !== input.lookoutId) {
    return { ok: false, code: "NOT_FOUND", problem: "No such feed on this lookout" };
  }
  const allowed = input.by === "grantmaker" ? FEED_WAKE_RULES : LOOKOUT_SETTABLE_WAKE_RULES;
  if (input.by === "lookout" && feed.wake === "auto_ingest") {
    return {
      ok: false,
      code: "AUTO_INGEST",
      problem: "Your Grantmaker set this feed to auto_ingest; leave a note if it should change.",
    };
  }
  const rule = normalizeFeedRule(input.rule ?? {}, feed, allowed);
  if (typeof rule === "string") return { ok: false, code: "RULE", problem: rule };
  let status: FeedStatus = feed.status;
  if (input.status !== undefined) {
    if (input.by !== "grantmaker") return { ok: false, code: "STATUS", problem: "Only the Grantmaker removes feeds" };
    if (input.status !== "active" && input.status !== "removed") {
      return { ok: false, code: "STATUS", problem: "status must be active or removed" };
    }
    status = input.status;
  }
  if (input.ingestFocus !== undefined && input.by !== "grantmaker") {
    return {
      ok: false,
      code: "FOCUS",
      problem: "The feed's default focus is your Grantmaker's; give a focus per item when you triage instead.",
    };
  }
  const ingestFocus = input.ingestFocus === undefined ? feed.ingest_focus : normalizeFocus(input.ingestFocus);
  const reactivated = status === "active" && feed.status !== "active";
  await rawQuery(
    `UPDATE lookout_feeds
        SET wake = $2, batch_size = $3, max_wait_hours = $4, min_wake_hours = $5,
            poll_hours = $6, retain_days = $7, daily_ingest_cap = $8, status = $9,
            consecutive_failures = CASE WHEN $10 THEN 0 ELSE consecutive_failures END,
            next_poll_at = CASE WHEN $10 THEN now() ELSE next_poll_at END,
            seeded_at = CASE WHEN $10 AND status = 'removed' THEN NULL ELSE seeded_at END,
            ingest_focus = $11,
            updated_at = now()
      WHERE id = $1`,
    [
      feed.id, rule.wake, rule.batch_size, rule.max_wait_hours, rule.min_wake_hours,
      rule.poll_hours, rule.retain_days, rule.daily_ingest_cap, status, reactivated,
      ingestFocus,
    ]
  );
  return { ok: true, feed_id: feed.id };
}

// ---------------------------------------------------------------------------
// Waking — pure
// ---------------------------------------------------------------------------

/**
 * Whether a feed's waiting items are worth waking its lookout for, now.
 * `fresh` counts items that arrived since the last wake: an item the
 * lookout has already been woken for and left untriaged waits for the next
 * run without waking it again.
 */
export function feedWakeDue(
  feed: Pick<FeedRow, "wake" | "batch_size" | "max_wait_hours" | "min_wake_hours" | "last_woke_at">,
  waiting: { fresh: number; oldestFreshAt: Date | null },
  now: number
): boolean {
  if (waiting.fresh <= 0) return false;
  if (feed.wake !== "batch" && feed.wake !== "each") return false;
  if (feed.last_woke_at && now - new Date(feed.last_woke_at).getTime() < feed.min_wake_hours * 3_600_000) {
    return false;
  }
  if (feed.wake === "each") return true;
  if (waiting.fresh >= feed.batch_size) return true;
  return (
    waiting.oldestFreshAt !== null &&
    now - new Date(waiting.oldestFreshAt).getTime() >= feed.max_wait_hours * 3_600_000
  );
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface FeedPollResult {
  feedId: string;
  ok: boolean;
  seeded: boolean;
  newItems: number;
  autoIngested: number;
  woke: boolean;
  error?: string;
}

/**
 * Poll one feed: record new items, run auto_ingest if that is the rule,
 * and queue a `feed` event on the lookout when the wake rule is met.
 * Idempotent: items are unique per feed, and a lookout holding an
 * unconsumed event for this feed is not handed another.
 */
export async function pollFeed(
  feed: FeedRow,
  opts: { now?: Date; parsed?: ParsedFeed } = {}
): Promise<FeedPollResult> {
  const now = opts.now ?? new Date();
  const result: FeedPollResult = {
    feedId: feed.id, ok: false, seeded: false, newItems: 0, autoIngested: 0, woke: false,
  };
  let parsed = opts.parsed ?? null;
  if (!parsed) {
    try {
      parsed = parseFeed(await fetchText(feed.url), feed.url);
      if (!parsed) throw new Error("The URL no longer answers with an RSS or Atom feed");
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      result.error = msg;
      // Back off exponentially (capped at a week); mark broken after a run of failures.
      await rawQuery(
        `UPDATE lookout_feeds
            SET consecutive_failures = consecutive_failures + 1,
                last_error = $2, last_polled_at = $3,
                next_poll_at = $3::timestamptz + LEAST(
                  make_interval(hours => poll_hours * (2 ^ LEAST(consecutive_failures + 1, 8))::int),
                  interval '7 days'),
                status = CASE WHEN consecutive_failures + 1 >= $4 THEN 'broken' ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [feed.id, msg, now, FEED_BOUNDS.failuresBeforeBroken]
      );
      return result;
    }
  }

  const seeding = feed.seeded_at === null;
  result.seeded = seeding;
  const items = [...parsed.items]
    .sort((a, b) => (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0))
    .slice(0, FEED_BOUNDS.itemsPerPoll);
  for (const it of items) {
    const rows = await rawQuery<{ id: string }>(
      `INSERT INTO lookout_feed_items
         (feed_id, lookout_id, item_key, url, title, author, published_at,
          summary, content, status, first_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               CASE WHEN $10 = 'new' THEN $11::timestamptz + make_interval(days => $12) END)
       ON CONFLICT (feed_id, item_key) DO NOTHING
       RETURNING id`,
      [
        feed.id, feed.lookout_id, it.key, it.url, it.title, it.author, it.published,
        it.summary, it.content, seeding ? "seen" : "new", now, feed.retain_days,
      ]
    );
    if (rows.length > 0 && !seeding) result.newItems++;
  }
  await rawQuery(
    `UPDATE lookout_feeds
        SET seeded_at = COALESCE(seeded_at, $2), last_polled_at = $2,
            next_poll_at = $2::timestamptz + make_interval(hours => poll_hours),
            title = COALESCE(title, $3), site_url = COALESCE(site_url, $4),
            consecutive_failures = 0, last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [feed.id, now, parsed.title?.slice(0, 300) ?? null, parsed.siteUrl]
  );
  await expireItems({ feedId: feed.id, now });

  if (feed.wake === "auto_ingest") {
    result.autoIngested = await autoIngest(feed, now);
  } else {
    result.woke = await maybeWake(feed, now);
  }
  result.ok = true;
  return result;
}

/** Untriaged items past their retention become `expired`: counted, not hidden. */
export async function expireItems(opts: { feedId?: string; now?: Date } = {}): Promise<number> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE lookout_feed_items
        SET status = 'expired', triaged_by = 'expiry', triaged_at = $2
      WHERE status IN ('new', 'deferred') AND expires_at <= $2
        AND ($1::uuid IS NULL OR feed_id = $1)
      RETURNING id`,
    [opts.feedId ?? null, opts.now ?? new Date()]
  );
  return rows.length;
}

async function maybeWake(feed: FeedRow, now: Date): Promise<boolean> {
  const [w] = await rawQuery<{ fresh: number; oldest: Date | null; waiting: number }>(
    `SELECT COUNT(*) FILTER (WHERE first_seen_at > COALESCE($2::timestamptz, '-infinity'))::int AS fresh,
            MIN(first_seen_at) FILTER (WHERE first_seen_at > COALESCE($2::timestamptz, '-infinity')) AS oldest,
            COUNT(*)::int AS waiting
       FROM lookout_feed_items
      WHERE feed_id = $1 AND status = 'new'`,
    [feed.id, feed.last_woke_at]
  );
  const fresh = Number(w?.fresh ?? 0);
  if (!feedWakeDue(feed, { fresh, oldestFreshAt: w?.oldest ?? null }, now.getTime())) return false;
  const [held] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM lookout_events
      WHERE lookout_id = $1 AND kind = 'feed' AND consumed_at IS NULL
        AND payload->>'feed_id' = $2`,
    [feed.lookout_id, feed.id]
  );
  if (Number(held?.n ?? 0) > 0) return false;
  const { queued } = await queueLookoutEvent({
    lookoutId: feed.lookout_id,
    kind: "feed",
    payload: {
      feed_id: feed.id,
      feed_title: feed.title,
      feed_url: feed.url,
      new_items: fresh,
      waiting: Number(w?.waiting ?? 0),
      note: "New items are waiting in your inbox for this feed; feed_inbox lists them.",
    },
  });
  if (queued) {
    await rawQuery(`UPDATE lookout_feeds SET last_woke_at = $2 WHERE id = $1`, [feed.id, now]);
  }
  return queued;
}

async function autoIngest(feed: FeedRow, now: Date): Promise<number> {
  const [lookout] = await rawQuery<{ grant_id: string; status: string }>(
    `SELECT grant_id, status FROM lookouts WHERE id = $1`,
    [feed.lookout_id]
  );
  if (!lookout || lookout.status !== "active") return 0;
  const [today] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM lookout_feed_items
      WHERE feed_id = $1 AND status = 'ingested' AND triaged_by = 'auto'
        AND triaged_at > $2::timestamptz - interval '1 day'`,
    [feed.id, now]
  );
  const room = feed.daily_ingest_cap - Number(today?.n ?? 0);
  if (room <= 0) return 0;
  const waiting = await rawQuery<{ id: string; url: string | null; title: string | null }>(
    `SELECT id, url, title FROM lookout_feed_items
      WHERE feed_id = $1 AND status = 'new'
      ORDER BY first_seen_at ASC, published_at ASC NULLS LAST LIMIT $2`,
    [feed.id, room]
  );
  let ingested = 0;
  for (const item of waiting) {
    if (!item.url) {
      await markItem(item.id, "skipped", "auto", "The feed item carries no link", now);
      continue;
    }
    const res = await flagIngest({
      lookoutId: feed.lookout_id,
      grantId: lookout.grant_id,
      url: item.url,
      rationale: `[feed auto_ingest] "${feed.title ?? feed.url}": ${item.title ?? item.url}`,
      focus: feed.ingest_focus,
    });
    if (res.ok && !res.duplicate) {
      await markItem(item.id, "ingested", "auto", null, now);
      ingested++;
    } else {
      await markItem(item.id, "skipped", "auto", res.ok ? res.note : res.problem, now);
    }
  }
  return ingested;
}

async function markItem(
  itemId: string,
  status: "ingested" | "skipped" | "deferred",
  by: "lookout" | "auto",
  reason: string | null,
  now = new Date()
): Promise<void> {
  await rawQuery(
    `UPDATE lookout_feed_items
        SET status = $2, triaged_by = $3, triaged_at = $4, reason = $5
      WHERE id = $1`,
    [itemId, status, by, now, reason?.slice(0, 2000) ?? null]
  );
}

// ---------------------------------------------------------------------------
// The lookout's inbox
// ---------------------------------------------------------------------------

export interface InboxRow {
  item_id: string;
  feed_id: string;
  feed: string | null;
  title: string | null;
  author: string | null;
  published: string | null;
  url: string | null;
  summary: string | null;
  status: string;
  first_seen: string;
}

const INBOX_STATUSES = ["new", "deferred", "seen", "ingested", "skipped", "expired"];

export async function feedInbox(input: {
  lookoutId: string;
  feedId?: string | null;
  statuses?: string[];
  order?: "newest" | "oldest";
  limit?: number;
  offset?: number;
}): Promise<{ total: number; offset: number; next_offset: number | null; rows: InboxRow[] }> {
  const statuses = (input.statuses?.length ? input.statuses : ["new", "deferred"]).filter((s) =>
    INBOX_STATUSES.includes(s)
  );
  const limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit ?? 30)) || 30));
  const offset = Math.max(0, Math.floor(Number(input.offset ?? 0)) || 0);
  const feedId = isUuid(input.feedId) ? input.feedId : null;
  const dir = input.order === "oldest" ? "ASC" : "DESC";
  const [count] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM lookout_feed_items
      WHERE lookout_id = $1 AND status = ANY($2::text[]) AND ($3::uuid IS NULL OR feed_id = $3)`,
    [input.lookoutId, statuses, feedId]
  );
  const rows = await rawQuery<{
    id: string; feed_id: string; feed: string | null; title: string | null; author: string | null;
    published_at: Date | null; url: string | null; summary: string | null; status: string; first_seen_at: Date;
  }>(
    `SELECT i.id, i.feed_id, f.title AS feed, i.title, i.author, i.published_at, i.url,
            i.summary, i.status, i.first_seen_at
       FROM lookout_feed_items i JOIN lookout_feeds f ON f.id = i.feed_id
      WHERE i.lookout_id = $1 AND i.status = ANY($2::text[]) AND ($3::uuid IS NULL OR i.feed_id = $3)
      ORDER BY COALESCE(i.published_at, i.first_seen_at) ${dir}, i.id
      LIMIT $4 OFFSET $5`,
    [input.lookoutId, statuses, feedId, limit, offset]
  );
  const total = Number(count?.n ?? 0);
  return {
    total,
    offset,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    rows: rows.map((r) => ({
      item_id: r.id,
      feed_id: r.feed_id,
      feed: r.feed,
      title: r.title,
      author: r.author,
      published: r.published_at ? new Date(r.published_at).toISOString().slice(0, 16) : null,
      url: r.url,
      summary: r.summary,
      status: r.status,
      first_seen: new Date(r.first_seen_at).toISOString().slice(0, 16),
    })),
  };
}

export const READ_VIEWS = ["lead", "outline", "section", "full"] as const;
export type ReadView = (typeof READ_VIEWS)[number];

export type ReadItemResult =
  | {
      ok: true;
      item_id: string;
      url: string | null;
      title: string | null;
      author: string | null;
      published: string | null;
      /** Where the text came from: the feed's own copy, or the fetched page. */
      from: "feed" | "page";
      view: ReadView;
      chars_total: number;
      text?: string;
      headings?: string[];
      sections?: Array<{ n: number; label: string | null; chars: number }>;
      section?: { n: number; label: string | null };
      page?: number;
      pages?: number;
      links?: PageLink[];
      in_graph: { source_id: string; title: string; claims: number } | null;
      /** Characters of document text this call returned. */
      chars_returned: number;
    }
  | { ok: false; problem: string };

/** Feed content this long is taken to be the whole item, not a teaser. */
const FULL_CONTENT_CHARS = 1_500;

/**
 * Read an inbox item at whatever depth the reader wants: its lead (opening
 * text, headings, outbound links), its outline (sections, by the
 * deterministic segmenter), one section, or the whole of it in pages.
 * Text comes from the feed's own copy when that is the whole item, else
 * from the page, fetched once and cached on the item so an ingest of the
 * same URL reuses it. `from` forces one or the other.
 */
export async function readItem(input: {
  lookoutId: string;
  itemId: string;
  view?: string;
  section?: number;
  page?: number;
  from?: "feed" | "page";
}): Promise<ReadItemResult> {
  if (!isUuid(input.itemId)) return { ok: false, problem: "item_id must be an id from feed_inbox" };
  const [item] = await rawQuery<{
    id: string; lookout_id: string; url: string | null; title: string | null; author: string | null;
    published_at: Date | null; content: string | null; body: string | null;
  }>(
    `SELECT id, lookout_id, url, title, author, published_at, content, body
       FROM lookout_feed_items WHERE id = $1`,
    [input.itemId]
  );
  if (!item || item.lookout_id !== input.lookoutId) return { ok: false, problem: "No such item in your inbox" };
  const view = (READ_VIEWS as readonly string[]).includes(String(input.view)) ? (input.view as ReadView) : "lead";

  const feedText = item.content ? htmlToText(item.content) : "";
  const feedIsWhole = feedText.length >= FULL_CONTENT_CHARS;
  let html: string | null = null;
  let from: "feed" | "page";
  if (input.from !== "page" && (feedIsWhole || input.from === "feed") && item.content) {
    html = item.content;
    from = "feed";
  } else {
    html = item.body;
    from = "page";
    if (!html && item.url) {
      try {
        html = (await fetchText(item.url)).slice(0, FEED_BOUNDS.bodyChars);
        await rawQuery(`UPDATE lookout_feed_items SET body = $2, fetched_at = now() WHERE id = $1`, [
          item.id, html,
        ]);
      } catch (err) {
        if (!item.content) {
          return { ok: false, problem: `Could not fetch the page: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    }
    if (!html && item.content) {
      html = item.content;
      from = "feed";
    }
  }
  if (!html) return { ok: false, problem: "The item has neither content in the feed nor a link to read" };

  const text = htmlToText(html);
  const segments = segmentText(text);
  const sections = segments
    .filter((s) => s.kind === "section")
    .map((s, n) => ({ n, label: s.label, start: s.start, end: s.end }));
  const [src] = item.url
    ? await rawQuery<{ id: string; title: string; claims: number }>(
        `SELECT s.id, s.title,
                (SELECT COUNT(DISTINCT ci.claim_id)::int FROM claim_instances ci WHERE ci.source_id = s.id) AS claims
           FROM sources s WHERE s.url = $1`,
        [item.url]
      )
    : [];

  const base = {
    ok: true as const,
    item_id: item.id,
    url: item.url,
    title: item.title,
    author: item.author,
    published: item.published_at ? new Date(item.published_at).toISOString().slice(0, 10) : null,
    from,
    view,
    chars_total: text.length,
    in_graph: src ? { source_id: src.id, title: src.title, claims: Number(src.claims) } : null,
  };
  const links = () =>
    looksLikeHtml(html!) || /<a\b/i.test(html!) ? extractLinks(html!, item.url, FEED_BOUNDS.linksPerRead) : [];

  if (view === "lead") {
    const lead = text.slice(0, FEED_BOUNDS.leadChars);
    return {
      ...base,
      text: lead + (text.length > lead.length ? "\n[…]" : ""),
      headings: sections.map((s) => s.label ?? "").filter(Boolean).slice(0, 40),
      links: links(),
      chars_returned: lead.length,
    };
  }
  if (view === "outline") {
    return {
      ...base,
      sections: sections.map((s) => ({ n: s.n, label: s.label, chars: s.end - s.start })),
      links: links(),
      chars_returned: 0,
    };
  }
  if (view === "section") {
    const n = Math.floor(Number(input.section ?? 0));
    const s = sections[n];
    if (!s) return { ok: false, problem: `No section ${n}; the outline lists ${sections.length}` };
    // A section runs from its heading to the next section at any level, or the end.
    const next = sections[n + 1];
    const body = text.slice(s.start, next ? next.start : text.length);
    const chunk = body.slice(0, FEED_BOUNDS.pageChars * 2);
    return {
      ...base,
      section: { n, label: s.label },
      text: chunk + (body.length > chunk.length ? "\n[section continues; read it with view=full]" : ""),
      chars_returned: chunk.length,
    };
  }
  const pages = Math.max(1, Math.ceil(text.length / FEED_BOUNDS.pageChars));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(input.page ?? 1)) || 1));
  const chunk = text.slice((page - 1) * FEED_BOUNDS.pageChars, page * FEED_BOUNDS.pageChars);
  return {
    ...base,
    page,
    pages,
    text: chunk,
    ...(page === 1 ? { links: links() } : {}),
    chars_returned: chunk.length,
  };
}

export const TRIAGE_DECISIONS = ["ingest", "skip", "defer"] as const;
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number];

export interface TriageOutcome {
  item_id: string;
  decision: string;
  ok: boolean;
  status?: string;
  note?: string;
}

/**
 * Record the lookout's decisions on inbox items. `ingest` goes through
 * flagIngest (priced against the escrow, refused for a URL already in the
 * graph or on the plan) and is bounded by `ingestAllowance`, the run's
 * remaining ingests, and carries a focus: the decision's own, else the
 * feed's default (an empty focus asks for the whole document); `skip` and
 * `defer` record the judgment. `skipRest`
 * skips every item still waiting from one feed (optionally only those that
 * arrived before a time) in one call.
 */
export async function triageItems(input: {
  lookoutId: string;
  grantId: string;
  decisions?: Array<{ item_id?: unknown; decision?: unknown; reason?: unknown; focus?: unknown }>;
  skipRest?: { feedId: string; before?: string | null; reason?: string | null } | null;
  ingestAllowance: number;
}): Promise<{ outcomes: TriageOutcome[]; ingested: number; skipped_in_bulk: number }> {
  const outcomes: TriageOutcome[] = [];
  let ingested = 0;
  for (const d of (input.decisions ?? []).slice(0, 200)) {
    const itemId = String(d.item_id ?? "");
    const decision = String(d.decision ?? "");
    const reason = typeof d.reason === "string" ? d.reason.trim().slice(0, 2000) : null;
    if (!(TRIAGE_DECISIONS as readonly string[]).includes(decision)) {
      outcomes.push({ item_id: itemId, decision, ok: false, note: "decision must be ingest, skip, or defer" });
      continue;
    }
    const [item] = isUuid(itemId)
      ? await rawQuery<{
          id: string; lookout_id: string; url: string | null; title: string | null; status: string;
          feed: string | null; ingest_focus: string | null;
        }>(
          `SELECT i.id, i.lookout_id, i.url, i.title, i.status, f.title AS feed, f.ingest_focus
             FROM lookout_feed_items i JOIN lookout_feeds f ON f.id = i.feed_id
            WHERE i.id = $1`,
          [itemId]
        )
      : [];
    if (!item || item.lookout_id !== input.lookoutId) {
      outcomes.push({ item_id: itemId, decision, ok: false, note: "No such item in your inbox" });
      continue;
    }
    if (item.status === "ingested") {
      outcomes.push({ item_id: itemId, decision, ok: false, status: item.status, note: "Already ingested" });
      continue;
    }
    if (decision === "ingest") {
      if (ingested >= input.ingestAllowance) {
        outcomes.push({
          item_id: itemId, decision, ok: false, status: item.status,
          note: "No ingests left this run (your per-run limit). Defer it, or leave a note.",
        });
        continue;
      }
      if (!item.url) {
        outcomes.push({ item_id: itemId, decision, ok: false, status: item.status, note: "The item carries no link" });
        continue;
      }
      const res = await flagIngest({
        lookoutId: input.lookoutId,
        grantId: input.grantId,
        url: item.url,
        rationale: reason && reason.length >= 10 ? reason : `From the feed "${item.feed ?? ""}": ${item.title ?? item.url}`,
        focus: typeof d.focus === "string" ? normalizeFocus(d.focus) : item.ingest_focus,
      });
      if (res.ok && !res.duplicate) {
        await markItem(item.id, "ingested", "lookout", reason);
        ingested++;
        outcomes.push({ item_id: itemId, decision, ok: true, status: "ingested", note: res.note });
      } else if (!res.ok && res.code === "URL") {
        outcomes.push({ item_id: itemId, decision, ok: false, status: item.status, note: res.problem });
      } else {
        // Already in the graph or on the plan: nothing to ingest, so the item is done.
        const note = res.ok ? res.note : res.problem;
        await markItem(item.id, "skipped", "lookout", note);
        outcomes.push({ item_id: itemId, decision, ok: false, status: "skipped", note });
      }
      continue;
    }
    const status = decision === "skip" ? "skipped" : "deferred";
    await markItem(item.id, status, "lookout", reason);
    outcomes.push({ item_id: itemId, decision, ok: true, status });
  }

  let skippedInBulk = 0;
  if (input.skipRest && isUuid(input.skipRest.feedId)) {
    const before = input.skipRest.before ? new Date(input.skipRest.before) : null;
    const rows = await rawQuery<{ id: string }>(
      `UPDATE lookout_feed_items
          SET status = 'skipped', triaged_by = 'lookout', triaged_at = now(), reason = $4
        WHERE lookout_id = $1 AND feed_id = $2 AND status IN ('new', 'deferred')
          AND ($3::timestamptz IS NULL OR first_seen_at < $3)
        RETURNING id`,
      [
        input.lookoutId,
        input.skipRest.feedId,
        before && Number.isFinite(before.getTime()) ? before : null,
        input.skipRest.reason?.slice(0, 2000) ?? null,
      ]
    );
    skippedInBulk = rows.length;
  }
  return { outcomes, ingested, skipped_in_bulk: skippedInBulk };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface FeedReportRow {
  feed_id: string;
  title: string | null;
  url: string;
  status: FeedStatus;
  wake: FeedWakeRule;
  rule: Omit<FeedRuleColumns, "wake">;
  ingest_focus: string | null;
  last_polled_at: string | null;
  next_poll_at: string | null;
  last_woke_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  items: {
    seen_at_subscribe: number; new: number; deferred: number; ingested: number;
    auto_ingested: number; skipped: number; expired: number;
  };
  /** What this feed's ingests produced in the graph. */
  yield: { sources_in_graph: number; claims: number };
}

/**
 * Per feed: how its items fared and what its ingests produced — the
 * Grantmaker's evidence for keeping, retuning, or cutting a feed.
 */
export async function feedReport(lookoutId: string): Promise<FeedReportRow[]> {
  const feeds = await listFeeds(lookoutId, { includeRemoved: true });
  if (feeds.length === 0) return [];
  const counts = await rawQuery<{
    feed_id: string; seen: number; new: number; deferred: number; ingested: number;
    auto: number; skipped: number; expired: number;
  }>(
    `SELECT feed_id,
            COUNT(*) FILTER (WHERE status = 'seen')::int AS seen,
            COUNT(*) FILTER (WHERE status = 'new')::int AS new,
            COUNT(*) FILTER (WHERE status = 'deferred')::int AS deferred,
            COUNT(*) FILTER (WHERE status = 'ingested')::int AS ingested,
            COUNT(*) FILTER (WHERE status = 'ingested' AND triaged_by = 'auto')::int AS auto,
            COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            COUNT(*) FILTER (WHERE status = 'expired')::int AS expired
       FROM lookout_feed_items WHERE lookout_id = $1 GROUP BY feed_id`,
    [lookoutId]
  );
  const yields = await rawQuery<{ feed_id: string; sources: number; claims: number }>(
    `SELECT i.feed_id, COUNT(DISTINCT s.id)::int AS sources, COUNT(DISTINCT ci.claim_id)::int AS claims
       FROM lookout_feed_items i
       JOIN sources s ON s.url = i.url
       LEFT JOIN claim_instances ci ON ci.source_id = s.id
      WHERE i.lookout_id = $1 AND i.status = 'ingested'
      GROUP BY i.feed_id`,
    [lookoutId]
  );
  const iso = (d: Date | null) => (d && Number.isFinite(new Date(d).getTime()) ? new Date(d).toISOString() : null);
  return feeds.map((f) => {
    const c = counts.find((r) => r.feed_id === f.id);
    const y = yields.find((r) => r.feed_id === f.id);
    return {
      feed_id: f.id,
      title: f.title,
      url: f.url,
      status: f.status,
      wake: f.wake,
      rule: {
        batch_size: f.batch_size, max_wait_hours: f.max_wait_hours, min_wake_hours: f.min_wake_hours,
        poll_hours: f.poll_hours, retain_days: f.retain_days, daily_ingest_cap: f.daily_ingest_cap,
      },
      ingest_focus: f.ingest_focus,
      last_polled_at: iso(f.last_polled_at),
      next_poll_at: iso(f.next_poll_at),
      last_woke_at: iso(f.last_woke_at),
      consecutive_failures: f.consecutive_failures,
      last_error: f.last_error,
      items: {
        seen_at_subscribe: Number(c?.seen ?? 0),
        new: Number(c?.new ?? 0),
        deferred: Number(c?.deferred ?? 0),
        ingested: Number(c?.ingested ?? 0),
        auto_ingested: Number(c?.auto ?? 0),
        skipped: Number(c?.skipped ?? 0),
        expired: Number(c?.expired ?? 0),
      },
      yield: { sources_in_graph: Number(y?.sources ?? 0), claims: Number(y?.claims ?? 0) },
    };
  });
}

/**
 * The page a lookout already fetched for an item at this URL, if any, so
 * an ingest of it extracts from what was read rather than downloading it
 * again.
 */
export async function cachedItemBody(url: string): Promise<{ body: string; title: string | null } | null> {
  const [row] = await rawQuery<{ body: string; title: string | null }>(
    `SELECT body, title FROM lookout_feed_items
      WHERE url = $1 AND body IS NOT NULL
      ORDER BY fetched_at DESC NULLS LAST LIMIT 1`,
    [url]
  );
  return row ?? null;
}
