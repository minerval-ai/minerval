import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The one reader of HTML as text (#1127): the stored copy of a source and
// the page read_page opens are read by the same rules, which follow what a
// browser shows.

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn() }));

import { htmlToText, readHtml, readableText } from "../../../src/services/html-text.js";
import { quoteCheck } from "../../../src/services/source-map-service.js";
import { segmentText, segmentsStale } from "../../../src/services/source-segment-service.js";
import { createHash } from "node:crypto";

const read = (html: string) => readHtml(html).text;

describe("readHtml", () => {
  it("joins inline elements with nothing, so no space appears that the page does not have", () => {
    expect(read('<p><span>the </span><a href="x">things people</a><span> (and </span><a>AIs</a><span>) </span><a>say</a><span>.</span></p>')).toBe(
      "the things people (and AIs) say."
    );
    expect(read("<p>H<sub>2</sub>O is <em>wet</em>, <b>very</b>.</p>")).toBe("H2O is wet, very.");
    // Whitespace the document does have is kept, as one space; a line break in the source is whitespace.
    expect(read("<p>one <a>two</a>\n   <a>three</a>\nfour</p>")).toBe("one two three four");
    // A comment and an element a browser does not show leave nothing behind either.
    expect(read("<p>a<!-- x -->b<script>x()</script>c<svg><title>icon</title></svg>.</p>")).toBe("abc.");
  });

  it("breaks lines only at <br> and block elements, opening and closing", () => {
    expect(read("lead<p>one<br>two</p>tail<div>a</div><div>b</div><ul><li>x</li><li>y</li></ul>")).toBe(
      "lead\n\none\ntwo\n\ntail\n\na\n\nb\n\nx\n\ny"
    );
    expect(read("<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><td>d</td></tr></table>")).toBe("a b\n\nc d");
  });

  it("carries h1 to h6 as markdown headings, on one line", () => {
    const { text, headings } = readHtml("<h1>Title</h1><p>Body.</p><h3 class='x'>A <em>sub</em><br>heading<div><button>Link</button></div></h3><h2> </h2>");
    expect(text).toBe("# Title\n\nBody.\n\n### A sub heading");
    expect(headings).toBe(2);
    // An <h2> that is never closed is not a heading with the page inside it.
    expect(read("<h2>Open<p>" + "word ".repeat(100) + "</p><p>more</p></h2>")).toMatch(/^Open\n\nword word/);
    expect(read("<h2>One<h2>Two</h2>")).toBe("One\n\n## Two");
  });

  it("leaves out what a reader operates rather than reads", () => {
    expect(read("<p>Text.</p><button class='b'><div class='label'>Share</div></button><p>More.</p>")).toBe("Text.\n\nMore.");
    expect(read("<nav><a>Home</a><a>About</a></nav><p>Text.</p><form><input value='x'>Sign up</form><aside>Related</aside>")).toBe("Text.");
    // By role, and nested elements of the same name are counted.
    expect(read('<div role="button"><div>Share</div> this</div><p>Text.</p>')).toBe("Text.");
    // Share and subscribe widgets by class or id, and not a document's own words.
    expect(read('<div class="pencraft share-dialog"><div>Share</div></div><div id="subscribe-widget">Subscribe</div><p class="button-wrapper"><a>Share</a></p>ok')).toBe("ok");
    expect(read('<table class="share-price"><tr><td>Share price</td></tr></table><p class="subscriber-count">900 subscribers</p><div id="comments"><p>A comment.</p></div>')).toBe(
      "Share price\n\n900 subscribers\n\nA comment."
    );
  });

  it("does not lose the rest of a document to a dropped element that is never closed", () => {
    expect(read("<p>a</p><aside>b<p>c</p>")).toBe("a\n\nb\n\nc");
    expect(read('<p>a</p><div class="share-buttons">b<p>c</p>')).toBe("a\n\nb\n\nc");
    expect(read("<p>a</p><p>b<style>never closed")).toBe("a\n\nbnever closed");
    // A self-closed element opens nothing to skip.
    expect(read("a<svg/>b<button />c")).toBe("abc");
  });

  it("keeps a less-than sign that is not a tag, and reads through unclosed comments", () => {
    expect(read("<p>1 <> 2 < 3</p>")).toBe("1 <> 2 < 3");
    expect(read("<p>a < b and c > d</p>")).toBe("a < b and c > d");
    expect(read("<p>a<!-- x -->b <!-- never closed")).toBe("ab <!-- never closed");
    expect(read("<DIV><SCRIPT type=x>if (a < b) {}</script >Kept<STYLE>p{}</STYLE\n>.</DIV>")).toBe("Kept.");
  });

  it("takes linear time on content built to make it backtrack", () => {
    const n = 100_000;
    const cases: Record<string, string> = {
      lessThan: "<".repeat(n),
      comments: "<p>" + "<!--".repeat(n / 4),
      scriptNoEnd: "<p>" + "<script ".repeat(n / 8),
      scripts: "<script>".repeat(n / 8),
      navs: "<nav>".repeat(n / 5),
      roleButtons: "<x role=button>".repeat(n / 15),
      namedRoleButtons: Array.from({ length: n / 20 }, (_, i) => `<x${i} role=button>`).join(""),
      headings: "<h2>a".repeat(n / 5),
      whitespace: "<p>" + " \n".repeat(n / 2) + "a",
      breaks: "<br>".repeat(n / 4) + "<p>".repeat(n / 3),
    };
    for (const [name, input] of Object.entries(cases)) {
      const start = performance.now();
      read(input);
      expect(performance.now() - start, name).toBeLessThan(500);
    }
    expect(read(cases.lessThan!)).toBe(cases.lessThan);
    expect(read(cases.comments!)).toBe("<!--".repeat(n / 4));
  });
});

describe("a Substack post", () => {
  const html = readFileSync(new URL("./fixtures/substack-post.html", import.meta.url), "utf8");
  const { text, headings } = readableText(html);

  it("reads as the post: its sentences as written, its headings, and none of its buttons", () => {
    expect(text).toBe(
      [
        "# Introducing the Example Graph",
        "### A shared map of what is known",
        "A. N. Author",
        "Nov 12, 2026",
        "Unfortunately, the things people (and AIs) say are often wrong. The implicit knowledge graph within even the most epistemically careful mind, human or LLM, is thoroughly infected with falsehood.",
        "## [Citation Needed]",
        "A claim worth relying on says where it comes from1. Most do not, at least not yet.",
        "## What the graph is",
        "It is a public record of claims, each assessed against its evidence.\nAnyone can read it.",
        "## Where it starts",
        "With the questions people are already asking.",
        "## This blog",
        "We will write here about what we learn.",
      ].join("\n\n")
    );
    expect(headings).toBe(6);
    expect(text).not.toMatch(/Share|Subscribe|Recommended|Home/);
    expect(text).not.toMatch(/ [.,)]/);
  });

  it("holds a quotation of the page exactly", () => {
    expect(quoteCheck("the things people (and AIs) say are often wrong. The implicit knowledge graph", html)).toBe("verbatim");
    expect(quoteCheck("careful mind, human or LLM, is thoroughly infected", html)).toBe("verbatim");
  });

  it("divides at its own headings, and takes no short line for one", () => {
    const sections = (opts?: { markedHeadingsOnly: boolean }) =>
      segmentText(text, opts)
        .filter((s) => s.kind === "section")
        .map((s) => s.label);
    expect(sections({ markedHeadingsOnly: true })).toEqual([
      "Introducing the Example Graph",
      "A shared map of what is known",
      "[Citation Needed]",
      "What the graph is",
      "Where it starts",
      "This blog",
    ]);
    // Guessing from how a line looks would make sections of the byline and the date.
    expect(sections()).toContain("A. N. Author");
    const segs = segmentText(text, { markedHeadingsOnly: true });
    const byline = segs.find((s) => text.slice(s.start, s.end) === "A. N. Author")!;
    expect(byline.kind).toBe("passage");
    expect(segs[byline.parent!]!.label).toBe("A shared map of what is known");
  });
});

describe("htmlToText", () => {
  it("reads only what looks like HTML as HTML", () => {
    expect(htmlToText("Plain text with <b>a tag</b> and 3 < 4.\n\n1. Methods")).toBe(
      "Plain text with <b>a tag</b> and 3 < 4.\n\n1. Methods"
    );
    expect(readableText("# A markdown file\n\nText.")).toEqual({ text: "# A markdown file\n\nText.", headings: 0 });
  });
});

describe("segmentsStale", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  it("is true when the last segment is no longer the text at its offsets", () => {
    const text = "One.\n\nTwo.";
    const last = { char_start: 6, char_end: 10, text_hash: sha("Two.") };
    expect(segmentsStale(text, last)).toBe(false);
    expect(segmentsStale(text, undefined)).toBe(false);
    // The same document read with a space it no longer has, and one that grew shorter.
    expect(segmentsStale("One .\n\nTwo.", last)).toBe(true);
    expect(segmentsStale("One.", last)).toBe(true);
  });
});
