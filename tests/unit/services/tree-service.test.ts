import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db client
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(),
}));

import {
  getClaimAncestors,
  getClaimTree,
  getSubclaimCount,
  listClaimDependents,
} from "../../../src/services/tree-service.js";
import { rawQuery } from "../../../src/db/client.js";

const mockRawQuery = vi.mocked(rawQuery);

// Row builders matching the two query shapes getClaimTree issues: one root
// lookup, then one edge query per level (each edge row carries its child's
// node fields).
const rootRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: `Claim ${id}`,
  claim_type: "empirical_derived",
  state: "active",
  assessment_status: null,
  assessment_confidence: null,
  ...over,
});

const edgeRow = (
  parentId: string,
  id: string,
  over: Record<string, unknown> = {}
) => ({
  parent_id: parentId,
  id,
  text: `Claim ${id}`,
  claim_type: "empirical_derived",
  state: "active",
  relation_type: "requires",
  reasoning: null,
  confidence: 1,
  argument_id: null,
  argument_name: null,
  argument_stance: null,
  assessment_status: null,
  assessment_confidence: null,
  ...over,
});

describe("tree-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getClaimTree", () => {
    it("returns null for non-existent claim", async () => {
      mockRawQuery.mockResolvedValueOnce([]);
      const result = await getClaimTree("00000000-0000-0000-0000-000000000001");
      expect(result).toBeNull();
      expect(mockRawQuery).toHaveBeenCalledTimes(1);
    });

    it("assembles a single-node tree", async () => {
      mockRawQuery.mockResolvedValueOnce([
        rootRow("claim-1", {
          text: "Test claim",
          assessment_status: "verified",
          assessment_confidence: 0.9,
        }),
      ]);
      mockRawQuery.mockResolvedValueOnce([]); // level 1: no edges

      const tree = await getClaimTree("claim-1");
      expect(tree).not.toBeNull();
      expect(tree!.id).toBe("claim-1");
      expect(tree!.text).toBe("Test claim");
      expect(tree!.children).toHaveLength(0);
      expect(tree!.assessment_status).toBe("verified");
      // The level query is keyed by the frontier (an id array), not a CTE.
      expect(mockRawQuery.mock.calls[1]![1]).toEqual([["claim-1"]]);
    });

    it("assembles a tree with children, each occurrence carrying its edge", async () => {
      mockRawQuery.mockResolvedValueOnce([rootRow("parent")]);
      mockRawQuery.mockResolvedValueOnce([
        edgeRow("parent", "child-1", {
          relation_type: "requires",
          reasoning: "Because A",
          confidence: 0.95,
          assessment_status: "verified",
          assessment_confidence: 0.85,
        }),
        edgeRow("parent", "child-2", {
          claim_type: "definitional",
          relation_type: "defines",
          reasoning: "Because B",
          confidence: 0.9,
        }),
      ]);
      mockRawQuery.mockResolvedValueOnce([]); // level 2: leaves

      const tree = await getClaimTree("parent");
      expect(tree).not.toBeNull();
      expect(tree!.id).toBe("parent");
      expect(tree!.children).toHaveLength(2);
      expect(tree!.children[0]!.id).toBe("child-1");
      expect(tree!.children[0]!.relation_type).toBe("requires");
      expect(tree!.children[0]!.depth).toBe(1);
      expect(tree!.children[1]!.id).toBe("child-2");
      expect(tree!.children[1]!.relation_type).toBe("defines");
    });

    it("expands a shared subclaim (diamond) once, collapsing later occurrences", async () => {
      // root -> A, root -> B, A -> shared, B -> shared, shared -> leaf.
      // The old per-path CTE duplicated shared's whole subtree under B.
      mockRawQuery.mockResolvedValueOnce([rootRow("root")]);
      mockRawQuery.mockResolvedValueOnce([
        edgeRow("root", "a"),
        edgeRow("root", "b"),
      ]);
      mockRawQuery.mockResolvedValueOnce([
        edgeRow("a", "shared", { relation_type: "supports" }),
        edgeRow("b", "shared", { relation_type: "assumes" }),
      ]);
      mockRawQuery.mockResolvedValueOnce([edgeRow("shared", "leaf")]);
      mockRawQuery.mockResolvedValueOnce([]); // leaf level

      // Explicit depth: this fixture is four levels deep (root → a/b →
      // shared → leaf), and the default is deliberately shallower (3), so
      // the diamond logic is exercised independently of that default.
      const tree = await getClaimTree("root", 5);
      const underA = tree!.children[0]!.children[0]!;
      const underB = tree!.children[1]!.children[0]!;

      // Both occurrences exist, each with its own edge metadata...
      expect(underA.id).toBe("shared");
      expect(underA.relation_type).toBe("supports");
      expect(underB.id).toBe("shared");
      expect(underB.relation_type).toBe("assumes");

      // ...but the subtree is rendered once: the second occurrence is a
      // flagged stub instead of a duplicate of the whole subtree.
      expect(underA.children).toHaveLength(1);
      expect(underA.children[0]!.id).toBe("leaf");
      expect(underA.subtree_collapsed).toBeUndefined();
      expect(underB.children).toHaveLength(0);
      expect(underB.subtree_collapsed).toBe(true);

      // The shared node was fetched (and its children queried) exactly once:
      // root lookup + 4 level queries, no per-path re-expansion.
      expect(mockRawQuery).toHaveBeenCalledTimes(5);
    });

    it("terminates on a relationship cycle instead of expanding to the depth cap", async () => {
      // root -> a -> root (a cycle the DB's self-reference check can't catch).
      mockRawQuery.mockResolvedValueOnce([rootRow("root")]);
      mockRawQuery.mockResolvedValueOnce([edgeRow("root", "a")]);
      mockRawQuery.mockResolvedValueOnce([edgeRow("a", "root")]);

      const tree = await getClaimTree("root");
      const backEdge = tree!.children[0]!.children[0]!;
      expect(backEdge.id).toBe("root");
      expect(backEdge.children).toHaveLength(0);
      expect(backEdge.subtree_collapsed).toBe(true);
      // The walk stopped once every reachable node was visited: root lookup
      // plus two level queries, not maxDepth's worth.
      expect(mockRawQuery).toHaveBeenCalledTimes(3);
    });

    it("caps the node count and flags the parent whose children were dropped", async () => {
      mockRawQuery.mockResolvedValueOnce([rootRow("root")]);
      mockRawQuery.mockResolvedValueOnce([
        edgeRow("root", "c1"),
        edgeRow("root", "c2"),
        edgeRow("root", "c3"),
      ]);
      mockRawQuery.mockResolvedValueOnce([]); // c1's level

      const tree = await getClaimTree("root", 5, 2); // root + 1 child max
      expect(tree!.children).toHaveLength(1);
      expect(tree!.children[0]!.id).toBe("c1");
      expect(tree!.children_truncated).toBe(true);
    });

    it("walks only three levels by default, leaving deeper nodes as leaves", async () => {
      // A chain five levels deep. The default exists to bound what an agent
      // reader pays for in context, so it must stop at 3 without being asked.
      mockRawQuery.mockResolvedValueOnce([rootRow("root")]);
      mockRawQuery.mockResolvedValueOnce([edgeRow("root", "d1")]);
      mockRawQuery.mockResolvedValueOnce([edgeRow("d1", "d2")]);
      mockRawQuery.mockResolvedValueOnce([edgeRow("d2", "d3")]);

      const tree = await getClaimTree("root");

      // Root lookup + exactly three level queries: d3 is fetched, but the
      // level that would expand it is never issued.
      expect(mockRawQuery).toHaveBeenCalledTimes(4);
      const d3 = tree!.children[0]!.children[0]!.children[0]!;
      expect(d3.id).toBe("d3");
      expect(d3.children).toHaveLength(0);
    });
  });

  describe("getClaimAncestors", () => {
    const depRow = (id: string, importance: number) => ({
      id,
      text: `Claim ${id}`,
      claim_type: "causal",
      relation_type: "requires",
      reasoning: `why ${id} leans on it`,
      importance,
      assessment_status: null,
      assessment_confidence: null,
      assessment_credence: null,
    });

    it("walks upward transitively, tagging how far each dependent sits", async () => {
      // leaf <- mid <- top: the weight is two edges up, where one level
      // of dependents cannot see it.
      mockRawQuery.mockResolvedValueOnce([depRow("mid", 0.4)]);
      mockRawQuery.mockResolvedValueOnce([depRow("top", 0.9)]);
      mockRawQuery.mockResolvedValueOnce([]);

      const result = await getClaimAncestors("leaf");

      expect(result.total).toBe(2);
      expect(result.truncated).toBe(false);
      // Ranked by importance, not by distance: the load-bearing one leads.
      expect(result.dependents[0]!.id).toBe("top");
      expect(result.dependents[0]!.depth).toBe(2);
      expect(result.dependents[1]!.id).toBe("mid");
      expect(result.dependents[1]!.depth).toBe(1);
    });

    it("stops at three levels by default", async () => {
      mockRawQuery.mockResolvedValueOnce([depRow("a1", 0.1)]);
      mockRawQuery.mockResolvedValueOnce([depRow("a2", 0.2)]);
      mockRawQuery.mockResolvedValueOnce([depRow("a3", 0.3)]);

      const result = await getClaimAncestors("leaf");

      expect(mockRawQuery).toHaveBeenCalledTimes(3);
      expect(result.dependents.map((d) => d.id).sort()).toEqual(["a1", "a2", "a3"]);
    });

    it("terminates on a cycle instead of revisiting", async () => {
      // leaf <- a <- leaf: the back edge must not re-enter the frontier.
      mockRawQuery.mockResolvedValueOnce([depRow("a", 0.5)]);
      mockRawQuery.mockResolvedValueOnce([depRow("leaf", 0.5)]);

      const result = await getClaimAncestors("leaf");

      expect(mockRawQuery).toHaveBeenCalledTimes(2);
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents[0]!.id).toBe("a");
    });

    it("flags truncation at the node cap rather than dropping rows silently", async () => {
      mockRawQuery.mockResolvedValueOnce([depRow("x", 0.8), depRow("y", 0.7)]);
      // "x" was admitted before the cap bit, so its own level is still walked.
      mockRawQuery.mockResolvedValueOnce([]);

      const result = await getClaimAncestors("leaf", 3, 2); // subject + 1

      expect(result.dependents).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });
  });

  describe("listClaimDependents", () => {
    const row = (id: string, importance: number, total: string) => ({
      id,
      text: `Claim ${id}`,
      claim_type: "causal",
      relation_type: "requires",
      reasoning: `why ${id} leans on the child`,
      importance,
      assessment_status: "contested",
      assessment_confidence: 0.5,
      total,
    });

    it("returns a page plus the window-function total, without the total column", async () => {
      mockRawQuery.mockResolvedValueOnce([row("a", 0.9, "12"), row("b", 0.7, "12")]);

      const result = await listClaimDependents("child-1", { limit: 2, offset: 0 });
      expect(result.total).toBe(12);
      expect(result.dependents).toHaveLength(2);
      expect(result.dependents[0]).not.toHaveProperty("total");
      expect(result.dependents[0]!.importance).toBe(0.9);
      // The per-edge reasoning rides along for the claim-page rail (#199).
      expect(result.dependents[0]!.reasoning).toBe("why a leans on the child");

      // limit/offset are passed through to the query
      expect(mockRawQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT $2 OFFSET $3"),
        ["child-1", 2, 0]
      );
    });

    it("falls back to a bare count when the offset is past the end", async () => {
      mockRawQuery.mockResolvedValueOnce([]); // page query: empty
      mockRawQuery.mockResolvedValueOnce([{ count: "12" }]); // count fallback

      const result = await listClaimDependents("child-1", { limit: 50, offset: 100 });
      expect(result.dependents).toEqual([]);
      expect(result.total).toBe(12);
    });

    it("reports zero total for a claim nothing depends on", async () => {
      mockRawQuery.mockResolvedValueOnce([]);
      mockRawQuery.mockResolvedValueOnce([{ count: "0" }]);

      const result = await listClaimDependents("leaf-1");
      expect(result).toEqual({ dependents: [], total: 0 });
    });

    it("orders by importance before assessment confidence", async () => {
      mockRawQuery.mockResolvedValueOnce([row("a", 0.9, "2")]);
      await listClaimDependents("child-1");
      const sql = mockRawQuery.mock.calls[0]![0] as string;
      expect(sql).toMatch(/ORDER BY c\.importance DESC, a\.confidence DESC NULLS LAST/);
    });
  });

  describe("getSubclaimCount", () => {
    it("returns count of subclaims", async () => {
      mockRawQuery.mockResolvedValueOnce([{ count: "3" }]);
      const count = await getSubclaimCount("claim-1");
      expect(count).toBe(3);
    });

    it("returns 0 when no subclaims", async () => {
      mockRawQuery.mockResolvedValueOnce([{ count: "0" }]);
      const count = await getSubclaimCount("claim-1");
      expect(count).toBe(0);
    });
  });

  // Archived epoch cohorts (and deprecated merge losers) must not surface as
  // tree children or dependents. Only the tree ROOT is fetched regardless of
  // state, so an archived claim stays readable by direct id.
  describe("active-only filtering", () => {
    it("tree walk only descends into active children", async () => {
      mockRawQuery.mockResolvedValueOnce([rootRow("claim-1")]);
      mockRawQuery.mockResolvedValueOnce([]);
      await getClaimTree("claim-1");
      // The root lookup has no state filter (an archived claim stays readable
      // by direct id); the level query filters children to active.
      const rootSql = mockRawQuery.mock.calls[0]![0] as string;
      const levelSql = mockRawQuery.mock.calls[1]![0] as string;
      expect(rootSql).not.toContain("state = 'active'");
      expect(levelSql).toContain("c.state = 'active'");
    });

    it("dependents page and its fallback count both filter to active parents", async () => {
      mockRawQuery.mockResolvedValueOnce([]); // page query → empty
      mockRawQuery.mockResolvedValueOnce([{ count: "0" }]); // fallback count
      await listClaimDependents("child-1");
      const pageSql = mockRawQuery.mock.calls[0]![0] as string;
      const countSql = mockRawQuery.mock.calls[1]![0] as string;
      expect(pageSql).toContain("c.state = 'active'");
      expect(countSql).toContain("c.state = 'active'");
    });

    it("subclaim count only counts active children", async () => {
      mockRawQuery.mockResolvedValueOnce([{ count: "0" }]);
      await getSubclaimCount("claim-1");
      const sql = mockRawQuery.mock.calls[0]![0] as string;
      expect(sql).toContain("c.state = 'active'");
    });
  });
});
