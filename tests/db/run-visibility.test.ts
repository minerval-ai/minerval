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

/**
 * The run's private reasons once the run has finished and every reason in
 * `expect` has landed. Each mark is written fire-and-forget, so it can land
 * after the run is stamped finished; reading after a fixed delay raced the
 * writes on a busy runner (#874's CI). The run's own reasons are what the
 * test then compares, duplicates included, so a reason written twice still
 * fails it. Null when the run never finished.
 */
async function reasons(runId: string, expect: readonly string[] = []): Promise<string[] | null> {
  let last: { private_reasons: string[]; finished_at: Date | null } | undefined;
  for (let i = 0; i < 150; i++) {
    [last] = await rawQuery<{ private_reasons: string[]; finished_at: Date | null }>(
      `SELECT private_reasons, finished_at FROM agent_runs WHERE id = $1`,
      [runId]
    );
    if (last?.finished_at && expect.every((r) => last!.private_reasons.includes(r))) return last.private_reasons;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last?.finished_at ? last.private_reasons : null;
}

describe("run visibility", () => {
  it("leaves a run of a public agent public", async () => {
    const runId = await withAgent("steward", async () => getUsageContext().runId!);
    expect(await reasons(runId)).toEqual([]);
  });

  it("starts a run of a private agent private, and an unclassified agent too", async () => {
    const grantmaker = await withAgent("grantmaker", async () => getUsageContext().runId!);
    const unknown = await withAgent("not_an_agent", async () => getUsageContext().runId!);
    expect(await reasons(grantmaker, ["agent:grantmaker"])).toEqual(["agent:grantmaker"]);
    expect(await reasons(unknown, ["agent:not_an_agent:unclassified"])).toEqual(["agent:not_an_agent:unclassified"]);
  });

  it("records each reason once, however often it is marked", async () => {
    const runId = await withAgent("researcher", async () => {
      markCurrentRunPrivate("input:grantmaker-brief");
      markCurrentRunPrivate("input:grantmaker-brief");
      markCurrentRunPrivate("tool:grant_overview");
      return getUsageContext().runId!;
    });
    const expected = ["input:grantmaker-brief", "tool:grant_overview"];
    expect((await reasons(runId, expected))!.sort()).toEqual(expected);
  });
});
