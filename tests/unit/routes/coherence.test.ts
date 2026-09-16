/**
 * /coherence (#330, Phase 0): the read-only pre-filter surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const CANDIDATE = {
  kind: "requires_status",
  primary_claim_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  claim_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
  importance: 0.9,
  relation: "requires",
  primary: {
    claim_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    text: "The conclusion",
    status: "verified",
    credence: 0.9,
    assessed_at: "2026-08-01T00:00:00.000Z",
  },
  other: {
    claim_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    text: "The premise",
    status: "contradicted",
    credence: 0.1,
    assessed_at: "2026-08-02T00:00:00.000Z",
  },
};

const STATS = {
  assessed_claims: 100,
  assessed_edges: 40,
  distinct_primaries: 1,
  counts: {
    requires_status: 1,
    requires_credence: 0,
    contradicts_both_high: 0,
    rivals_jointly_untenable: 0,
    stale_vs_neighbor: 0,
  },
};

const mocks = vi.hoisted(() => ({
  listCoherenceCandidates: vi.fn(),
  coherenceStats: vi.fn(),
  resolveTagBySlug: vi.fn(),
}));

vi.mock("../../../src/services/coherence-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/coherence-service.js")>();
  return {
    ...actual,
    listCoherenceCandidates: mocks.listCoherenceCandidates,
    coherenceStats: mocks.coherenceStats,
  };
});
vi.mock("../../../src/services/tag-service.js", () => ({
  resolveTagBySlug: mocks.resolveTagBySlug,
}));

import { coherenceRoutes } from "../../../src/routes/coherence.js";

async function buildApp() {
  const app = Fastify();
  await app.register(coherenceRoutes, { prefix: "/coherence" });
  return app;
}

beforeEach(() => {
  mocks.listCoherenceCandidates.mockReset().mockResolvedValue([CANDIDATE]);
  mocks.coherenceStats.mockReset().mockResolvedValue(STATS);
  mocks.resolveTagBySlug.mockReset().mockResolvedValue(null);
});

describe("GET /coherence", () => {
  it("returns the thresholds, the kinds, the stats and the shortlist over the whole graph", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/coherence?limit=10&offset=5" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toEqual({ tag: null });
    expect(body.thresholds.requiresMargin).toBeGreaterThan(0);
    expect(body.kinds).toContain("requires_status");
    expect(body.stats).toEqual(STATS);
    expect(body.candidates).toEqual([CANDIDATE]);
    expect(mocks.coherenceStats).toHaveBeenCalledWith({ tagId: null });
    expect(mocks.listCoherenceCandidates).toHaveBeenCalledWith(
      { tagId: null },
      { limit: 10, offset: 5 }
    );
    expect(mocks.resolveTagBySlug).not.toHaveBeenCalled();
  });

  it("scopes by tag slug", async () => {
    mocks.resolveTagBySlug.mockResolvedValue({ id: "tag-1", slug: "number-theory" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/coherence?tag=number-theory" });
    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toEqual({ tag: "number-theory" });
    expect(mocks.coherenceStats).toHaveBeenCalledWith({ tagId: "tag-1" });
    expect(mocks.listCoherenceCandidates).toHaveBeenCalledWith(
      { tagId: "tag-1" },
      { limit: 50, offset: 0 }
    );
  });

  it("404s on an unknown tag", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/coherence?tag=nope" });
    expect(res.statusCode).toBe(404);
    expect(mocks.listCoherenceCandidates).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/coherence?limit=5000" });
    expect(res.statusCode).toBe(400);
  });
});
