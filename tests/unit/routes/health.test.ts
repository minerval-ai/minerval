/**
 * GET /health (src/routes/health.ts): the container's and the load
 * balancer's probe. It answers without logging each call at info, so the
 * start-up lines docs/self-hosting.md says to look for are not buried under
 * a pair of lines every 30 seconds (#1091); a failed database check still
 * logs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { Writable } from "node:stream";

const mocks = vi.hoisted(() => ({ rawQuery: vi.fn() }));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: mocks.rawQuery }));

import { healthRoutes } from "../../../src/routes/health.js";

async function buildApp() {
  const lines: Array<{ level: number; msg: string }> = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
      done();
    },
  });
  const app = Fastify({ logger: { level: "info", stream } });
  await app.register(healthRoutes);
  // A route with no level of its own, to show the logger does log requests.
  app.get("/other", async () => ({ ok: true }));
  return { app, lines };
}

describe("GET /health", () => {
  beforeEach(() => {
    mocks.rawQuery.mockReset();
  });

  it("answers healthy without an info line per request", async () => {
    mocks.rawQuery.mockResolvedValue([]);
    const { app, lines } = await buildApp();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "healthy", db: "connected" });
    expect(lines.filter((l) => l.msg === "incoming request" || l.msg === "request completed")).toEqual([]);

    await app.inject({ method: "GET", url: "/other" });
    expect(lines.map((l) => l.msg)).toContain("request completed");
    await app.close();
  });

  it("still logs a failed database check, at error", async () => {
    mocks.rawQuery.mockRejectedValue(new Error("connection refused"));
    const { app, lines } = await buildApp();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ status: "degraded", db: "disconnected" });
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "Health check DB connection failed" }));
    await app.close();
  });
});
