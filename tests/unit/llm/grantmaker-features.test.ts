/**
 * The Grantmaker's tools under features (src/features.ts): with prizes
 * off, the management chat of a live mandate is not offered the bounty
 * tools, and everything else it manages a mandate with is still there.
 * Mathematics off takes prizes with it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({ toolNames: [] as string[] }));

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: { tools: Array<{ name: string }> }) => {
    state.toolNames = opts.tools.map((t) => t.name);
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

const transcript = [{ role: "user" as const, content: "Fund work on the Collatz conjecture." }];
const BOUNTY_TOOLS = ["post_bounty", "withdraw_bounty", "confirm_bounty"];

/** The tools a live mandate's management chat is offered under FEATURES_OFF. */
async function managementTools(featuresOff: string | undefined): Promise<string[]> {
  if (featuresOff === undefined) delete process.env.FEATURES_OFF;
  else process.env.FEATURES_OFF = featuresOff;
  // Config is cached per module instance: each case loads its own.
  vi.resetModules();
  const { runGrantmakerTurn } = await import("../../../src/llm/agents/grantmaker.js");
  await runGrantmakerTurn({ transcript, grantId: "g-1" });
  return state.toolNames;
}

describe("the Grantmaker's bounty tools", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.FEATURES_OFF;
    state.toolNames = [];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.FEATURES_OFF;
    else process.env.FEATURES_OFF = saved;
  });

  it("are offered with everything on", async () => {
    const tools = await managementTools(undefined);
    expect(tools).toEqual(expect.arrayContaining(BOUNTY_TOOLS));
  });

  it("are not offered with prizes off, and nothing else goes", async () => {
    const all = await managementTools(undefined);
    const off = await managementTools("prizes");
    expect(off.filter((name) => BOUNTY_TOOLS.includes(name))).toEqual([]);
    expect(off).toEqual(all.filter((name) => !BOUNTY_TOOLS.includes(name)));
    // The rest of what manages a mandate is untouched.
    expect(off).toEqual(expect.arrayContaining(["adjust_plan", "grant_overview", "cost_sheet"]));
  });

  it("are not offered with mathematics off, which prizes need", async () => {
    const all = await managementTools(undefined);
    const off = await managementTools("mathematics");
    expect(off).toEqual(all.filter((name) => !BOUNTY_TOOLS.includes(name)));
  });

  it("are untouched by the extension being off", async () => {
    const all = await managementTools(undefined);
    expect(await managementTools("extension")).toEqual(all);
  });
});
