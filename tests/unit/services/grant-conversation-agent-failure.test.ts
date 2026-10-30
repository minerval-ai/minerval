import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A Grantmaker turn that fails (a provider error, a timeout) keeps the
 * funder's message: it is saved before the agent runs, the failure comes
 * back as AGENT_FAILED with that saved conversation, and the failed turn
 * gives back its share of the hourly allowance. Before, the message was
 * written only with the reply, so every failure lost it and a caller could
 * not tell whether a retry would duplicate it.
 */

const { state } = vi.hoisted(() => ({
  state: {
    fail: true,
    turns: 0,
    writes: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ grantConversationRateLimitPerHour: 2 }),
}));

const convoRow = {
  id: "convo-1",
  userId: "u-1",
  status: "active",
  messages: [] as unknown[],
  mandate: null,
  grantId: null,
  createdAt: new Date("2026-10-30"),
  updatedAt: new Date("2026-10-30"),
};

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
  getDb: () => ({
    insert: () => ({ values: () => ({ returning: async () => [convoRow] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.writes.push(values);
            return [{ ...convoRow, ...values }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [convoRow] }),
      }),
    }),
  }),
}));

vi.mock("../../../src/llm/agents/grantmaker.js", () => ({
  runGrantmakerTurn: vi.fn(async () => {
    state.turns += 1;
    if (state.fail) throw new Error("400 tool_use ids were found without tool_result blocks");
    return { reply: "Here is the draft.", mandate: null };
  }),
}));

import {
  addMessage,
  resetGrantConversationRateLimiter,
} from "../../../src/services/grant-conversation-service.js";

beforeEach(() => {
  resetGrantConversationRateLimiter();
  state.fail = true;
  state.turns = 0;
  state.writes = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const send = () =>
  addMessage({ conversationId: "convo-1", userId: "u-1", message: "Core tier. Please draft." });

describe("a failed Grantmaker turn", () => {
  it("keeps the funder's message and reports the failure with the saved conversation", async () => {
    const result = await send();
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== "AGENT_FAILED") throw new Error("expected AGENT_FAILED");
    // Saved before the agent ran, and nothing written after it failed.
    expect(state.writes).toHaveLength(1);
    const saved = result.conversation.messages as Array<{ role: string; content: string }>;
    expect(saved.at(-1)).toMatchObject({ role: "user", content: "Core tier. Please draft." });
    expect(result.message).toMatch(/saved/);
  });

  it("does not count against the hourly allowance", async () => {
    // The limit is 2; three failures in a row still each reach the agent.
    for (let i = 0; i < 3; i++) await send();
    expect(state.turns).toBe(3);
    state.fail = false;
    expect((await send()).ok).toBe(true);
  });

  it("saves the message and then the reply when the turn succeeds", async () => {
    state.fail = false;
    const result = await send();
    expect(result.ok).toBe(true);
    expect(state.writes).toHaveLength(2);
    const final = state.writes[1]!.messages as Array<{ role: string }>;
    expect(final.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
