import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * askGraph (#312): the context modes reach the agent intact, claim mode is
 * anchored to a real claim, and citation hydration (#181) keeps every cited
 * id that resolves in the graph, wherever the agent saw it, while dropping
 * ids the graph cannot resolve.
 */
const mocks = vi.hoisted(() => ({
  graphChat: vi.fn(),
  getClaimById: vi.fn(),
  getCurrentAssessment: vi.fn(),
  untraced: [] as boolean[],
}));

vi.mock("../../../src/llm/agents/graph-chat.js", () => ({
  GRAPH_CHAT_AGENT: "graph_chat",
  graphChat: mocks.graphChat,
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  untraced: (fn: () => unknown) => {
    mocks.untraced.push(true);
    return fn();
  },
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
  }),
}));

import {
  askGraph,
  extractCitedClaimIds,
  UnknownClaimError,
} from "../../../src/services/graph-chat-service.js";
import { chatAboutPage } from "../../../src/services/extension-service.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("askGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.untraced.length = 0;
    mocks.getCurrentAssessment.mockResolvedValue(null);
    mocks.graphChat.mockResolvedValue({ reply: "ok", model: "served-model" });
  });

  it("runs the agent untraced in graph mode with the configured model", async () => {
    const result = await askGraph({
      messages: [{ role: "user", content: "is the sky blue?" }],
      context: { kind: "graph" },
    });

    expect(mocks.untraced).toEqual([true]);
    expect(mocks.graphChat).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "is the sky blue?" }],
      context: { kind: "graph" },
      model: "test-model",
    });
    expect(result).toEqual({ reply: "ok", citations: [], model: "served-model" });
  });

  it("names the configured model when the agent reports none", async () => {
    mocks.graphChat.mockResolvedValue({ reply: "ok", model: null });
    const { model } = await askGraph({
      messages: [{ role: "user", content: "hi" }],
      context: { kind: "graph" },
    });
    expect(model).toBe("test-model");
  });

  it("claim mode requires a claim the graph holds", async () => {
    mocks.getClaimById.mockResolvedValue(null);
    await expect(
      askGraph({
        messages: [{ role: "user", content: "hi" }],
        context: { kind: "claim", claimId: A },
      })
    ).rejects.toBeInstanceOf(UnknownClaimError);
    expect(mocks.graphChat).not.toHaveBeenCalled();

    mocks.getClaimById.mockResolvedValue({ id: A, text: "a claim" });
    await askGraph({
      messages: [{ role: "user", content: "hi" }],
      context: { kind: "claim", claimId: A },
    });
    expect(mocks.graphChat).toHaveBeenCalledWith(
      expect.objectContaining({ context: { kind: "claim", claimId: A } })
    );
  });

  it("hydrates cited ids that resolve, wherever the agent saw them (#181)", async () => {
    mocks.graphChat.mockResolvedValue({
      reply: `First point [claim:${A}]. Second point [claim:${B}].`,
      model: "m",
    });
    mocks.getClaimById.mockImplementation(async (id: string) =>
      id === A || id === B ? { id, text: `claim ${id}` } : null
    );
    mocks.getCurrentAssessment.mockImplementation(async (id: string) =>
      id === A ? { status: "verified", confidence: 0.9 } : null
    );

    const { citations } = await askGraph({
      messages: [{ role: "user", content: "hi" }],
      context: { kind: "graph" },
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
    mocks.graphChat.mockResolvedValue({
      reply: `Real [claim:${A}]. Fabricated [claim:${B}].`,
      model: "m",
    });
    mocks.getClaimById.mockImplementation(async (id: string) =>
      id === A ? { id, text: "real claim" } : null
    );

    const { citations } = await askGraph({
      messages: [{ role: "user", content: "hi" }],
      context: { kind: "graph" },
    });

    expect(citations.map((c) => c.id)).toEqual([A]);
  });

  it("extractCitedClaimIds dedupes and lowercases", () => {
    expect(
      extractCitedClaimIds(`[claim:${A.toUpperCase()}] and [claim:${A}] and [claim:nope]`)
    ).toEqual([A]);
  });
});

describe("chatAboutPage (the extension's endpoint)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentAssessment.mockResolvedValue(null);
    mocks.graphChat.mockResolvedValue({ reply: "ok", model: "m" });
  });

  it("is the graph chat in page mode (#312)", async () => {
    await chatAboutPage({
      messages: [{ role: "user", content: "hi" }],
      page: { url: "https://example.com/a", title: "A", claims: [] },
    });
    expect(mocks.graphChat).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { kind: "page", url: "https://example.com/a", title: "A", claims: [] },
      })
    );
  });
});
