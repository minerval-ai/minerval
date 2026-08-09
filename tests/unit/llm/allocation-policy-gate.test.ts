import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Who may amend an allocation policy, and on what grounds.
 *
 * The gate used to be an identity check — "is this THE platform General
 * mandate?" — which made the formula a platform privilege rather than a
 * kind of mandate. It is now a capability check on the mandate's policy:
 * the knobs are read wherever the formula valuer computes valuations, so
 * they are live for any formula mandate and inert for a mandate that values
 * by its own judgment. The refusal survives because it is still a refusal
 * where the write would do nothing, not because General is special.
 *
 * One implementation serves both callers (the owner-driven Grantmaker chat
 * and the autonomous review pass), so this is the gate on both paths.
 */

const { state } = vi.hoisted(() => ({
  state: {
    policy: "general" as string | null,
    updateCalls: [] as Array<{ grantId: string; updates: unknown }>,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("SELECT policy FROM grants")) {
      return state.policy === null ? [] : [{ policy: state.policy }];
    }
    void params;
    return [];
  }),
}));

vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  updateAllocationPolicy: vi.fn(
    async (grantId: string, updates: Record<string, unknown>) => {
      state.updateCalls.push({ grantId, updates });
      return { ok: true, changed: updates, policy: { contestation_floor: 0.4 } };
    }
  ),
}));

import { executeManagementTool } from "../../../src/llm/agents/grantmaker.js";

beforeEach(() => {
  state.policy = "general";
  state.updateCalls = [];
});

describe("update_allocation_policy gate", () => {
  it("lets a formula mandate amend its own knobs", async () => {
    const out = await executeManagementTool("g-formula", "update_allocation_policy", {
      updates: { contestation_floor: 0.4 },
      note: "Uncontested load-bearing claims were starving at the old floor.",
    });
    const parsed = JSON.parse(out!);
    expect(parsed.success).toBe(true);
    expect(parsed.changed).toEqual({ contestation_floor: 0.4 });
    expect(state.updateCalls).toEqual([
      { grantId: "g-formula", updates: { contestation_floor: 0.4 } },
    ]);
  });

  it("is not restricted to the platform's own mandate: any formula mandate qualifies", async () => {
    // The old identity check refused this one purely for not being General.
    await executeManagementTool("g-someone-elses", "update_allocation_policy", {
      updates: { staleness_base_days: 45 },
      note: "This territory moves faster than the default cadence assumes.",
    });
    expect(state.updateCalls.map((c) => c.grantId)).toEqual(["g-someone-elses"]);
  });

  it("refuses a judgment mandate, and says which lever is really theirs", async () => {
    state.policy = "cover";
    const parsed = JSON.parse(
      (await executeManagementTool("g-topical", "update_allocation_policy", {
        updates: { contestation_floor: 0.9 },
        note: "Trying the formula.",
      }))!
    );
    expect(parsed.success).toBe(false);
    expect(parsed.problem).toContain("set_valuations");
    // The point of the refusal: no write happened, so nothing was claimed
    // to have taken effect.
    expect(state.updateCalls).toEqual([]);
  });

  it("refuses a mandate that no longer exists rather than writing", async () => {
    state.policy = null;
    const parsed = JSON.parse(
      (await executeManagementTool("g-gone", "update_allocation_policy", {
        updates: { contestation_floor: 0.5 },
        note: "n/a",
      }))!
    );
    expect(parsed.success).toBe(false);
    expect(state.updateCalls).toEqual([]);
  });

  it("requires a note: the public record of why the formula changed", async () => {
    const parsed = JSON.parse(
      (await executeManagementTool("g-formula", "update_allocation_policy", {
        updates: { contestation_floor: 0.4 },
        note: "   ",
      }))!
    );
    expect(parsed.success).toBe(false);
    expect(parsed.problem).toContain("note");
    expect(state.updateCalls).toEqual([]);
  });

  it("returns null for a tool it does not own", async () => {
    expect(
      await executeManagementTool("g-formula", "set_valuations", {})
    ).toBeNull();
  });
});
