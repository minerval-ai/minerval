import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The hourly cap on granting-conversation turns.
 *
 * Every turn runs the Grantmaker on the best model, synchronously, and
 * deliberately free — nothing is charged until a mandate is funded. Two
 * things that look like limits are not: MAX_MESSAGES bounds ONE
 * conversation, and a user may open as many as they like; and the
 * process-wide LLM breaker now scopes itself to unattributed work, so a
 * signed-in user's turns are outside it. This is the bound.
 */

const { state } = vi.hoisted(() => ({
  state: {
    turns: 0,
    limit: 3,
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ grantConversationRateLimitPerHour: state.limit }),
}));

// A conversation row, and a drizzle builder just deep enough for the two
// chains the service uses (insert…returning, update…where…returning).
const convoRow = {
  id: "convo-1",
  userId: "u-1",
  status: "active",
  messages: [] as unknown[],
  mandate: null,
  grantId: null,
  createdAt: new Date("2026-08-09"),
  updatedAt: new Date("2026-08-09"),
};

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
  getDb: () => ({
    insert: () => ({ values: () => ({ returning: async () => [convoRow] }) }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [convoRow] }) }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [convoRow] }) }),
      }),
    }),
  }),
}));

vi.mock("../../../src/llm/agents/grantmaker.js", () => ({
  runGrantmakerTurn: vi.fn(async () => {
    state.turns += 1;
    return { reply: "Tell me more about the scope.", mandate: null };
  }),
}));

import {
  startConversation,
  resetGrantConversationRateLimiter,
} from "../../../src/services/grant-conversation-service.js";

beforeEach(() => {
  resetGrantConversationRateLimiter();
  state.turns = 0;
  state.limit = 3;
});

describe("granting-conversation rate limit", () => {
  const open = () =>
    startConversation({ userId: "u-1", message: "Fund work on X." });

  it("allows turns up to the hourly limit", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await open()).ok).toBe(true);
    }
    expect(state.turns).toBe(3);
  });

  it("refuses the turn past the limit, and does not run the agent", async () => {
    for (let i = 0; i < 3; i++) await open();
    const result = await open();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RATE_LIMITED");
    // The point of the limit: the expensive part never happened.
    expect(state.turns).toBe(3);
  });

  it("counts per user, so one user cannot exhaust another's allowance", async () => {
    for (let i = 0; i < 3; i++) await open();
    const other = await startConversation({
      userId: "u-2",
      message: "Fund work on Y.",
    });
    expect(other.ok).toBe(true);
  });

  it("treats 0 as unlimited", async () => {
    state.limit = 0;
    for (let i = 0; i < 8; i++) {
      expect((await open()).ok).toBe(true);
    }
    expect(state.turns).toBe(8);
  });

  it("still rejects an empty message before spending a turn's allowance", async () => {
    const result = await startConversation({ userId: "u-1", message: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EMPTY_MESSAGE");
    // The rejected attempt did not consume any of the hour.
    for (let i = 0; i < 3; i++) {
      expect((await open()).ok).toBe(true);
    }
  });
});
