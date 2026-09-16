/**
 * get_claim_with_context tells "never worked" from "worked and judged
 * childless" (#415). decomposition_status becomes "complete" at onboarding,
 * before any Steward run, so the payload must also carry the Steward queue
 * state for a reader to know whether the empty structure is a judgment.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { executeGovernanceTool } from "../../src/llm/tools/governance-tools.js";

async function context(claimId: string) {
  return JSON.parse(
    await executeGovernanceTool("get_claim_with_context", { claim_id: claimId })
  );
}

describe("get_claim_with_context steward state (#415)", () => {
  it("shows an onboarded but never-stewarded claim as pending with no stewarded_at", async () => {
    const id = await seedClaim("onboarded");
    await rawQuery(
      `UPDATE claims SET decomposition_status = 'complete', importance = 0.85 WHERE id = $1`,
      [id]
    );

    const out = await context(id);
    expect(out.claim.decomposition_status).toBe("complete");
    expect(out.claim.children_total).toBe(0);
    expect(out.current_assessment).toBeNull();
    expect(out.claim.steward_state).toBe("pending");
    expect(out.claim.stewarded_at).toBeNull();
  });

  it("shows a stewarded claim as done with the run time", async () => {
    const id = await seedClaim("stewarded");
    await rawQuery(
      `UPDATE claims SET decomposition_status = 'complete', steward_state = 'done',
              stewarded_at = '2026-09-01T12:00:00Z' WHERE id = $1`,
      [id]
    );

    const out = await context(id);
    expect(out.claim.steward_state).toBe("done");
    expect(out.claim.stewarded_at).toBe("2026-09-01T12:00:00.000Z");
  });
});
