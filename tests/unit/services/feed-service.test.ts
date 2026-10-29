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
  FEED_BOUNDS,
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

describe("parseFeed on hostile markup (CWE-1333)", () => {
  // Titles and summaries are stripped of tags. The regexes that did it retried
  // every unclosed "<", "<script", or "<style" to the end of the text, which is
  // quadratic: one item in a 10 MB feed could block the event loop for hours.
  const rss = (items: Array<[title: string, description: string]>) =>
    `<rss version="2.0"><channel><title>T</title>${items
      .map(([t, d], i) => `<item><guid>k${i}</guid><title><![CDATA[${t}]]></title><description><![CDATA[${d}]]></description></item>`)
      .join("")}</channel></rss>`;
  const cut = (text: string) => `${text.slice(0, FEED_BOUNDS.summaryChars - 1)}…`;

  it("gets through runs of unclosed tags in linear time, keeping them as text", () => {
    const hostile: Array<[title: string, description: string, summary: string | null]> = [
      ["<".repeat(200_000), `<p>${"<".repeat(200_000)}`, cut("<".repeat(200_000))],
      ["<script ".repeat(25_000), "<style ".repeat(25_000), cut("<style ".repeat(25_000))],
      ["<script <style ".repeat(15_000), `${"<script>".repeat(25_000)}</style>`, null],
      ["<a ".repeat(70_000), `<script>${"</script ".repeat(25_000)}`, cut("</script ".repeat(25_000))],
    ];
    for (const [title, description, summary] of hostile) {
      const started = performance.now();
      const [item] = parseFeed(rss([[title, description]]))!.items;
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(item!.title).toBe(title.trim().slice(0, 500));
      expect(item!.summary).toBe(summary);
    }
  });

  it("strips scripts, styles, and tags exactly as before", () => {
    const f = parseFeed(
      rss([
        [
          "Hello <b>World</b> &amp; <i>more</i>",
          `<p>Intro.</p><SCRIPT type="text/javascript">alert("<b>hi</b>")</Script ><style>p { color: red }</STYLE\n>Body &amp; <em>more</em></p>`,
        ],
        ["<scripts>Kept</scripts> and <style-guide>this</style-guide>", "<p>Before</p><script>never closed <b>bold</b> after"],
        ["a <> b < c", "<script>x<style>y</style>z"],
        ["<<b>Nested", `<p>Unclosed <a href="x"`],
        ["</script>Stray closer", "<script</script>Gone<style/></style>"],
      ])
    )!;
    expect(f.items.map(({ title, summary }) => ({ title, summary }))).toEqual([
      { title: "Hello World & more", summary: "Intro. Body & more" },
      { title: "Kept and this", summary: "Before never closed bold after" },
      { title: "a <> b < c", summary: "x z" },
      { title: "Nested", summary: `Unclosed <a href="x"` },
      { title: "Stray closer", summary: "Gone" },
    ]);
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

/**
 * Links, feeds and sitemap entries are read by forward scans that replaced
 * backtracking regexes. The scans keep the regexes' reading of odd and
 * malformed markup, quirks included, and finish in time on a crafted page
 * that kept each regex busy for seconds (up to hours at the 10 MB fetch cap).
 */
describe("pages, links, sitemaps: odd markup and hostile pages", () => {
  const BASE = "https://blog.example.org/p/post";

  /** fn's result and how long it took, in ms. */
  function timed<T>(fn: () => T): [T, number] {
    const start = performance.now();
    const value = fn();
    return [value, performance.now() - start];
  }

  it("reads anchors in any case and attribute order, and malformed ones as before", () => {
    const html = `<nav>
  <A HREF="/upper">Upper</A>
  <a class="c" href='/single' title="t">Single</a >
  <a href='/no-closing-quote>No closing quote</a>
  <a href=/bare target=_blank>Bare <b>bold</b></a>
  <a data-x="1"
     href = "/spaced"
  >Spaced
     text</a
  >
  <abbr href="/not-an-anchor">No</abbr>
  <a name="no-href">No href</a>
  <a title="x > y" href="/after-gt-in-title">Lost</a>
  <a href="/quoted>gt">Quoted gt</a>
  <a href="/outer">Outer <a href="/inner">Inner</a> tail</a>
  <a href="">Empty</a>
  <a href="/upper#again">Again</a>
  <a href="/dangling">Dangling
  <a href="/swallowed">Swallowed</a>
  <a href="/last">Last</a>
</nav>
<a href="/q></a>z">`;
    expect(extractLinks(html, BASE)).toEqual([
      { url: "https://blog.example.org/upper", text: "Upper" },
      { url: "https://blog.example.org/single", text: "Single" },
      { url: "https://blog.example.org/p/'/no-closing-quote", text: "No closing quote" },
      { url: "https://blog.example.org/bare", text: "Bare bold" },
      { url: "https://blog.example.org/spaced", text: "Spaced text" },
      { url: "https://blog.example.org/quoted%3Egt", text: "Quoted gt" },
      { url: "https://blog.example.org/outer", text: "Outer Inner" },
      { url: "https://blog.example.org/dangling", text: "Dangling Swallowed" },
      { url: "https://blog.example.org/last", text: "Last" },
      { url: "https://blog.example.org/p/%22/q", text: null },
    ]);
    expect(extractLinks(html, BASE, 2)).toEqual([
      { url: "https://blog.example.org/upper", text: "Upper" },
      { url: "https://blog.example.org/single", text: "Single" },
    ]);
  });

  it("finds advertised feeds in any case and attribute order, and malformed ones as before", () => {
    const html = `<head>
  <LINK REL="Alternate" TYPE="application/RSS+xml" HREF="/upper.xml">
  <link href='/single.xml' type='application/atom+xml' rel='alternate'>
  <link rel=alternate type=application/rss+xml href=/bare.xml>
  <link rel="alternate stylesheet" type="application/rss+xml" href="/alternate-stylesheet.xml"/>
  <link rel="alternates" type="application/rss+xml" href="/not-whole-word.xml">
  <link rel="me" title="alternate" type="application/rss+xml" href="/alternate-outside-rel.xml">
  <link rel="alternate" type="text/css" href="/not-a-feed.css">
  <linkx rel="alternate" type="application/rss+xml" href="/not-a-link-tag.xml">
  <link rel="alternate" type="application/rss+xml" href="/upper.xml">
  <link rel="alternate" type="application/rss+xml" href="/closed-by-a-later-tag.xml"
</head>
<link rel="alternate" type="application/rss+xml" href="/never-closed.xml"`;
    expect(discoverFeedLinks(html, BASE)).toEqual([
      "https://blog.example.org/upper.xml",
      "https://blog.example.org/single.xml",
      "https://blog.example.org/bare.xml",
      "https://blog.example.org/alternate-stylesheet.xml",
      "https://blog.example.org/closed-by-a-later-tag.xml",
    ]);
  });

  it("reads <loc> entries trimmed and in any case, and malformed ones as before", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>
    https://x.example/a
  </loc></url>
  <url><LOC>https://x.example/b</LOC></url>
  <url><loc>https://x.example/c?x=1&amp;y=2</loc></url>
  <url><loc>https://x.example/d</loc ></url>
  <url><loc>   </loc></url>
  <url><loc></loc></url>
  <url><loc>https://x.example/<b>e</b></loc></url>
  <url><loc>https://x.example/unclosed
  <url><loc>https://x.example/f</loc></url>
</urlset>`;
    expect(parseSitemap(xml)).toEqual({
      index: false,
      urls: ["https://x.example/a", "https://x.example/b", "https://x.example/c?x=1&y=2", "https://x.example/f"],
    });
  });

  // The regexes took seconds on each input below; the scans take about a millisecond.
  const first = `<a href="/first">First</a>`;
  it.each([
    ["<a href=x> repeated, never closed", first + "<a href=x>".repeat(40_000)],
    ['<a href="x> repeated, quote and anchor never closed', first + '<a href="x>'.repeat(20_000)],
  ])("extractLinks stays linear on %s", (_, html) => {
    const [links, ms] = timed(() => extractLinks(html, BASE, 5000));
    expect(links).toEqual([{ url: "https://blog.example.org/first", text: "First" }]);
    expect(ms).toBeLessThan(500);
  });

  const feed = `<link rel="alternate" type="application/rss+xml" href="/feed">`;
  it.each([
    ["<link repeated, never closed", feed + "<link ".repeat(25_000)],
    ["rel= repeated in one tag", feed + "<link type=application/rss+xml href=/x " + "rel=".repeat(25_000) + ">"],
  ])("discoverFeedLinks stays linear on %s", (_, html) => {
    const [feeds, ms] = timed(() => discoverFeedLinks(html, BASE));
    expect(feeds).toEqual(["https://blog.example.org/feed"]);
    expect(ms).toBeLessThan(500);
  });

  const head = `<urlset><url><loc>https://x.example/a</loc></url>`;
  it.each([
    ["text, then whitespace, in a <loc> left open", head + "<url><loc>x" + " ".repeat(70_000) + "y"],
    ["whitespace, then text, in a <loc> left open", head + "<url><loc>" + " ".repeat(2_500) + "x"],
  ])("parseSitemap stays linear on %s", (_, xml) => {
    const [sitemap, ms] = timed(() => parseSitemap(xml));
    expect(sitemap).toEqual({ index: false, urls: ["https://x.example/a"] });
    expect(ms).toBeLessThan(500);
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
