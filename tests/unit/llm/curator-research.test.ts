import { describe, it, expect, vi } from "vitest";

/**
 * The Curator may commission research (Part VIII, Instruments): when the
 * researcher is on and the pass has a budget, delegate_research and
 * get_research_run join its toolset, paid from the pass's own budget, and
 * the research it launches reads and reports, writing nothing to the graph.
 */
const mocks = vi.hoisted(() => ({
  loopOptions: [] as Array<Record<string, unknown>>,
  researcherEnabled: true,
}));

vi.mock("../../../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config.js")>();
  return {
    ...original,
    loadConfig: () => ({
      ...original.loadConfig(),
      curatorModel: "curator-model",
      researcherEnabled: mocks.researcherEnabled,
      researcherMaxWallMinutes: 20,
    }),
  };
});

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no database in this test");
  },
  rawQuery: vi.fn(async () => []),
}));

vi.mock("../../../src/llm/agents/skill-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/llm/agents/skill-selection.js")>()),
  domainsForClaim: vi.fn(async () => []),
}));

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (options: Record<string, unknown>) => {
    mocks.loopOptions.push(options);
    return { content: "", toolUses: [], stopReason: "end_turn" };
  }),
}));

import { runCurator } from "../../../src/llm/agents/curator.js";
import { withPassBudget } from "../../../src/llm/usage-context.js";

type Opts = { tools: Array<{ name: string; description?: string }>; system: string[] };

const curate = () =>
  runCurator({ trigger: "merge_candidate", claimId: "aaaaaaaa-0000-4000-8000-000000000001", context: "two formulations" });

describe("Curator research", () => {
  it("offers delegate_research only with a pass budget to pay from, and it writes nothing to the graph", async () => {
    await curate();
    let opts = mocks.loopOptions.at(-1) as unknown as Opts;
    expect(opts.tools.map((t) => t.name)).not.toContain("delegate_research");

    await withPassBudget({ microUsd: 2_000_000, source: "the allocations funding this curation" }, curate);
    opts = mocks.loopOptions.at(-1) as unknown as Opts;
    const names = opts.tools.map((t) => t.name);
    expect(names).toContain("delegate_research");
    expect(names).toContain("get_research_run");
    expect(names).not.toContain("fund_request");
    const delegate = opts.tools.find((t) => t.name === "delegate_research")!;
    expect(delegate.description).toContain("nothing to the graph (it reads and reports");
    expect(delegate.description).toContain("the allocations funding this curation");
    expect(opts.system.join("\n")).toContain("## Delegating research");
  });
});
