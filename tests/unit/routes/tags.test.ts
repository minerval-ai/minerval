/**
 * /tags (#272): the public, read-only vocabulary surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const TAG = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "vaccine-safety",
  name: "Vaccine safety",
  description: "Adverse effects and risk of vaccines.",
  status: "active",
  merged_into: null,
  created_by: "tagger",
  created_at: "2026-09-01T00:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  listTags: vi.fn(),
  resolveTagBySlug: vi.fn(),
  searchTags: vi.fn(),
}));

vi.mock("../../../src/services/tag-service.js", () => ({
  listTags: mocks.listTags,
  resolveTagBySlug: mocks.resolveTagBySlug,
  searchTags: mocks.searchTags,
}));

import { tagRoutes } from "../../../src/routes/tags.js";

async function buildApp() {
  const app = Fastify();
  await app.register(tagRoutes, { prefix: "/tags" });
  return app;
}

beforeEach(() => {
  mocks.listTags.mockReset().mockResolvedValue([{ ...TAG, claim_count: 12 }]);
  mocks.resolveTagBySlug.mockReset().mockResolvedValue(TAG);
  mocks.searchTags.mockReset().mockResolvedValue([{ ...TAG, claim_count: 12, similarity: 0.9 }]);
});

describe("GET /tags", () => {
  it("lists the vocabulary with counts, most-used first", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/tags?limit=10" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual([
      {
        id: TAG.id,
        slug: "vaccine-safety",
        name: "Vaccine safety",
        description: TAG.description,
        claim_count: 12,
        similarity: null,
      },
    ]);
    expect(mocks.listTags).toHaveBeenCalledWith({ q: undefined, limit: 10, includeUnused: false });
  });

  it("ranks by meaning in search mode", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/tags?mode=search&q=vaccines" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags[0].similarity).toBeCloseTo(0.9);
    expect(mocks.searchTags).toHaveBeenCalledWith("vaccines", { limit: 50 });
    expect(mocks.listTags).not.toHaveBeenCalled();
  });
});

describe("GET /tags/:slug", () => {
  it("serves one tag and notes when the requested slug was a merged alias", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/tags/vaccines-safety" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tag).toMatchObject({ slug: "vaccine-safety", claim_count: 12, status: "active" });
    expect(body.requested_slug).toBe("vaccines-safety");
  });

  it("404s an unknown slug", async () => {
    mocks.resolveTagBySlug.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/tags/nothing" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
