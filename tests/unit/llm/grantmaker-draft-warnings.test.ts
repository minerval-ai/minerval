/**
 * The Grantmaker's draft as a funder's agent reads it: the warnings it
 * records travel with the draft (with the ones the draft implies), each
 * plan item says the draft added it, and every tool the turn calls is
 * reported as it is called, for the caller waiting on the reply.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
  results: [] as string[],
  schema: null as Record<string, unknown> | null,
}));

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: {
    tools: Array<{ name: string; input_schema?: Record<string, unknown> }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
    state.schema = opts.tools.find((t) => t.name === "propose_mandate")?.input_schema ?? null;
    for (const call of state.calls) state.results.push(await opts.executeTool(call.name, call.input));
    return { content: "Here is the draft." };
  }),
}));
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
  withTransaction: vi.fn(),
}));
vi.mock("../../../src/llm/agents/skill-selection.js", () => ({
  skillsForGrant: vi.fn(async () => []),
}));

import { runGrantmakerTurn } from "../../../src/llm/agents/grantmaker.js";

const transcript = [{ role: "user" as const, content: "Fund work on charter school outcomes." }];

const draft = {
  title: "Charter school outcomes",
  objective: "Assess what the evidence says about charter school outcomes.",
  funder_named: false,
  funder_stake: "I chair a charter network's board.",
  plan: { strategy: "Read the reviews first.", items: [{ action: "ingest", url: "https://x.test/review", rationale: "the main review" }] },
  expected_cost_owls: 40,
};

beforeEach(() => {
  state.calls = [];
  state.results = [];
  state.schema = null;
});

describe("a drafted mandate", () => {
  it("carries the Grantmaker's warnings and the ones the draft implies, and its items say who added them", async () => {
    state.calls = [
      {
        name: "propose_mandate",
        input: { ...draft, warnings: [{ about: "cost", text: "The quote may well run over." }] },
      },
    ];
    const steps: string[] = [];
    const turn = await runGrantmakerTurn({ transcript, onTool: (name) => steps.push(name) });
    expect(steps).toEqual(["propose_mandate"]);
    expect(turn.mandate!.warnings).toEqual([
      expect.objectContaining({ about: "cost", text: "The quote may well run over.", raised_by: "grantmaker" }),
    ]);
    expect(turn.mandate!.plan.items[0]).toMatchObject({ added_by: "grantmaker_draft", added_at: expect.any(String) });
    // The tool's answer names both warnings, so the reply can say them.
    const result = JSON.parse(state.results[0]!);
    expect(result.warnings.map((w: { about: string }) => w.about)).toEqual(["identity", "cost"]);
    expect((state.schema!.properties as Record<string, unknown>).warnings).toBeDefined();
  });

  it("refuses warnings it could not show a funder", async () => {
    state.calls = [{ name: "propose_mandate", input: { ...draft, warnings: [{ about: "cost", text: "" }] } }];
    const turn = await runGrantmakerTurn({ transcript });
    expect(turn.mandate).toBeUndefined();
    expect(JSON.parse(state.results[0]!)).toMatchObject({ success: false });
  });
});
