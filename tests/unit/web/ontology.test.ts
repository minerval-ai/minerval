import { describe, it, expect } from "vitest";

// The web-side effect model (issue #189): every decomposition node is scored
// by its effect on the ROOT claim, composing edge polarity down the tree.
// The load-bearing distinctions under test: "unassessed" is its own state,
// never folded into "unsettled" (pending is not a finding), and every scored
// node carries the structural lean of its edge chain so surfaces can render
// a queued side's direction without dressing it up as a verdict.
import {
  decompositionEffects, topLevelEffects, effectCounts, netEffect,
  groupByArgument, type Effect,
} from "../../../web/lib/ontology";
import type { TreeNode } from "../../../web/lib/types";

let seq = 0;
function node(over: Partial<TreeNode> = {}): TreeNode {
  return {
    id: `node-${++seq}`,
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

function root(children: TreeNode[]): TreeNode {
  return node({ depth: 0, relation_type: null, children });
}

const zero: Record<Effect, number> = {
  supports: 0, against: 0, uncertain: 0, weak: 0, unassessed: 0,
};

describe("topLevelEffects", () => {
  it("scores an unassessed child as unassessed, not unsettled", () => {
    const [s] = topLevelEffects(root([node({ assessment_status: null })]));
    expect(s.effect).toBe("unassessed");
  });

  it("keeps unsettled for assessed-but-inconclusive statuses", () => {
    const scored = topLevelEffects(root([
      node({ assessment_status: "unknown" }),
      node({ assessment_status: "unsupported" }),
    ]));
    expect(scored.map((s) => s.effect)).toEqual(["weak", "weak"]);
  });

  it("composes edge polarity with the node's own status", () => {
    const scored = topLevelEffects(root([
      node({ assessment_status: "verified" }),
      node({ assessment_status: "verified", relation_type: "contradicts" }),
      node({ assessment_status: "contradicted", relation_type: "contradicts" }),
      node({ assessment_status: "contested" }),
    ]));
    expect(scored.map((s) => s.effect)).toEqual([
      "supports", "against", "supports", "uncertain",
    ]);
  });

  it("gives every node the structural lean of its edge, assessed or not", () => {
    const scored = topLevelEffects(root([
      node({ assessment_status: null }),
      node({ assessment_status: null, relation_type: "contradicts" }),
      node({ assessment_status: "verified", relation_type: "contradicts" }),
    ]));
    expect(scored.map((s) => s.lean)).toEqual(["for", "against", "against"]);
  });
});

describe("decompositionEffects", () => {
  it("flips the sign at each contradicts edge down the tree", () => {
    // against-the-parent, whose own contradicting premise bears FOR the root
    const grandchild = node({ assessment_status: "verified", relation_type: "contradicts" });
    const child = node({
      assessment_status: null, relation_type: "contradicts", children: [grandchild],
    });
    const scored = decompositionEffects(root([child]));
    expect(scored).toHaveLength(2);
    expect(scored[0]).toMatchObject({ effect: "unassessed", lean: "against" });
    expect(scored[1]).toMatchObject({ effect: "supports", lean: "for" });
  });
});

describe("netEffect", () => {
  it("follows the assessed majority", () => {
    expect(netEffect({ ...zero, supports: 2, against: 1 })).toBe("supports");
    expect(netEffect({ ...zero, against: 2, supports: 1, unassessed: 4 })).toBe("against");
  });

  it("reads a genuine split as contested", () => {
    expect(netEffect({ ...zero, supports: 1, against: 1 })).toBe("uncertain");
    expect(netEffect({ ...zero, uncertain: 2 })).toBe("uncertain");
  });

  it("reads assessed-but-inconclusive as unsettled, even beside queued nodes", () => {
    expect(netEffect({ ...zero, weak: 1, unassessed: 3 })).toBe("weak");
  });

  it("reads an entirely unassessed line of reasoning as unassessed", () => {
    expect(netEffect({ ...zero, unassessed: 3 })).toBe("unassessed");
  });
});

describe("effectCounts / groupByArgument", () => {
  it("counts unassessed as its own bucket", () => {
    const counts = effectCounts(topLevelEffects(root([
      node({ assessment_status: "supported" }),
      node({ assessment_status: null }),
      node({ assessment_status: null, relation_type: "contradicts" }),
    ])));
    expect(counts).toEqual({ ...zero, supports: 1, unassessed: 2 });
  });

  it("nets a fully queued argument as unassessed, not unsettled", () => {
    const groups = groupByArgument(topLevelEffects(root([
      node({ argument_id: "a1", argument_name: "The queued case", assessment_status: null }),
      node({ argument_id: "a1", argument_name: "The queued case", assessment_status: null }),
      node({ assessment_status: "contradicted" }),
    ])));
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ named: true, net: "unassessed" });
    // the argument-less remainder collects into the single basis group
    expect(groups[1]).toMatchObject({ id: null, named: false, net: "against" });
  });
});
