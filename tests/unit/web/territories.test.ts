import { describe, it, expect } from "vitest";

// The /claims overview cards (#206). A territory may now be anchored on a
// question node: its stats carry the question's standing where a claim's
// status would sit, and the subtree tally still counts the claims beneath it.
import { TERRITORIES, computeTerritoryStats, territoryHref } from "../../../web/lib/territories";
import type { ClaimDetail, TreeNode } from "../../../web/lib/types";

const node = (id: string, status: TreeNode["assessment_status"], children: TreeNode[] = []): TreeNode =>
  ({ id, text: id, assessment_status: status, children } as unknown as TreeNode);

describe("territories", () => {
  it("keys and anchors are unique", () => {
    expect(new Set(TERRITORIES.map((t) => t.key)).size).toBe(TERRITORIES.length);
    expect(new Set(TERRITORIES.map((t) => t.anchorId)).size).toBe(TERRITORIES.length);
  });

  it("every card has a question to show: its own line, or a question anchor", () => {
    for (const t of TERRITORIES) expect(Boolean(t.question) || t.anchorKind === "question").toBe(true);
  });

  it("a question anchor carries its standing, not a status", () => {
    const detail = {
      claim: { id: "q", kind: "question", text: "Why?" },
      assessment: null,
      question: { standing: "leaning" },
      tree: node("q", null, [node("a", "supported"), node("b", "doubtful", [node("a", "supported")])]),
    } as unknown as ClaimDetail;
    const s = computeTerritoryStats(detail);
    expect(s).toMatchObject({ isQuestion: true, coreStanding: "leaning", coreStatus: null, coreText: "Why?" });
    expect(s.assessedCount).toBe(2);
    expect(s.totalCount).toBe(3);
  });

  it("a claim anchor carries no standing", () => {
    const detail = {
      claim: { id: "c", text: "C" },
      assessment: { status: "supported" },
      tree: node("c", "supported"),
    } as unknown as ClaimDetail;
    const s = computeTerritoryStats(detail);
    expect(s.isQuestion).toBeUndefined();
    expect(s.coreStatus).toBe("supported");
  });

  it("an anchored card opens its map", () => {
    expect(territoryHref(TERRITORIES[0])).toBe(`/claims/${TERRITORIES[0].anchorId}/map`);
  });
});
