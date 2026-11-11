/**
 * Run visibility (llm/run-visibility.ts): a run's private reasons, recorded
 * on agent_runs as it goes. Real runs under withAgent with tracing on.
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.TRACE_LEVEL = "full";
});

import { rawQuery } from "../../src/db/client.js";
import { getUsageContext, markCurrentRunPrivate, withAgent } from "../../src/llm/usage-context.js";

async function reasons(runId: string): Promise<string[] | null> {
  for (let i = 0; i < 50; i++) {
    const [row] = await rawQuery<{ private_reasons: string[]; finished_at: Date | null }>(
      `SELECT private_reasons, finished_at FROM agent_runs WHERE id = $1`,
      [runId]
    );
    if (row?.finished_at) {
      await new Promise((r) => setTimeout(r, 50)); // let fire-and-forget marks land
      const [again] = await rawQuery<{ private_reasons: string[] }>(
        `SELECT private_reasons FROM agent_runs WHERE id = $1`,
        [runId]
      );
      return again!.private_reasons;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe("run visibility", () => {
  it("leaves a run of a public agent public", async () => {
    const runId = await withAgent("steward", async () => getUsageContext().runId!);
    expect(await reasons(runId)).toEqual([]);
  });

  it("starts a run of a private agent private, and an unclassified agent too", async () => {
    const grantmaker = await withAgent("grantmaker", async () => getUsageContext().runId!);
    const unknown = await withAgent("not_an_agent", async () => getUsageContext().runId!);
    expect(await reasons(grantmaker)).toEqual(["agent:grantmaker"]);
    expect(await reasons(unknown)).toEqual(["agent:not_an_agent:unclassified"]);
  });

  it("records each reason once, however often it is marked", async () => {
    const runId = await withAgent("researcher", async () => {
      markCurrentRunPrivate("input:grantmaker-brief");
      markCurrentRunPrivate("input:grantmaker-brief");
      markCurrentRunPrivate("tool:grant_overview");
      return getUsageContext().runId!;
    });
    expect((await reasons(runId))!.sort()).toEqual(["input:grantmaker-brief", "tool:grant_overview"]);
  });
});
