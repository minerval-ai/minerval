/**
 * The extension's shared page cache against real SQL: the prefix bucket is a
 * range scan on the primary key, a re-share replaces the page's entry, and a
 * served entry reads each claim's graph state now (a claim that has gone
 * degrades to "not in the graph").
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { seedClaim } from "./helpers.js";
import {
  getSharedAnalysis,
  listSharedHashes,
  shareIfPublic,
} from "../../src/services/shared-analysis-service.js";
import { normalizePageUrl, pageUrlHash } from "../../src/services/page-url.js";
import type { PageAnalysis } from "../../src/services/extension-service.js";

const PHRASE_A = "Coffee consumption reduces the risk of type 2 diabetes.";
const PHRASE_B = "Bananas are naturally radioactive because they contain potassium-40.";
const PAGE = `<html><body><p>${PHRASE_A}</p><p>${PHRASE_B}</p></body></html>`;

function analysis(input: {
  hash: string;
  claimIds: Array<string | null>;
  why?: string;
}): PageAnalysis {
  const phrases = [PHRASE_A, PHRASE_B];
  return {
    url: "unused",
    content_hash: input.hash,
    annotations: input.claimIds.map((id, i) => ({
      verbatim_text: phrases[i]!,
      context: null,
      source_location: null,
      verdict: id ? ("contested" as const) : ("unknown" as const),
      why: input.why ?? "why",
      confidence: 0.7,
      stance: "affirms" as const,
      proposed_canonical_form: id ? null : "Bananas are measurably radioactive",
      claim: id
        ? {
            id,
            canonical_form: "stale form, not stored",
            status: "stale status, not stored",
            status_confidence: 0.1,
            subclaim_count: 0,
            url: `https://minerval.ai/claims/${id}`,
          }
        : null,
    })),
    stats: { extracted: 2, matched: input.claimIds.filter(Boolean).length },
    analyzed_at: new Date().toISOString(),
  };
}

const fetchText = async () => PAGE;

describe("shared page analyses", () => {
  it("serves a shared page by URL hash with live claim state, found via its prefix bucket", async () => {
    const claimId = await seedClaim("shared");
    const raw = `https://www.example.org/post/${randomUUID()}?utm_source=feed`;
    const out = await shareIfPublic(raw, analysis({ hash: randomUUID(), claimIds: [claimId, null] }), {
      fetchText,
    });
    expect(out.shared).toBe(true);

    const hash = pageUrlHash(normalizePageUrl(raw)!);
    expect(await listSharedHashes(hash.slice(0, 4))).toContain(hash);

    const served = await getSharedAnalysis(hash);
    expect(served?.shared).toBe(true);
    expect(served?.url).toBe(normalizePageUrl(raw));
    const [matched, unmatched] = served!.annotations;
    expect(matched!.claim?.id).toBe(claimId);
    // Read from the graph now, not the stored analysis.
    expect(matched!.claim?.canonical_form).toMatch(/^DB-test claim/);
    expect(matched!.claim?.status).toBe("unknown");
    expect(matched!.verdict).toBe("contested");
    expect(unmatched!.claim).toBeNull();
    expect(unmatched!.proposed_canonical_form).toBe("Bananas are measurably radioactive");
    expect(served!.stats).toEqual({ extracted: 2, matched: 1 });
  });

  it("keeps hashes outside the prefix out of the bucket", async () => {
    const raw = `https://example.org/other/${randomUUID()}`;
    await shareIfPublic(raw, analysis({ hash: randomUUID(), claimIds: [null, null] }), { fetchText });
    const hash = pageUrlHash(normalizePageUrl(raw)!);
    const other = hash.startsWith("0") ? "ffff" : "0000";
    expect(await listSharedHashes(other)).not.toContain(hash);
    for (const h of await listSharedHashes(hash.slice(0, 4))) {
      expect(h.startsWith(hash.slice(0, 4))).toBe(true);
    }
  });

  it("replaces a page's entry when it is re-shared", async () => {
    const raw = `https://example.org/changing/${randomUUID()}`;
    const hash = pageUrlHash(normalizePageUrl(raw)!);
    await shareIfPublic(raw, analysis({ hash: randomUUID(), claimIds: [null, null], why: "old" }), { fetchText });
    const claimId = await seedClaim("re-shared");
    await shareIfPublic(raw, analysis({ hash: randomUUID(), claimIds: [claimId, null], why: "new" }), { fetchText });

    const served = await getSharedAnalysis(hash);
    expect(served!.annotations[0]!.claim?.id).toBe(claimId);
    expect(served!.annotations[0]!.why).toBe("new");
  });

  it("degrades a claim that no longer exists to 'not in the graph'", async () => {
    const raw = `https://example.org/merged/${randomUUID()}`;
    await shareIfPublic(raw, analysis({ hash: randomUUID(), claimIds: [randomUUID(), null] }), { fetchText });
    const served = await getSharedAnalysis(pageUrlHash(normalizePageUrl(raw)!));
    expect(served!.annotations[0]!.claim).toBeNull();
    expect(served!.annotations[0]!.verdict).toBe("unknown");
    expect(served!.stats.matched).toBe(0);
  });

  it("returns null for an unknown or malformed hash", async () => {
    expect(await getSharedAnalysis("0".repeat(64))).toBeNull();
    expect(await getSharedAnalysis("not-a-hash")).toBeNull();
  });
});
