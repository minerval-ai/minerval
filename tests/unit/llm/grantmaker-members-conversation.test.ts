/**
 * Who the Grantmaker is told reads its conversation (#1120). On the public
 * graph, anyone. In a private deployment, the members who read the
 * mandate's label and nobody outside: "anyone may read this" is false
 * there, at the label called `public` as at any other.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ system: [] as string[], membersOnly: false }));

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: { system: string[] }) => {
    state.system = opts.system;
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
vi.mock("../../../src/permissions.js", async (original) => ({
  ...(await original<typeof import("../../../src/permissions.js")>()),
  membersOnly: () => state.membersOnly,
}));

import { runGrantmakerTurn } from "../../../src/llm/agents/grantmaker.js";
import {
  MEMBERS_CONVERSATION_SECTION,
  PUBLIC_CONVERSATION_SECTION,
} from "../../../src/llm/prompts/grantmaker.js";

const transcript = [{ role: "user" as const, content: "Fund work on our supplier contracts." }];

beforeEach(() => {
  state.system = [];
  state.membersOnly = false;
});

describe("who the Grantmaker is told reads its conversation", () => {
  it("is anyone, on the public graph", async () => {
    await runGrantmakerTurn({ transcript });
    expect(state.system[0]).toContain(PUBLIC_CONVERSATION_SECTION);
    expect(state.system[0]).not.toContain(MEMBERS_CONVERSATION_SECTION);
  });

  it("is the members who read the mandate's label, in a private deployment", async () => {
    state.membersOnly = true;
    await runGrantmakerTurn({ transcript });
    expect(state.system[0]).toContain(MEMBERS_CONVERSATION_SECTION);
    expect(state.system[0]).not.toContain(PUBLIC_CONVERSATION_SECTION);
    expect(state.system[0]).not.toContain("Anyone may read this conversation");
  });

  it("says so with the reason, and that nothing reaches the public graph unreleased", () => {
    expect(MEMBERS_CONVERSATION_SECTION).toMatch(/Nobody outside the\s+deployment can/);
    expect(MEMBERS_CONVERSATION_SECTION).toMatch(/talking to\s+you directs its money/);
    expect(MEMBERS_CONVERSATION_SECTION).toMatch(/releases a page through the gate to outside/);
  });
});
