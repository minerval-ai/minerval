/**
 * Feeds on lookouts (#305) over real SQL, with the network faked: the
 * first poll records what a feed already carries and queues nothing; new
 * items land once each however often the feed is polled; a wake rule
 * queues one `feed` event, not one per item, and not again while that one
 * waits; the inbox lists and triages items, ingests go onto the mandate's
 * plan within the run's allowance; auto_ingest stops at its daily cap;
 * untriaged items expire; a failing feed backs off and breaks; a page the
 * lookout read is cached for the ingest.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedGrantWithJob, seedUser } from "./helpers.js";

const net = vi.hoisted(() => ({ pages: new Map<string, string>(), fetched: [] as string[] }));

vi.mock("../../src/services/url-guard.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/services/url-guard.js")>();
  return {
    ...real,
    assertPublicHttpUrl: async (raw: string) => new URL(raw),
    fetchPublicUrl: async (url: string) => {
      net.fetched.push(url);
      const body = net.pages.get(url);
      if (body === undefined) throw new Error(`Failed to fetch ${url}: 404`);
      return body;
    },
  };
});

import {
  addFeed,
  cachedItemBody,
  expireItems,
  feedInbox,
  feedReport,
  getFeed,
  pollFeed,
  readItem,
  triageItems,
  updateFeed,
} from "../../src/services/feed-service.js";
import { feedPollTick } from "../../src/workers/lookout-triggers.js";

function rss(site: string, items: Array<{ id: string; title?: string; content?: string }>): string {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <title>Feed at ${site}</title><link>${site}</link>
    ${items
      .map(
        (i) => `<item><title>${i.title ?? `Post ${i.id}`}</title><link>${site}/p/${i.id}</link><guid>${site}/p/${i.id}</guid>
          <description>About ${i.id}</description>${i.content ? `<content:encoded><![CDATA[${i.content}]]></content:encoded>` : ""}</item>`
      )
      .join("")}
  </channel></rss>`;
}

async function seedLookout(): Promise<{ grantId: string; lookoutId: string; site: string }> {
  const funder = await seedUser("feeds");
  const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10_000_000 });
  const [l] = await rawQuery<{ id: string }>(
    `INSERT INTO lookouts (grant_id, title, brief, heartbeat_hours, triggers)
     VALUES ($1, 'Feed watch', $2, 24, '["manual"]'::jsonb) RETURNING id`,
    [grantId, "Watch this author's posts and ingest anything substantive."]
  );
  const site = `https://blog-${randomUUID().slice(0, 8)}.example`;
  return { grantId, lookoutId: l!.id, site };
}

const feedEvents = (lookoutId: string) =>
  rawQuery<{ id: string; payload: Record<string, unknown> }>(
    `SELECT id, payload FROM lookout_events WHERE lookout_id = $1 AND kind = 'feed' AND consumed_at IS NULL`,
    [lookoutId]
  );

const planUrls = async (grantId: string) => {
  const [g] = await rawQuery<{ plan: { items?: Array<{ url: string }> } | null }>(
    `SELECT plan FROM grants WHERE id = $1`,
    [grantId]
  );
  return (g?.plan?.items ?? []).map((i) => i.url);
};

beforeEach(() => {
  net.pages.clear();
  net.fetched.length = 0;
});

describe("following a feed", () => {
  it("discovers the feed from a page, records its current items as seen, and queues nothing", async () => {
    const { grantId, lookoutId, site } = await seedLookout();
    net.pages.set(`${site}/`, `<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body>hi</body></html>`);
    net.pages.set(`${site}/feed`, rss(site, [{ id: "a" }, { id: "b" }]));

    const res = await addFeed({ grantId, lookoutId, url: `${site}/`, createdBy: "grantmaker:chat" });
    expect(res).toMatchObject({ ok: true, feed_url: `${site}/feed`, items_now: 2 });

    const items = await rawQuery<{ status: string; expires_at: Date | null }>(
      `SELECT status, expires_at FROM lookout_feed_items WHERE lookout_id = $1`,
      [lookoutId]
    );
    expect(items.map((i) => i.status)).toEqual(["seen", "seen"]);
    expect(items.every((i) => i.expires_at === null)).toBe(true);
    expect(await feedEvents(lookoutId)).toHaveLength(0);
    const [l] = await rawQuery<{ triggers: string[] }>(`SELECT triggers FROM lookouts WHERE id = $1`, [lookoutId]);
    expect(l!.triggers).toEqual(["manual", "feed"]);

    // A page on a site with no feed anywhere is refused with a reason; one
    // on this site falls back to the site's own /feed.
    net.pages.set("https://nofeed.example/about", "<html><body>nothing</body></html>");
    const none = await addFeed({ grantId, lookoutId, url: "https://nofeed.example/about", createdBy: "x" });
    expect(none).toMatchObject({ ok: false, code: "NO_FEED" });
    net.pages.set(`${site}/about`, "<html><body>no link tag</body></html>");
    const fallback = await addFeed({ grantId, lookoutId, url: `${site}/about`, createdBy: "x" });
    expect(fallback).toMatchObject({ ok: true, feed_url: `${site}/feed` });
    const [{ n }] = (await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM lookout_feeds WHERE lookout_id = $1`,
      [lookoutId]
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it("refuses a lookout of another mandate", async () => {
    const a = await seedLookout();
    const b = await seedLookout();
    net.pages.set(`${a.site}/feed`, rss(a.site, []));
    const res = await addFeed({ grantId: b.grantId, lookoutId: a.lookoutId, url: `${a.site}/feed`, createdBy: "x" });
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("polling and waking", () => {
  it("lands each new item once, and wakes once per batch, not again while the event waits", async () => {
    const { grantId, lookoutId, site } = await seedLookout();
    net.pages.set(`${site}/feed`, rss(site, [{ id: "old" }]));
    const added = await addFeed({
      grantId, lookoutId, url: `${site}/feed`, createdBy: "x",
      rule: { wake: "batch", batchSize: 2, minWakeHours: 0 },
    });
    if (!added.ok) throw new Error(added.problem);

    net.pages.set(`${site}/feed`, rss(site, [{ id: "old" }, { id: "n1" }]));
    let r = await pollFeed((await getFeed(added.feed_id))!);
    expect(r).toMatchObject({ ok: true, newItems: 1, woke: false });
    r = await pollFeed((await getFeed(added.feed_id))!);
    expect(r).toMatchObject({ ok: true, newItems: 0, woke: false });

    net.pages.set(`${site}/feed`, rss(site, [{ id: "old" }, { id: "n1" }, { id: "n2" }, { id: "n3" }]));
    r = await pollFeed((await getFeed(added.feed_id))!);
    expect(r).toMatchObject({ newItems: 2, woke: true });
    const events = await feedEvents(lookoutId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ feed_id: added.feed_id, new_items: 3, waiting: 3 });

    // More items while that event waits: no second event.
    net.pages.set(`${site}/feed`, rss(site, [{ id: "n4" }, { id: "n5" }, { id: "n6" }]));
    r = await pollFeed((await getFeed(added.feed_id))!);
    expect(r).toMatchObject({ newItems: 3, woke: false });
    expect(await feedEvents(lookoutId)).toHaveLength(1);

    // The lookout is due through the reconcile sweep's EXISTS clause.
    const [due] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM lookout_events WHERE lookout_id = $1 AND consumed_at IS NULL`,
      [lookoutId]
    );
    expect(due!.n).toBe(1);

    // Once the run consumed it, items already woken for do not wake again;
    // only items that arrived since the wake count.
    await rawQuery(`UPDATE lookout_events SET consumed_at = now() WHERE lookout_id = $1`, [lookoutId]);
    r = await pollFeed((await getFeed(added.feed_id))!);
    expect(r).toMatchObject({ newItems: 0, woke: true });
    const [again] = await feedEvents(lookoutId);
    expect(again!.payload).toMatchObject({ new_items: 3, waiting: 6 });
  });

  it("the tick polls only due feeds of active lookouts, and a failing feed backs off and then breaks", async () => {
    const { grantId, lookoutId, site } = await seedLookout();
    net.pages.set(`${site}/feed`, rss(site, []));
    const added = await addFeed({ grantId, lookoutId, url: `${site}/feed`, createdBy: "x" });
    if (!added.ok) throw new Error(added.problem);
    await rawQuery(`UPDATE lookout_feeds SET next_poll_at = now() - interval '1 minute' WHERE id = $1`, [added.feed_id]);

    net.pages.delete(`${site}/feed`);
    const tick = await feedPollTick({ maxFeeds: 1000 });
    expect(tick.failed).toBeGreaterThanOrEqual(1);
    let f = (await getFeed(added.feed_id))!;
    expect(f.consecutive_failures).toBe(1);
    expect(f.last_error).toMatch(/404/);
    expect(new Date(f.next_poll_at).getTime()).toBeGreaterThan(Date.now() + 6 * 3_600_000);

    await rawQuery(`UPDATE lookout_feeds SET consecutive_failures = 7 WHERE id = $1`, [added.feed_id]);
    await pollFeed((await getFeed(added.feed_id))!);
    f = (await getFeed(added.feed_id))!;
    expect(f.status).toBe("broken");

    // A paused lookout's feeds are not polled.
    await rawQuery(`UPDATE lookout_feeds SET status = 'active', next_poll_at = now() - interval '1 minute' WHERE id = $1`, [added.feed_id]);
    await rawQuery(`UPDATE lookouts SET status = 'paused' WHERE id = $1`, [lookoutId]);
    net.fetched.length = 0;
    await feedPollTick({ maxFeeds: 1000 });
    expect(net.fetched).not.toContain(`${site}/feed`);
  });
});

describe("the inbox", () => {
  async function withItems(n: number) {
    const s = await seedLookout();
    net.pages.set(`${s.site}/feed`, rss(s.site, []));
    const added = await addFeed({
      grantId: s.grantId, lookoutId: s.lookoutId, url: `${s.site}/feed`, createdBy: "x",
      rule: { wake: "heartbeat" },
    });
    if (!added.ok) throw new Error(added.problem);
    net.pages.set(
      `${s.site}/feed`,
      rss(s.site, Array.from({ length: n }, (_, i) => ({ id: `p${i}`, content: i === 0 ? `<h2>Intro</h2><p>${"word ".repeat(400)}</p><h2>Results</h2><p>See <a href="https://doi.org/10.1/x">the paper</a>.</p>` : undefined })))
    );
    await pollFeed((await getFeed(added.feed_id))!);
    return { ...s, feedId: added.feed_id };
  }

  it("lists waiting items, and triage ingests within the allowance, skips, defers, and skips the rest", async () => {
    const { grantId, lookoutId, site, feedId } = await withItems(5);
    const inbox = await feedInbox({ lookoutId });
    expect(inbox.total).toBe(5);
    const ids = inbox.rows.map((r) => r.item_id);

    const res = await triageItems({
      lookoutId,
      grantId,
      ingestAllowance: 1,
      decisions: [
        { item_id: ids[0], decision: "ingest", reason: "A substantive argument on the crux." },
        { item_id: ids[1], decision: "ingest" },
        { item_id: ids[2], decision: "defer" },
        { item_id: ids[3], decision: "skip", reason: "link roundup" },
        { item_id: randomUUID(), decision: "skip" },
      ],
    });
    expect(res.ingested).toBe(1);
    expect(res.outcomes.map((o) => o.ok)).toEqual([true, false, true, true, false]);
    expect(res.outcomes[1]!.note).toMatch(/No ingests left/);
    const plan = await planUrls(grantId);
    expect(plan).toEqual([inbox.rows[0]!.url]);

    // Proposing the same URL again finds it already planned; the item is done.
    const again = await triageItems({ lookoutId, grantId, ingestAllowance: 5, decisions: [{ item_id: ids[1], decision: "ingest" }] });
    expect(again.ingested).toBe(1);
    const dup = await triageItems({
      lookoutId, grantId, ingestAllowance: 5,
      decisions: [{ item_id: ids[2], decision: "skip" }],
      skipRest: { feedId, reason: "caught up" },
    });
    expect(dup.skipped_in_bulk).toBe(1);
    expect((await feedInbox({ lookoutId })).total).toBe(0);
    expect(await planUrls(grantId)).toHaveLength(2);

    const [report] = await feedReport(lookoutId);
    expect(report!.items).toMatchObject({ new: 0, deferred: 0, ingested: 2, skipped: 3 });
    expect(site).toBeTruthy();
  });

  it("reads an item from the feed's own copy at any depth, and caches a fetched page for the ingest", async () => {
    const { grantId, lookoutId, site } = await withItems(2);
    const rows = (await feedInbox({ lookoutId, order: "oldest" })).rows;
    const whole = rows.find((r) => r.url === `${site}/p/p0`)!;
    const lead = await readItem({ lookoutId, itemId: whole.item_id, view: "lead" });
    expect(lead).toMatchObject({ ok: true, from: "feed", headings: ["Intro", "Results"], in_graph: null });
    if (!lead.ok) throw new Error("unreachable");
    expect(lead.links).toEqual([{ url: "https://doi.org/10.1/x", text: "the paper" }]);
    const outline = await readItem({ lookoutId, itemId: whole.item_id, view: "outline" });
    expect(outline.ok && outline.sections?.map((s) => s.label)).toEqual(["Intro", "Results"]);
    const section = await readItem({ lookoutId, itemId: whole.item_id, view: "section", section: 1 });
    expect(section.ok && section.text).toContain("See the paper");
    const full = await readItem({ lookoutId, itemId: whole.item_id, view: "full" });
    expect(full).toMatchObject({ ok: true, page: 1, pages: 1 });
    expect(net.fetched).not.toContain(`${site}/p/p0`);

    // A teaser in the feed: the page is fetched once, cached, and reused.
    const teaser = rows.find((r) => r.url === `${site}/p/p1`)!;
    net.pages.set(`${site}/p/p1`, `<html><body><article><p>The whole post.</p></article></body></html>`);
    const read = await readItem({ lookoutId, itemId: teaser.item_id, view: "full" });
    expect(read).toMatchObject({ ok: true, from: "page" });
    await readItem({ lookoutId, itemId: teaser.item_id, view: "lead" });
    expect(net.fetched.filter((u) => u === `${site}/p/p1`)).toHaveLength(1);
    expect(await cachedItemBody(`${site}/p/p1`)).toMatchObject({ body: expect.stringContaining("The whole post.") });

    // Another lookout cannot read this one's items.
    const other = await seedLookout();
    expect(await readItem({ lookoutId: other.lookoutId, itemId: teaser.item_id })).toMatchObject({ ok: false });
    expect(grantId).toBeTruthy();
  });

  it("expires untriaged items past their retention, and counts them", async () => {
    const { lookoutId } = await withItems(3);
    await rawQuery(
      `UPDATE lookout_feed_items SET expires_at = now() - interval '1 minute' WHERE lookout_id = $1`,
      [lookoutId]
    );
    expect(await expireItems()).toBeGreaterThanOrEqual(3);
    const [report] = await feedReport(lookoutId);
    expect(report!.items).toMatchObject({ new: 0, expired: 3 });
  });
});

describe("rules", () => {
  it("a feed's ingest focus rides on its ingests, and triage can give its own or ask for the whole", async () => {
    const { grantId, lookoutId, site } = await seedLookout();
    const focus = "the author's claims about housing policy";
    net.pages.set(`${site}/feed`, rss(site, []));
    const auto = await addFeed({
      grantId, lookoutId, url: `${site}/feed`, createdBy: "x",
      rule: { wake: "auto_ingest", dailyIngestCap: 5 }, ingestFocus: focus,
    });
    if (!auto.ok) throw new Error(auto.problem);
    net.pages.set(`${site}/feed`, rss(site, [{ id: "a" }]));
    await pollFeed((await getFeed(auto.feed_id))!);

    // A rule change keeps the focus; the default focus is the Grantmaker's alone.
    expect(await updateFeed({ lookoutId, feedId: auto.feed_id, by: "grantmaker", rule: { wake: "heartbeat" } }))
      .toMatchObject({ ok: true });
    expect(await getFeed(auto.feed_id)).toMatchObject({ ingest_focus: focus });
    expect(await updateFeed({ lookoutId, feedId: auto.feed_id, by: "lookout", ingestFocus: "x" }))
      .toMatchObject({ ok: false, code: "FOCUS" });

    net.pages.set(`${site}/feed`, rss(site, [{ id: "a" }, { id: "b" }, { id: "c" }]));
    await pollFeed((await getFeed(auto.feed_id))!);
    const rows = (await feedInbox({ lookoutId, order: "oldest" })).rows;
    await triageItems({
      lookoutId, grantId, ingestAllowance: 5,
      decisions: [
        { item_id: rows[0]!.item_id, decision: "ingest" },
        { item_id: rows[1]!.item_id, decision: "ingest", focus: "" },
      ],
    });
    const [g] = await rawQuery<{ plan: { items: Array<{ url: string; focus?: string }> } }>(
      `SELECT plan FROM grants WHERE id = $1`,
      [grantId]
    );
    expect(g!.plan.items.map((i) => i.focus ?? null)).toEqual([focus, focus, null]);
    const [report] = await feedReport(lookoutId);
    expect(report!.ingest_focus).toBe(focus);
  });

  it("auto_ingest puts new items on the plan up to the daily cap, with no run", async () => {
    const { grantId, lookoutId, site } = await seedLookout();
    net.pages.set(`${site}/feed`, rss(site, []));
    const added = await addFeed({
      grantId, lookoutId, url: `${site}/feed`, createdBy: "x",
      rule: { wake: "auto_ingest", dailyIngestCap: 2 },
    });
    if (!added.ok) throw new Error(added.problem);
    net.pages.set(`${site}/feed`, rss(site, [{ id: "a" }, { id: "b" }, { id: "c" }]));
    const r = await pollFeed((await getFeed(added.feed_id))!);
    expect(r).toMatchObject({ autoIngested: 2, woke: false });
    expect(await planUrls(grantId)).toHaveLength(2);
    expect(await feedEvents(lookoutId)).toHaveLength(0);
    // The cap holds on the next poll the same day; the third waits.
    const r2 = await pollFeed((await getFeed(added.feed_id))!);
    expect(r2.autoIngested).toBe(0);
    const [report] = await feedReport(lookoutId);
    expect(report!.items).toMatchObject({ new: 1, ingested: 2, auto_ingested: 2 });
  });

  it("a lookout may retune its own feed either way, but not to or from auto_ingest; the Grantmaker may", async () => {
    const { grantId, lookoutId, site } = await seedLookout();
    net.pages.set(`${site}/feed`, rss(site, []));
    const added = await addFeed({ grantId, lookoutId, url: `${site}/feed`, createdBy: "x" });
    if (!added.ok) throw new Error(added.problem);

    expect(await updateFeed({ lookoutId, feedId: added.feed_id, by: "lookout", rule: { wake: "each", minWakeHours: 12 } }))
      .toMatchObject({ ok: true });
    expect(await getFeed(added.feed_id)).toMatchObject({ wake: "each", min_wake_hours: 12 });
    expect(await updateFeed({ lookoutId, feedId: added.feed_id, by: "lookout", rule: { wake: "auto_ingest" } }))
      .toMatchObject({ ok: false, code: "RULE" });
    expect(await updateFeed({ lookoutId, feedId: added.feed_id, by: "lookout", status: "removed" }))
      .toMatchObject({ ok: false, code: "STATUS" });

    expect(await updateFeed({ lookoutId, feedId: added.feed_id, by: "grantmaker", rule: { wake: "auto_ingest" } }))
      .toMatchObject({ ok: true });
    expect(await updateFeed({ lookoutId, feedId: added.feed_id, by: "lookout", rule: { wake: "batch" } }))
      .toMatchObject({ ok: false, code: "AUTO_INGEST" });
    expect(await updateFeed({ lookoutId, feedId: added.feed_id, by: "grantmaker", status: "removed" }))
      .toMatchObject({ ok: true });
    expect(await getFeed(added.feed_id)).toMatchObject({ status: "removed" });
  });
});
