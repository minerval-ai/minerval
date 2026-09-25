import { describe, it, expect, vi, beforeEach } from "vitest";

// The research run service (#298) over a mocked DB: tier resolution from
// config, the daily cap against the durable meter, the pause flag's
// accepted shapes, and the SQL the notebook and the close use.

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
  getDb: () => {
    throw new Error("research-run-service must not use getDb");
  },
}));
vi.mock("../../../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config.js")>();
  return {
    ...original,
    loadConfig: () => ({
      ...original.loadConfig(),
      researcherStrongModel: "claude-fable-5-1",
      researcherStandardModel: "claude-sonnet-5",
      researcherCheapModel: "z-ai/glm-5.3-flash",
      researcherDailyCapOwls: 2,
      owlCostMicroUsd: 1_000_000,
    }),
  };
});

import { LlmBudgetExceededError } from "../../../src/llm/errors.js";
import {
  checkResearcherBudget,
  closeResearchRun,
  modelForTier,
  readResearcherPaused,
  writeResearchNotebookSection,
} from "../../../src/services/research-run-service.js";

beforeEach(() => mocks.rawQuery.mockReset().mockResolvedValue([]));

describe("modelForTier", () => {
  it("resolves each tier from config", () => {
    expect(modelForTier("strong")).toBe("claude-fable-5-1");
    expect(modelForTier("standard")).toBe("claude-sonnet-5");
    expect(modelForTier("cheap")).toBe("z-ai/glm-5.3-flash");
  });
});

describe("checkResearcherBudget", () => {
  it("admits a run that fits under today's cap and refuses one that would exceed it", async () => {
    mocks.rawQuery.mockResolvedValue([{ spent: "1500000" }]);
    await expect(checkResearcherBudget(400_000)).resolves.toBeUndefined();
    await expect(checkResearcherBudget(600_000)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    const sql = mocks.rawQuery.mock.calls[0]![0] as string;
    expect(sql).toMatch(/FROM llm_usage/);
    expect(mocks.rawQuery.mock.calls[0]![1]).toEqual(["researcher"]);
  });
});

describe("readResearcherPaused", () => {
  it("accepts a boolean, a string, or an object flag", async () => {
    expect(await readResearcherPaused()).toBe(false);
    mocks.rawQuery.mockResolvedValueOnce([{ value: true }]);
    expect(await readResearcherPaused()).toBe(true);
    mocks.rawQuery.mockResolvedValueOnce([{ value: "true" }]);
    expect(await readResearcherPaused()).toBe(true);
    mocks.rawQuery.mockResolvedValueOnce([{ value: { paused: true } }]);
    expect(await readResearcherPaused()).toBe(true);
    mocks.rawQuery.mockResolvedValueOnce([{ value: { paused: false } }]);
    expect(await readResearcherPaused()).toBe(false);
  });
});

describe("writes", () => {
  it("writes a notebook section in place and closes a run with its report", async () => {
    await writeResearchNotebookSection("run-1", "thread", "text");
    expect(mocks.rawQuery.mock.calls[0]![0]).toMatch(/jsonb_set/);
    expect(mocks.rawQuery.mock.calls[0]![1]).toEqual(["run-1", "thread", "text"]);

    mocks.rawQuery.mockResolvedValueOnce([
      {
        id: "run-1",
        status: "budget",
        report: null,
        ceiling_micro_usd: "10",
        spent_micro_usd: "7",
        turns: "3",
        tools: null,
        notebook: null,
      },
    ]);
    const closed = await closeResearchRun("run-1", {
      status: "budget",
      report: null,
      spentMicroUsd: 7.4,
      error: "ceiling",
    });
    expect(closed).toMatchObject({ id: "run-1", status: "budget", spent_micro_usd: 7, turns: 3, tools: [], notebook: {} });
    const params = mocks.rawQuery.mock.calls[1]![1] as unknown[];
    expect(params.slice(0, 4)).toEqual(["run-1", "budget", null, 7]);
    expect(params[6]).toBe("ceiling");
  });
});
