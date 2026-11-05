import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Who may amend an allocation policy, and which keys (#687).
 *
 * The gate is a capability check on the mandate's policy, never on its
 * identity: each mandate may set exactly the keys its own machinery reads
 * (policyKnobs). A formula mandate, General or Governance, reads its
 * formula; a judgment mandate reads its maintenance ceiling and its attempt
 * priors and bounds, so a formula knob is refused there rather than
 * reported as a lever that does nothing.
 *
 * One implementation serves both callers (the owner-driven Grantmaker chat
 * and the autonomous review pass), so this is the gate on both paths.
 */

const { state } = vi.hoisted(() => ({
  state: {
    policy: "general" as string | null,
    updateCalls: [] as Array<{ grantId: string; updates: unknown; allowed: readonly string[] }>,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string) => {
    if (q.includes("SELECT policy FROM grants")) {
      return state.policy === null ? [] : [{ policy: state.policy }];
    }
    return [];
  }),
}));

vi.mock("../../../src/services/allocation-policy-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/services/allocation-policy-service.js")>();
  return {
    ...real,
    updateAllocationPolicy: vi.fn(
      async (grantId: string, updates: Record<string, unknown>, allowed: readonly string[]) => {
        state.updateCalls.push({ grantId, updates, allowed });
        const bad = Object.keys(updates).find((k) => !allowed.includes(k));
        if (bad) return { ok: false, problem: `"${bad}" is read only by a formula this mandate does not run` };
        return { ok: true, changed: Object.keys(updates), policy: { contestation_floor: 0.4, maintenance_share: 0.3 } };
      }
    ),
  };
});

import {
  executeManagementTool,
  getAllocationPolicyToolDefinition,
} from "../../../src/llm/agents/grantmaker.js";
import { isFormulaPolicy, policyKnobs } from "../../../src/services/allocation-policy-service.js";

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
    expect(parsed.changed).toEqual(["contestation_floor"]);
    expect(parsed.policy_in_force.contestation_floor).toBe(0.4);
    expect(state.updateCalls[0]!.grantId).toBe("g-formula");
  });

  it("gives the Governance mandate its audit weights (it used to be refused everything)", async () => {
    state.policy = "governance";
    const parsed = JSON.parse(
      (await executeManagementTool("g-gov", "update_allocation_policy", {
        updates: { audit_value_overturn: 0.9 },
        note: "Overturns have been the most informative audits.",
      }))!
    );
    expect(parsed.success).toBe(true);
    expect(state.updateCalls[0]!.allowed).toContain("audit_value_overturn");
    expect(state.updateCalls[0]!.allowed).not.toContain("contestation_floor");
  });

  it("lets a judgment mandate set its maintenance share, and nothing its allocator never reads", async () => {
    state.policy = "agent";
    const ok = JSON.parse(
      (await executeManagementTool("g-upkeep", "update_allocation_policy", {
        updates: { maintenance_share: 0.6 },
        note: "This mandate's mission is keeping its region clean.",
      }))!
    );
    expect(ok.success).toBe(true);
    expect(ok.policy_in_force).toEqual({ maintenance_share: 0.3 });
    expect(state.updateCalls[0]!.allowed).toEqual(policyKnobs("agent"));

    const refused = JSON.parse(
      (await executeManagementTool("g-upkeep", "update_allocation_policy", {
        updates: { contestation_floor: 0.9 },
        note: "Trying the formula.",
      }))!
    );
    expect(refused.success).toBe(false);
    expect(refused.problem).toContain("set_valuations");
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

  it("requires a note: the public record of why the policy changed", async () => {
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

  it("refuses set_valuations on a formula mandate, whose refresh would overwrite them", async () => {
    state.policy = "governance";
    const parsed = JSON.parse((await executeManagementTool("g-gov", "set_valuations", { entries: [] }))!);
    expect(parsed.success).toBe(false);
    expect(parsed.problem).toContain("update_allocation_policy");
  });

  it("returns null for a tool it does not own", async () => {
    expect(await executeManagementTool("g-formula", "extend_plan", {})).toBeNull();
  });
});

describe("the policy levers, by policy", () => {
  it("one predicate names the formula mandates", () => {
    expect(isFormulaPolicy("general")).toBe(true);
    expect(isFormulaPolicy("governance")).toBe(true);
    expect(isFormulaPolicy("agent")).toBe(false);
    expect(isFormulaPolicy(null)).toBe(false);
  });

  it("describes each mandate's own keys with their bounds and the value in force", () => {
    const judgment = getAllocationPolicyToolDefinition("agent", { maintenance_share: 0.1 });
    expect(judgment.description).toContain("maintenance_share (0 to 1, now 0.1)");
    expect(judgment.description).not.toContain("contestation_floor");
    const gov = getAllocationPolicyToolDefinition("governance", null);
    expect(gov.description).toContain("audit_value_prize (0 to 10)");
    const general = getAllocationPolicyToolDefinition("general", null);
    expect(general.description).toContain("contestation_floor (0 to 1)");
  });
});
