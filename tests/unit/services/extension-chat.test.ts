import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Citation hydration in chatAboutPage (#181): every cited id that resolves in
 * the graph is hydrated — including ids the agent saw only in another tool's
 * output, the page context, or an earlier turn — while ids the graph cannot
 * resolve are dropped.
 */
const mocks = vi.hoisted(() => ({
  extensionChat: vi.fn(),
  getClaimById: vi.fn(),
  getCurrentAssessment: vi.fn(),
}));

vi.mock("../../../src/llm/agents/extension-agent.js", () => ({
  assessPageClaims: vi.fn(async () => []),
  extensionChat: mocks.extensionChat,
  EXTENSION_VERDICTS: ["egregious", "contested", "oversimplified", "noteworthy", "fine"],
}));
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: mocks.getClaimById,
}));
vi.mock("../../../src/services/assessment-service.js", () => ({
  getCurrentAssessment: mocks.getCurrentAssessment,
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    publicWebBaseUrl: "https://minerval.ai",
    extensionModel: "test-model",
    extensionMaxClaims: 10,
  }),
}));

import { chatAboutPage } from "../../../src/services/extension-service.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

const PAGE = { url: "https://example.com/a", title: "A", claims: [] };

describe("chatAboutPage citation hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentAssessment.mockResolvedValue(null);
  });

  it("hydrates cited ids that resolve, wherever the agent saw them (#181)", async () => {
    mocks.extensionChat.mockResolvedValue({
      reply: `First point [claim:${A}]. Second point [claim:${B}].`,
    });
    mocks.getClaimById.mockImplementation(async (id: string) =>
      id === A || id === B ? { id, text: `claim ${id}` } : null
    );
    mocks.getCurrentAssessment.mockImplementation(async (id: string) =>
      id === A ? { status: "verified", confidence: 0.9 } : null
    );

    const { citations } = await chatAboutPage({
      messages: [{ role: "user", content: "hi" }],
      page: PAGE,
    });

    expect(citations).toEqual([
      {
        id: A,
        canonical_form: `claim ${A}`,
        status: "verified",
        url: `https://minerval.ai/claims/${A}`,
      },
      {
        id: B,
        canonical_form: `claim ${B}`,
        status: null,
        url: `https://minerval.ai/claims/${B}`,
      },
    ]);
  });

  it("drops cited ids the graph cannot resolve", async () => {
    mocks.extensionChat.mockResolvedValue({
      reply: `Real [claim:${A}]. Fabricated [claim:${B}].`,
    });
    mocks.getClaimById.mockImplementation(async (id: string) =>
      id === A ? { id, text: "real claim" } : null
    );

    const { citations } = await chatAboutPage({
      messages: [{ role: "user", content: "hi" }],
      page: PAGE,
    });

    expect(citations.map((c) => c.id)).toEqual([A]);
  });
});
