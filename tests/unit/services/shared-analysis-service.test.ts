import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ inserted: [] as unknown[] }));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoUpdate: async () => {
          db.inserted.push(row);
        },
      }),
    }),
  }),
  rawQuery: async () => [],
}));

import {
  phrasesFoundFraction,
  resetSharing,
  shareIfPublic,
} from "../../../src/services/shared-analysis-service.js";
import type { PageAnalysis } from "../../../src/services/extension-service.js";

const PHRASES = [
  "Coffee consumption reduces the risk of type 2 diabetes.",
  "Most of the plastic in the ocean comes from just ten rivers.",
];

function analysis(phrases: string[], hash = "h1"): PageAnalysis {
  return {
    url: "https://example.com/a",
    content_hash: hash,
    annotations: phrases.map((p) => ({
      verbatim_text: p,
      context: "surrounding sentence, never stored",
      source_location: null,
      verdict: "unknown" as const,
      why: "This claim isn't in the Minerval graph yet.",
      confidence: 0,
      stance: "affirms" as const,
      proposed_canonical_form: "canonical",
      claim: null,
    })),
    stats: { extracted: phrases.length, matched: 0 },
    analyzed_at: "2026-10-19T00:00:00.000Z",
  };
}

const PUBLIC_HTML = `<html><head><title>T</title><script>var x=1</script></head><body>
  <p>Coffee consumption <em>reduces</em> the risk of type&nbsp;2 diabetes.</p>
  <p>Most of the plastic in the ocean comes from just ten rivers!</p></body></html>`;

describe("phrasesFoundFraction", () => {
  it("forgives markup-adjacent differences in case, spacing and punctuation", () => {
    expect(phrasesFoundFraction("COFFEE consumption reduces the risk of type 2 diabetes", PHRASES)).toBe(0.5);
    expect(phrasesFoundFraction("", PHRASES)).toBe(0);
    expect(phrasesFoundFraction("anything", [])).toBe(0);
  });
});

describe("shareIfPublic", () => {
  beforeEach(() => {
    db.inserted.length = 0;
    resetSharing();
  });

  it("stores a page whose anonymous copy contains its phrases, keeping only what markup needs", async () => {
    const out = await shareIfPublic(
      "https://www.example.com/a?utm_source=x",
      analysis(PHRASES),
      { fetchText: async () => PUBLIC_HTML }
    );
    expect(out.shared).toBe(true);
    expect(db.inserted).toHaveLength(1);
    const row = db.inserted[0] as { url: string; annotations: Array<Record<string, unknown>> };
    expect(row.url).toBe("https://example.com/a");
    expect(Object.keys(row.annotations[0]!).sort()).toEqual(
      ["claim_id", "confidence", "proposed_canonical_form", "stance", "verbatim_text", "verdict", "why"]
    );
    expect(JSON.stringify(row)).not.toContain("never stored");
  });

  it("refuses a page the anonymous fetch can't see (a login wall, a draft)", async () => {
    const out = await shareIfPublic("https://example.com/inbox", analysis(PHRASES), {
      fetchText: async () => "<html><body>Please sign in to continue.</body></html>",
    });
    expect(out).toEqual({ shared: false, reason: "not_public" });
    expect(db.inserted).toHaveLength(0);
  });

  it("refuses when the fetch fails, and when there is nothing to share", async () => {
    const failed = await shareIfPublic("https://example.com/a", analysis(PHRASES), {
      fetchText: async () => {
        throw new Error("403");
      },
    });
    expect(failed).toEqual({ shared: false, reason: "fetch_failed" });
    const empty = await shareIfPublic("https://example.com/b", analysis([]), {
      fetchText: async () => PUBLIC_HTML,
    });
    expect(empty).toEqual({ shared: false, reason: "no_claims" });
    expect(db.inserted).toHaveLength(0);
  });

  it("requires most phrases, not just one, to be on the public copy", async () => {
    const out = await shareIfPublic(
      "https://example.com/a",
      analysis([...PHRASES, "A sentence only the logged-in reader saw.", "And another one like it."]),
      { fetchText: async () => PUBLIC_HTML }
    );
    expect(out).toEqual({ shared: false, reason: "not_public" });
  });

  it("verifies a page once for concurrent and repeated shares of the same analysis", async () => {
    const fetchText = vi.fn(async () => PUBLIC_HTML);
    await Promise.all([
      shareIfPublic("https://example.com/a", analysis(PHRASES), { fetchText }),
      shareIfPublic("https://example.com/a", analysis(PHRASES), { fetchText }),
    ]);
    await shareIfPublic("https://example.com/a", analysis(PHRASES), { fetchText });
    expect(fetchText).toHaveBeenCalledTimes(1);

    // A fresh analysis of a changed page is verified anew.
    await shareIfPublic("https://example.com/a", analysis(PHRASES, "h2"), { fetchText });
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});
