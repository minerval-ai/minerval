import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

// The part reads go to the database; the prompt set is built from the code.
vi.mock("../../../src/services/setup-service.js", () => ({
  listSetupParts: vi.fn(async () => []),
  getSetupPart: vi.fn(async () => null),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ gitSha: "abc1234" }),
}));

import { setupRoutes } from "../../../src/routes/setup.js";
import { getPromptSet } from "../../../src/services/prompt-set.js";

describe("GET /setup/prompt-set", () => {
  it("serves the prompt set the running code builds, whole, with its commit", async () => {
    const app = Fastify();
    await app.register(setupRoutes, { prefix: "/setup" });
    const res = await app.inject({ url: "/setup/prompt-set" });
    expect(res.statusCode).toBe(200);
    // Nothing is dropped by the response schema.
    expect(res.json()).toEqual({ ...getPromptSet(), commit: "abc1234" });
  });
});
