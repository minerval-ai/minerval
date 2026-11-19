/**
 * Trying the Redactor (src/services/redactor-trial-service.ts), end to end
 * with the model scripted: the run is at the label the boundary's pages are
 * written at, paid from the person's balance within the budget they named
 * and settled to what it cost, and nothing is released, recorded at the
 * gate or saved as a policy.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const seen: { label?: string; budget?: number; task?: string } = {};
vi.mock("../../src/llm/client.js", async (original) => {
  const real = await original<typeof import("../../src/llm/client.js")>();
  return {
    ...real,
    toolUseLoop: vi.fn(async (options: Parameters<typeof real.toolUseLoop>[0]) => {
      const { currentLabel, runBudget } = await import("../../src/llm/usage-context.js");
      seen.label = currentLabel() ?? undefined;
      seen.budget = runBudget()?.ceilingMicroUsd;
      seen.task = String(options.initialMessages[0]!.content);
      await options.executeTool("get_redaction_policy", {});
      await options.executeTool("redact", { part: 1, passage: "8,812,400", category: "commercial figures", note: "An account balance." });
      await options.executeTool("refer_to_person", { part: 2, recommends: "hold", note: "Whether the matter is public is a close call." });
      await options.executeTool("finish_redaction", { least_sure: [] });
      return { content: "", toolCalls: [], iterations: 4, usage: {} } as never;
    }),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { ensureBoundaryPolicy } from "../../src/services/redaction-policy.js";
import { TrialError, tryTheRedactor } from "../../src/services/redactor-trial-service.js";
import { owlsToMicroUsd } from "../../src/services/owl.js";
import { creditOwls, owlBalance } from "./helpers.js";
import { A, seedUser, system, unwall, wall } from "./review-3-common.js";

let user: string;
let gateId: string;

beforeAll(async () => {
  await wall();
  user = await seedUser();
  await creditOwls(user, owlsToMicroUsd(50));
  gateId = (await system(() => ensureBoundaryPolicy({ from: A, to: null }))).boundary_id;
}, 120_000);

afterAll(async () => {
  await unwall();
});

describe("trying the Redactor", () => {
  it("runs at the boundary's label under the budget named, shows what it did, and releases, records and saves nothing", async () => {
    const before = await owlBalance(user);
    const versions = await system(() => rawQuery(`SELECT 1 FROM redaction_policies WHERE boundary_id = $1`, [gateId]));
    const trial = await tryTheRedactor({
      boundaryId: gateId,
      userId: user,
      text: "The reserve holds 8,812,400 in escrow.\n\nThe matter is not yet public.",
      referWhen: ["Whether a matter is already public"],
      budgetOwls: 2,
    });
    expect(seen.label).toBe(A);
    expect(seen.budget).toBe(owlsToMicroUsd(2));
    expect(seen.task).toMatch(/This is a trial/);
    expect(trial.policy).toMatchObject({ draft: true });
    expect(trial.policy.text).toContain("- Whether a matter is already public");
    expect(trial.outcome.finished).toBe(true);
    expect(trial.outcome.parts[0]!.as_it_would_be_released).toBe("The reserve holds [redacted: commercial figures] in escrow.");
    expect(trial.outcome.parts[1]!.referred).toMatchObject({ recommends: "hold" });
    // The scripted run cost nothing, so the whole budget came back.
    expect(trial.spent_owls).toBe(0);
    expect(await owlBalance(user)).toBe(before);
    // Nothing was saved as a policy, and nothing went to any gate.
    expect(await system(() => rawQuery(`SELECT 1 FROM redaction_policies WHERE boundary_id = $1`, [gateId]))).toHaveLength(versions.length);
    expect(await system(() => rawQuery(`SELECT 1 FROM releases WHERE boundary_id = $1`, [gateId]))).toEqual([]);
  });

  it("refuses a draft a save would refuse, a budget the balance cannot cover, and an empty sample, charging nothing", async () => {
    const before = await owlBalance(user);
    await expect(tryTheRedactor({ boundaryId: gateId, userId: user, text: "x", referWhen: ["Anything embarrassing to the board"], budgetOwls: 1 })).rejects.toMatchObject({ code: "POLICY_REFUSED" });
    await expect(tryTheRedactor({ boundaryId: gateId, userId: user, text: "   ", budgetOwls: 1 })).rejects.toMatchObject({ code: "EMPTY_SAMPLE" });
    const poor = await seedUser();
    await expect(tryTheRedactor({ boundaryId: gateId, userId: poor, text: "Some text.", budgetOwls: 1 })).rejects.toBeInstanceOf(TrialError);
    expect(await owlBalance(user)).toBe(before);
  });
});
