import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Embeds (docs/architecture.md, "Embeds"): a claim shown on someone else's
// site states the graph's judgment whole, in the claim page's own words.
import {
  EMBED_HEIGHT_MESSAGE, badgeMarkdown, cardJudgment, claimIdFromPageUrl, iframeSnippet,
  judgmentLine, scriptSnippet,
} from "../../../web/lib/embed";
import {
  EMBED_PALETTE, renderBadge, renderBadgeNotice, renderEmbedNotice, renderEmbedPage,
} from "../../../web/lib/embed-render";
import type { ClaimCard } from "../../../web/lib/types";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web");
const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-10T12:00:00Z";
const OPTS = { theme: null, origin: "https://minerval.ai", now: NOW } as const;

function card(over: Partial<ClaimCard> = {}): ClaimCard {
  return {
    id: ID,
    kind: "claim",
    text: "Sample claim.",
    state: "active",
    assessment_status: null,
    assessment_confidence: null,
    standing: null,
    estimate: null,
    unit: null,
    contestation: null,
    assessed_at: null,
    updated_at: "2026-10-01T00:00:00Z",
    page_url: `https://minerval.ai/claims/${ID}`,
    ...over,
  };
}

describe("the judgment an embed states", () => {
  it("carries a status with its confidence and the dispute beside it", () => {
    const c = card({ assessment_status: "supported", assessment_confidence: 0.8, contestation: 0.4, assessed_at: NOW });
    expect(judgmentLine(cardJudgment(c))).toBe("supported · 0.80 · disputed");
    expect(judgmentLine(cardJudgment({ ...c, contestation: 0.7 }))).toBe("supported · 0.80 · actively disputed");
    expect(judgmentLine(cardJudgment({ ...c, contestation: 0.1 }))).toBe("supported · 0.80");
  });

  it("reads an unassessed claim as unassessed, with no verdict and no dispute label", () => {
    const j = cardJudgment(card({ contestation: 0.9 }));
    expect(j.verdict).toBeNull();
    expect(judgmentLine(j)).toBe("unassessed");
  });

  it("does not take an off-enum status for a verdict", () => {
    expect(judgmentLine(cardJudgment(card({ assessment_status: "contested", assessment_confidence: 0.5 })))).toBe("unassessed");
  });

  it("states a question by its standing and a quantity by its estimate", () => {
    const q = card({ kind: "question", standing: "leaning", assessment_confidence: 0.6, assessed_at: NOW });
    expect(judgmentLine(cardJudgment(q))).toBe("leaning · 0.60");
    expect(judgmentLine(cardJudgment({ ...q, standing: null }))).toBe("unassessed");

    const n = card({
      kind: "quantity",
      estimate: { form: "interval", low: 17e6, high: 100e6, level: 0.9, central: 50e6 },
      unit: { kind: "count", noun: "deaths", min: 0 },
      contestation: 0.35,
      assessed_at: NOW,
    });
    const j = cardJudgment(n);
    expect(j.verdict).toMatchObject({
      family: "estimate",
      words: "Between 17 and 100 million (90% interval), most likely about 50 million.",
    });
    expect(judgmentLine(j)).toBe("17 to 100 million · disputed");
    expect(judgmentLine(cardJudgment({ ...n, estimate: null }))).toBe("not yet estimated");
  });

  it("names a state that is not active", () => {
    const c = card({ state: "merged", assessment_status: "doubtful", assessment_confidence: 0.7 });
    expect(judgmentLine(cardJudgment(c))).toBe("doubtful · 0.70 · merged");
  });
});

describe("the embed page", () => {
  const hostile = card({
    text: `<script>alert(1)</script> & "quotes"`,
    assessment_status: "verified",
    assessment_confidence: 0.9,
    assessed_at: "2026-10-02T12:00:00Z",
  });

  it("escapes the claim's text everywhere it appears", () => {
    const html = renderEmbedPage(hostile, OPTS);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;");
    expect(renderBadge({ ...hostile, state: `"><script>` }, NOW)).not.toContain("<script>");
  });

  it("links to the claim's page in a new tab, is dated, and stays out of search", () => {
    const html = renderEmbedPage(hostile, OPTS);
    expect(html).toContain(`href="https://minerval.ai/claims/${ID}" target="_blank" rel="noopener"`);
    expect(html).toContain("as of Nov 10, 2026");
    expect(html).toContain("last assessed Oct 2, 2026");
    expect(html).toContain("verdict confidence 0.90");
    expect(html).toContain(`<meta name="robots" content="noindex">`);
  });

  it("never writes a page_url that is not http(s) into a link", () => {
    const html = renderEmbedPage({ ...hostile, page_url: "javascript:alert(1)" }, OPTS);
    expect(html).not.toContain("javascript:");
    expect(html).toContain(`href="https://minerval.ai/claims/${ID}"`);
  });

  it("fetches nothing: no stylesheet, font, image or outside script", () => {
    for (const doc of [renderEmbedPage(hostile, OPTS), renderEmbedNotice("not_found", ID, OPTS)]) {
      expect(doc).not.toMatch(/<link\b|<img\b|\bsrc=|@import|url\(/);
    }
    for (const svg of [renderBadge(hostile, NOW), renderBadgeNotice("not_found")]) {
      expect(svg).not.toMatch(/<image\b|<style\b|<script\b|\bhref=|@import|<foreignObject\b/);
    }
  });

  it("takes a theme from the address and otherwise leaves it to the viewer", () => {
    expect(renderEmbedPage(hostile, { ...OPTS, theme: "dark" })).toContain(`<html lang="en" data-theme="dark"`);
    expect(renderEmbedPage(hostile, OPTS)).not.toContain("<html lang=\"en\" data-theme");
  });

  it("posts the height message embed.js listens for", () => {
    const script = readFileSync(join(WEB, "public", "embed.js"), "utf8");
    expect(script).toContain(`"${EMBED_HEIGHT_MESSAGE}"`);
    expect(renderEmbedPage(hostile, OPTS)).toContain(`type:"${EMBED_HEIGHT_MESSAGE}"`);
  });
});

describe("the palette embeds restate", () => {
  // The embed page and the badge cannot read the site's stylesheet, so they
  // carry its colours; this holds each to the value in globals.css.
  const css = readFileSync(join(WEB, "app", "globals.css"), "utf8");
  const darkAt = css.indexOf(`:root[data-theme="dark"]`);
  const blocks = {
    light: css.slice(css.indexOf(":root {"), darkAt),
    dark: css.slice(darkAt, css.indexOf("}", darkAt)),
  };

  for (const theme of ["light", "dark"] as const) {
    it(`matches globals.css (${theme})`, () => {
      for (const [name, value] of Object.entries(EMBED_PALETTE[theme])) {
        const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(blocks[theme]);
        expect(m?.[1], `${name} in globals.css (${theme})`).toBe(value);
      }
    });
  }
});

describe("addresses and snippets", () => {
  it("reads a claim id from a claim page's URL and from nothing else", () => {
    expect(claimIdFromPageUrl(`https://minerval.ai/claims/${ID}`)).toBe(ID);
    expect(claimIdFromPageUrl(`https://minerval.ai/claims/${ID}/`)).toBe(ID);
    expect(claimIdFromPageUrl(`http://localhost:3000/claims/${ID}`, ["http://localhost:3000"])).toBe(ID);
    expect(claimIdFromPageUrl(`http://localhost:3000/claims/${ID}`)).toBeNull();
    expect(claimIdFromPageUrl(`https://example.com/claims/${ID}`)).toBeNull();
    expect(claimIdFromPageUrl(`https://minerval.ai.example.com/claims/${ID}`)).toBeNull();
    expect(claimIdFromPageUrl(`https://minerval.ai/claims/${ID}/map`)).toBeNull();
    expect(claimIdFromPageUrl("https://minerval.ai/claims")).toBeNull();
    expect(claimIdFromPageUrl("https://minerval.ai/claims/..%2Fadmin")).toBeNull();
    expect(claimIdFromPageUrl("not a url")).toBeNull();
  });

  it("escapes the claim's text in the snippets a site owner pastes", () => {
    const text = `A "quoted" <b>claim</b> & more`;
    const script = scriptSnippet("https://minerval.ai", ID, text);
    expect(script).toContain(`<blockquote class="minerval-claim" data-claim-id="${ID}">`);
    expect(script).toContain(`<a href="https://minerval.ai/claims/${ID}">A &quot;quoted&quot; &lt;b&gt;claim&lt;/b&gt; &amp; more</a>`);
    expect(script).toContain(`<script async src="https://minerval.ai/embed.js"></script>`);
    const frame = iframeSnippet("https://minerval.ai", ID, text);
    expect(frame.html).toContain(`src="https://minerval.ai/embed/claims/${ID}"`);
    expect(frame.html).not.toContain("<b>");
    expect(badgeMarkdown("https://minerval.ai", ID)).toBe(
      `[![Minerval's judgment of this claim](https://minerval.ai/embed/claims/${ID}/badge.svg)](https://minerval.ai/claims/${ID})`,
    );
  });
});
