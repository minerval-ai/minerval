import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// The web tier holds a service key and renders pages for everyone, so a
// service key alone must not open a private run: only an explicit
// include_private=true from a direct service caller does.
const mocks = vi.hoisted(() => ({
  getRunSummary: vi.fn(async () => ({ id: "r", agent: "steward" })),
  listRunSteps: vi.fn(async () => ({ steps: [], next_after: null })),
  getRunStep: vi.fn(async () => ({ seq: 0, kind: "prompt", created_at: "", content: {} })),
  auth: null as null | { isService: boolean; isSession: boolean },
}));

vi.mock("../../../src/services/run-view-service.js", () => ({
  STEP_KINDS: ["prompt", "assistant", "tool_results", "completion"],
  getRunSummary: mocks.getRunSummary,
  listRunSteps: mocks.listRunSteps,
  getRunStep: mocks.getRunStep,
}));
vi.mock("../../../src/server/plugins/auth.js", () => ({
  isDirectService: (a: { isService?: boolean; isSession?: boolean } | null) => a?.isService === true && !a.isSession,
  presentsCredentials: () => mocks.auth !== null,
}));

import { runRoutes } from "../../../src/routes/runs.js";

const RUN = "11111111-1111-1111-1111-111111111111";

async function app() {
  const a = Fastify();
  a.decorateRequest("auth", null);
  a.decorate("authenticate", async (request: any) => {
    request.auth = mocks.auth;
  });
  await a.register(runRoutes, { prefix: "/runs" });
  return a;
}

beforeEach(() => {
  mocks.getRunSummary.mockClear();
  mocks.listRunSteps.mockClear();
  mocks.getRunStep.mockClear();
  mocks.auth = null;
});

describe("GET /runs/:id visibility gate", () => {
  it("reads as the public for an anonymous caller", async () => {
    await (await app()).inject({ url: `/runs/${RUN}?include_private=true` });
    expect(mocks.getRunSummary).toHaveBeenCalledWith(RUN, { isService: false, memberReads: null, rawSourceLabels: null });
  });

  it("reads as the public for a service key that does not ask for private runs", async () => {
    mocks.auth = { isService: true, isSession: false };
    await (await app()).inject({ url: `/runs/${RUN}` });
    expect(mocks.getRunSummary).toHaveBeenCalledWith(RUN, { isService: false, memberReads: null, rawSourceLabels: null });
  });

  it("reads private runs only for a direct service caller that asks", async () => {
    mocks.auth = { isService: true, isSession: false };
    await (await app()).inject({ url: `/runs/${RUN}?include_private=true` });
    // On the public graph no reader is a member, so a run with private reasons is served to the service alone.
    expect(mocks.getRunSummary).toHaveBeenCalledWith(RUN, { isService: true, memberReads: null, rawSourceLabels: null });
    await (await app()).inject({ url: `/runs/${RUN}/steps/0?include_private=true` });
    // On the public graph nothing holds a reader back from source text.
    expect(mocks.getRunStep).toHaveBeenCalledWith(RUN, 0, { isService: true, memberReads: null, rawSourceLabels: null });
  });

  it("does not open private runs to a signed-in session, even with the service key", async () => {
    mocks.auth = { isService: true, isSession: true };
    await (await app()).inject({ url: `/runs/${RUN}/steps?include_private=true` });
    expect(mocks.listRunSteps).toHaveBeenCalledWith(RUN, expect.objectContaining({ isService: false }));
  });
});
