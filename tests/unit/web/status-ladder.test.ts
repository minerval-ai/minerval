import { describe, it, expect } from "vitest";

// The evidential status ladder on the web side (#524): the six statuses,
// the retired tokens archived recordings still carry, the effect each status
// has on a parent, and dispute read from contestation, never from status.
import {
  STATUS, STATUS_ORDER, RETIRED_STATUS, isStatus, normalizeStatus, statusMeta,
  disputeLevel, disputeMeta, DISPUTE_ACTIVE_AT, DISPUTE_SHOWN_AT,
  topLevelEffects,
} from "../../../web/lib/ontology";
import type { TreeNode } from "../../../web/lib/types";
import { assessmentStatusEnum } from "../../../src/schemas/common";

function node(over: Partial<TreeNode> = {}): TreeNode {
  return {
    id: `n-${Math.random()}`,
    text: "a claim",
    claim_type: "empirical_verifiable",
    state: "active",
    depth: 1,
    relation_type: "supports",
    reasoning: null,
    confidence: null,
    assessment_status: null,
    assessment_confidence: null,
    argument_id: null,
    argument_name: null,
    argument_stance: null,
    children: [],
    ...over,
  };
}

describe("status vocabulary", () => {
  it("matches the API enum, in ladder order", () => {
    expect(STATUS_ORDER).toEqual(assessmentStatusEnum.options);
    expect(Object.keys(STATUS).sort()).toEqual([...assessmentStatusEnum.options].sort());
  });

  it("has dropped contested and unsupported from the API enum", () => {
    expect(assessmentStatusEnum.safeParse("contested").success).toBe(false);
    expect(assessmentStatusEnum.safeParse("unsupported").success).toBe(false);
    expect(assessmentStatusEnum.safeParse("inconclusive").success).toBe(true);
    expect(assessmentStatusEnum.safeParse("doubtful").success).toBe(true);
  });

  it("labels the new statuses with the constitution's definitions", () => {
    expect(STATUS.inconclusive.label).toBe("Inconclusive");
    expect(STATUS.inconclusive.def).toMatch(/do not come down on either side/);
    expect(STATUS.doubtful.label).toBe("Doubtful");
    expect(STATUS.doubtful.def).toMatch(/weighs against the claim, but the examination is incomplete/);
  });

  it("reads retired statuses through the migration's provisional mapping", () => {
    expect(isStatus("contested")).toBe(false);
    expect(normalizeStatus("contested")).toBe("inconclusive");
    expect(normalizeStatus("unsupported")).toBe("unknown");
    expect(statusMeta("contested").label).toBe("Inconclusive");
    expect(RETIRED_STATUS).toEqual({ contested: "inconclusive", unsupported: "unknown" });
  });

  it("falls back to unknown for anything else, including prototype keys", () => {
    expect(normalizeStatus("probably")).toBe("unknown");
    expect(normalizeStatus(null)).toBe("unknown");
    expect(normalizeStatus("toString")).toBe("unknown");
  });
});

describe("effect on the parent", () => {
  it("scores doubtful as against, the mirror of supported", () => {
    const scored = topLevelEffects(node({
      depth: 0, relation_type: null,
      children: [
        node({ assessment_status: "supported" }),
        node({ assessment_status: "doubtful" }),
        node({ assessment_status: "doubtful", relation_type: "contradicts" }),
        node({ assessment_status: "inconclusive" }),
        node({ assessment_status: "unknown" }),
      ],
    }));
    expect(scored.map((s) => s.effect)).toEqual(["supports", "against", "supports", "uncertain", "weak"]);
  });

  it("scores a retired status in an archived recording as its mapping", () => {
    const scored = topLevelEffects(node({
      depth: 0, relation_type: null,
      children: [
        node({ assessment_status: "contested" as never }),
        node({ assessment_status: "unsupported" as never }),
      ],
    }));
    expect(scored.map((s) => s.effect)).toEqual(["uncertain", "weak"]);
  });
});

describe("dispute beside the verdict", () => {
  it("shows nothing without a recorded contestation or below the threshold", () => {
    expect(disputeLevel(null)).toBeNull();
    expect(disputeLevel(undefined)).toBeNull();
    expect(disputeLevel(Number.NaN)).toBeNull();
    expect(disputeLevel(0)).toBeNull();
    expect(disputeLevel(DISPUTE_SHOWN_AT - 0.01)).toBeNull();
    expect(disputeMeta(0.1)).toBeNull();
  });

  it("reads disputed from the lower threshold and actively disputed from the upper", () => {
    expect(DISPUTE_SHOWN_AT).toBe(0.3);
    expect(DISPUTE_ACTIVE_AT).toBe(0.6);
    expect(disputeLevel(0.3)).toBe("some");
    expect(disputeLevel(0.59)).toBe("some");
    expect(disputeLevel(0.6)).toBe("active");
    expect(disputeLevel(1)).toBe("active");
    expect(disputeMeta(0.75)?.label).toBe("actively disputed");
    expect(disputeMeta(0.45)?.label).toBe("disputed");
  });

  it("is independent of the status: a doubtful claim can be actively disputed", () => {
    // The issue's example, "Doubtful · actively disputed": the two facts come
    // from different fields and neither is derived from the other.
    expect(statusMeta("doubtful").label).toBe("Doubtful");
    expect(disputeMeta(0.8)?.label).toBe("actively disputed");
  });
});
