/**
 * The Grantmaker with the platform as its funder (#529): it is told its
 * counterpart is Minerval and owed no deference, and on a funded platform
 * mandate the management chat cannot confirm a bounty posting, because a
 * platform confirmation is the operator key's act, never the conversation's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  system: [] as string[],
  toolNames: [] as string[],
  confirmResult: "" as string,
  opens: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: {
    system: string[];
    tools: Array<{ name: string }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
    state.system = opts.system;
    state.toolNames = opts.tools.map((t) => t.name);
    // Dispatched whether or not it is declared: the guard under test is in
    // the management dispatch, which is what a tool call would reach.
    state.confirmResult = await opts.executeTool("confirm_bounty", { bounty_id: "b-1" });
    return { content: "ok" };
  }),
}));
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
  withTransaction: vi.fn(),
}));
vi.mock("../../../src/llm/agents/skill-selection.js", () => ({
  skillsForGrant: vi.fn(async () => []),
}));
vi.mock("../../../src/services/bounty-service.js", () => ({
  requestBounty: vi.fn(),
  openBounty: vi.fn(async (input: Record<string, unknown>) => {
    state.opens.push(input);
    return { ok: true, bounty_id: "b-1", status: "open" };
  }),
  withdrawBounty: vi.fn(),
  getBountyById: vi.fn(async () => ({ id: "b-1", posted_by_grant_id: "g-1" })),
  getLiveBountyForClaim: vi.fn(async () => null),
  formatOwls: (micro: number) => `${micro / 1_000_000} owls`,
}));

import { runGrantmakerTurn, PLATFORM_FUNDER_SECTION } from "../../../src/llm/agents/grantmaker.js";

const transcript = [{ role: "user" as const, content: "Fund work on AI lab safety." }];

beforeEach(() => {
  state.system = [];
  state.toolNames = [];
  state.confirmResult = "";
  state.opens = [];
});

describe("a platform funder", () => {
  it("is named to the Grantmaker as Minerval, owed no deference", async () => {
    await runGrantmakerTurn({ transcript, funder: "platform" });
    expect(state.system[0]).toContain(PLATFORM_FUNDER_SECTION);
    expect(PLATFORM_FUNDER_SECTION).toMatch(/gets no deference/);
    expect(PLATFORM_FUNDER_SECTION).toMatch(/This conversation is public/);
    // Drafting and declining work exactly as for anyone.
    expect(state.toolNames).toEqual(expect.arrayContaining(["propose_mandate", "decline_mandate"]));
  });

  it("is not mentioned for a person's conversation", async () => {
    await runGrantmakerTurn({ transcript });
    expect(state.system[0]).not.toContain("This funder is Minerval");
  });
});

describe("bounty confirmation in the management chat", () => {
  it("is the funder's on a person's mandate", async () => {
    await runGrantmakerTurn({ transcript, grantId: "g-1" });
    expect(JSON.parse(state.confirmResult)).toMatchObject({ success: true });
    expect(state.opens[0]).toMatchObject({ bountyId: "b-1", confirmedBy: "founder:management_chat" });
  });

  it("is refused on a platform mandate: that confirmation is the operator key's", async () => {
    await runGrantmakerTurn({ transcript, grantId: "g-1", funder: "platform" });
    expect(JSON.parse(state.confirmResult)).toMatchObject({ success: false });
    expect(state.opens).toHaveLength(0);
  });
});
