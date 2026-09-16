import { describe, it, expect } from "vitest";
import {
  GRAPH_CHAT_GROUNDING_RULES,
  getGraphChatSystemPrompt,
  getGraphChatContextPrompt,
} from "../../../../src/llm/prompts/graph-chat.js";

/**
 * The graph chat's prompts (#312): one system prompt shared by every surface,
 * whose grounding rules are exported verbatim for the MCP `ask_graph` prompt,
 * and a context block per mode. The rules the issue asked to keep from the
 * extension chat, grounding, citations, and voice, are guarded here.
 */
describe("graph chat prompts (#312)", () => {
  const system = getGraphChatSystemPrompt();

  it("keeps the grounding, citation, and voice rules", () => {
    expect(system).toContain(GRAPH_CHAT_GROUNDING_RULES);
    expect(system).toContain("[claim:<uuid>]");
    expect(system).toMatch(/Never guess or invent an id/);
    expect(system).toMatch(/does not settle\s+verdicts/);
    expect(system).toMatch(/no tool names, no internal scores, no em-dashes/);
  });

  it("names the shared read tools, not the older graph tools", () => {
    expect(system).toContain("get_claim)");
    expect(system).toContain("get_decomposition");
    expect(system).toContain("get_dependents");
    expect(system).not.toContain("get_claim_details");
    expect(system).not.toContain("search_similar_claims");
  });

  it("is not an admin prompt", () => {
    expect(system).not.toMatch(/constitution/i);
  });

  it("page mode carries the page and its annotated claims", () => {
    const block = getGraphChatContextPrompt({
      kind: "page",
      url: "https://example.com/a",
      title: "A",
      claims: [
        {
          verbatim_text: "x",
          verdict: "fine",
          claim_id: null,
          canonical_form: null,
          status: null,
        },
      ],
    });
    expect(block).toContain("browser extension");
    expect(block).toContain("https://example.com/a");
    expect(block).toContain('"verbatim_text": "x"');

    const bare = getGraphChatContextPrompt({
      kind: "page",
      url: null,
      title: null,
      claims: [],
    });
    expect(bare).toContain("has not been analyzed yet");
  });

  it("claim mode embeds the prefetched record and decomposition", () => {
    const block = getGraphChatContextPrompt(
      { kind: "claim", claimId: "11111111-1111-1111-1111-111111111111" },
      { claim: '{"claim":{"id":"11111111-1111-1111-1111-111111111111"}}', decomposition: '{"tree":[]}' }
    );
    expect(block).toContain("Questions that name no claim are about this one");
    expect(block).toContain('"claim":{"id":"11111111-1111-1111-1111-111111111111"}');
    expect(block).toContain('{"tree":[]}');
  });

  it("claim mode degrades to the bare id when the prefetch failed", () => {
    const block = getGraphChatContextPrompt({
      kind: "claim",
      claimId: "11111111-1111-1111-1111-111111111111",
    });
    expect(block).toContain("11111111-1111-1111-1111-111111111111");
    expect(block).not.toContain("Its decomposition");
  });

  it("graph mode tells the model to search before answering", () => {
    const block = getGraphChatContextPrompt({ kind: "graph" });
    expect(block).toMatch(/search the graph/);
    expect(block).toMatch(/nothing on it/);
  });
});
