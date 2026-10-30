import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

/**
 * GET /jobs/:id is public, so it must not serve a text analysis: that job
 * holds what one account asked about, readable only by that account through
 * the MCP get_text_analysis tool.
 */

const job = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../../src/services/job-service.js", () => ({
  getJobById: vi.fn(async () => job.current),
}));

import { jobRoutes } from "../../../src/routes/jobs.js";

async function get(id: string) {
  const app = Fastify();
  await app.register(jobRoutes, { prefix: "/jobs" });
  return app.inject({ method: "GET", url: `/jobs/${id}` });
}

const ID = "11111111-2222-4333-8444-555555555555";

describe("GET /jobs/:id", () => {
  it("serves an ordinary job", async () => {
    job.current = { id: ID, type: "url_extraction", status: "complete", result: { n: 1 }, error: null };
    const res = await get(ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "url_extraction", result: { n: 1 } });
  });

  it.each(["extract_claims", "assess_text"])("hides a %s analysis", async (type) => {
    job.current = { id: ID, type, status: "complete", result: { claims: [] }, error: null };
    const res = await get(ID);
    expect(res.statusCode).toBe(404);
  });
});
