import { describe, it, expect, vi } from "vitest";

/**
 * The pure half of feeds (services/feed-service.ts, #305): RSS 2.0, Atom,
 * and RSS 1.0 parse to the same item shape with links resolved; a page's
 * advertised feeds, its links, and a sitemap's entries are read; a wake
 * rule fires exactly when it says; a rule is clamped to its bounds and
 * auto_ingest is refused where it is not allowed.
 */

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import {
  discoverFeedLinks,
  extractLinks,
  feedWakeDue,
  normalizeFeedRule,
  normalizeUrl,
  parseFeed,
  parseSitemap,
  LOOKOUT_SETTABLE_WAKE_RULES,
} from "../../../src/services/feed-service.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title><![CDATA[Don't Worry About the Vase]]></title>
  <link>https://thezvi.substack.com</link>
  <item>
    <title><![CDATA[AI #200: Something &amp; More]]></title>
    <link>https://thezvi.substack.com/p/ai-200#comments</link>
    <guid isPermaLink="false">https://thezvi.substack.com/p/ai-200</guid>
    <dc:creator><![CDATA[Zvi Mowshowitz]]></dc:creator>
    <pubDate>Thu, 22 Oct 2026 14:00:00 GMT</pubDate>
    <description><![CDATA[<p>The weekly roundup.</p>]]></description>
    <content:encoded><![CDATA[<h2>Table of Contents</h2><p>Lots of words.</p>]]></content:encoded>
  </item>
  <item>
    <title>Relative link</title>
    <link>/p/relative</link>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <link href="https://blog.example.org/" rel="alternate"/>
  <link href="https://blog.example.org/atom.xml" rel="self"/>
  <entry>
    <id>tag:blog.example.org,2026:1</id>
    <title type="html">First &lt;em&gt;post&lt;/em&gt;</title>
    <link href="https://blog.example.org/feed-self" rel="self"/>
    <link href="/2026/first" rel="alternate"/>
    <author><name>A. Writer</name></author>
    <published>2026-10-01T09:00:00Z</published>
    <summary>Short summary.</summary>
    <content type="html">&lt;p&gt;Full text.&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://arxiv.org/"><title>cs.AI updates</title><link>https://arxiv.org/</link></channel>
  <item rdf:about="https://arxiv.org/abs/2610.00001">
    <title>A paper</title>
    <link>https://arxiv.org/abs/2610.00001</link>
    <dc:creator>Someone, Else</dc:creator>
    <description>Abstract text.</description>
  </item>
</rdf:RDF>`;

describe("parseFeed", () => {
  it("reads RSS 2.0: guid as key, the full content, the creator, links resolved and normalized", () => {
    const f = parseFeed(RSS, "https://thezvi.substack.com/feed")!;
    expect(f.format).toBe("rss");
    expect(f.title).toBe("Don't Worry About the Vase");
    expect(f.siteUrl).toBe("https://thezvi.substack.com/");
    expect(f.items).toHaveLength(2);
    const [a, b] = f.items;
    expect(a).toMatchObject({
      key: "https://thezvi.substack.com/p/ai-200",
      url: "https://thezvi.substack.com/p/ai-200",
      title: "AI #200: Something & More",
      author: "Zvi Mowshowitz",
      summary: "The weekly roundup.",
    });
    expect(a!.published?.toISOString()).toBe("2026-10-22T14:00:00.000Z");
    expect(a!.content).toContain("Lots of words.");
    // No guid: the resolved link is the key.
    expect(b).toMatchObject({ key: "https://thezvi.substack.com/p/relative", url: "https://thezvi.substack.com/p/relative" });
  });

  it("reads Atom, taking the alternate link over self", () => {
    const f = parseFeed(ATOM, "https://blog.example.org/atom.xml")!;
    expect(f.format).toBe("atom");
    expect(f.siteUrl).toBe("https://blog.example.org/");
    expect(f.items[0]).toMatchObject({
      key: "tag:blog.example.org,2026:1",
      url: "https://blog.example.org/2026/first",
      title: "First post",
      author: "A. Writer",
      summary: "Short summary.",
    });
    expect(f.items[0]!.content).toContain("Full text.");
  });

  it("reads RSS 1.0 (RDF)", () => {
    const f = parseFeed(RDF, "https://rss.arxiv.org/rss/cs.AI")!;
    expect(f.format).toBe("rdf");
    expect(f.title).toBe("cs.AI updates");
    expect(f.items[0]).toMatchObject({ key: "https://arxiv.org/abs/2610.00001", title: "A paper", author: "Someone, Else" });
  });

  it("returns null for anything that is not a feed", () => {
    expect(parseFeed("<html><body>hi</body></html>")).toBeNull();
    expect(parseFeed('{"a": 1}')).toBeNull();
    expect(parseFeed("<rss><channel><title>broken")).not.toBeUndefined();
  });
});

describe("pages, links, sitemaps", () => {
  it("finds the feeds a page advertises, resolved against the page", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed">
      <link rel="stylesheet" href="/s.css">
      <link type="application/atom+xml" rel="alternate" href="https://other.example/atom.xml"/>
    </head></html>`;
    expect(discoverFeedLinks(html, "https://blog.example.org/about")).toEqual([
      "https://blog.example.org/feed",
      "https://other.example/atom.xml",
    ]);
  });

  it("lists a page's links once each, absolute, without fragments or non-http schemes", () => {
    const html = `<p><a href="/a">One</a> <a href="/a#x">Again</a> <a href="mailto:x@y">Mail</a>
      <a href='https://doi.org/10.1/x'><em>The paper</em></a></p>`;
    expect(extractLinks(html, "https://blog.example.org/p/post")).toEqual([
      { url: "https://blog.example.org/a", text: "One" },
      { url: "https://doi.org/10.1/x", text: "The paper" },
    ]);
  });

  it("reads a sitemap and a sitemap index; anything else is not one", () => {
    expect(parseSitemap(`<urlset><url><loc>https://x.example/a?b=1&amp;c=2</loc></url></urlset>`)).toEqual({
      index: false,
      urls: ["https://x.example/a?b=1&c=2"],
    });
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://x.example/s1.xml</loc></sitemap></sitemapindex>`)).toEqual({
      index: true,
      urls: ["https://x.example/s1.xml"],
    });
    expect(parseSitemap("<html></html>")).toBeNull();
  });

  it("normalizes URLs the way flagIngest stores them", () => {
    expect(normalizeUrl("HTTPS://Example.org/a#frag")).toBe("https://example.org/a");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("feedWakeDue", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-10-23T12:00:00Z");
  const feed = (over: Record<string, unknown> = {}) => ({
    wake: "batch" as const,
    batch_size: 10,
    max_wait_hours: 24,
    min_wake_hours: 4,
    last_woke_at: null as Date | null,
    ...over,
  });

  it("never wakes for nothing new, nor for heartbeat, paused, or auto_ingest feeds", () => {
    expect(feedWakeDue(feed(), { fresh: 0, oldestFreshAt: null }, now)).toBe(false);
    for (const wake of ["heartbeat", "paused", "auto_ingest"] as const) {
      expect(feedWakeDue(feed({ wake }), { fresh: 50, oldestFreshAt: new Date(now - 100 * H) }, now)).toBe(false);
    }
  });

  it("batch: wakes at batch_size, or when the oldest has waited max_wait_hours", () => {
    expect(feedWakeDue(feed(), { fresh: 9, oldestFreshAt: new Date(now - 2 * H) }, now)).toBe(false);
    expect(feedWakeDue(feed(), { fresh: 10, oldestFreshAt: new Date(now - 2 * H) }, now)).toBe(true);
    expect(feedWakeDue(feed(), { fresh: 1, oldestFreshAt: new Date(now - 24 * H) }, now)).toBe(true);
  });

  it("each: any new item; both rules respect min_wake_hours", () => {
    expect(feedWakeDue(feed({ wake: "each" }), { fresh: 1, oldestFreshAt: new Date(now) }, now)).toBe(true);
    const recent = new Date(now - 3 * H);
    expect(feedWakeDue(feed({ wake: "each", last_woke_at: recent }), { fresh: 1, oldestFreshAt: new Date(now) }, now)).toBe(false);
    expect(feedWakeDue(feed({ last_woke_at: recent }), { fresh: 99, oldestFreshAt: new Date(now) }, now)).toBe(false);
    expect(feedWakeDue(feed({ wake: "each", last_woke_at: new Date(now - 4 * H) }), { fresh: 1, oldestFreshAt: new Date(now) }, now)).toBe(true);
  });
});

describe("normalizeFeedRule", () => {
  it("clamps to the bounds and keeps the current values for what is not given", () => {
    const r = normalizeFeedRule({ batchSize: 100000, pollHours: 0 }, { wake: "each", retain_days: 30 });
    expect(r).toMatchObject({ wake: "each", batch_size: 500, poll_hours: 1, retain_days: 30, min_wake_hours: 4 });
  });

  it("refuses an unknown rule, and auto_ingest where it is not allowed", () => {
    expect(normalizeFeedRule({ wake: "sometimes" })).toMatch(/wake must be one of/);
    expect(normalizeFeedRule({ wake: "auto_ingest" }, {}, LOOKOUT_SETTABLE_WAKE_RULES)).toMatch(/wake must be one of/);
    expect(normalizeFeedRule({ wake: "auto_ingest" })).toMatchObject({ wake: "auto_ingest" });
  });
});
