import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(), withTransaction: vi.fn() }));

import { orderClaimInstances } from "../../../src/services/claim-instance-service.js";
import type { StoryNode } from "../../../src/services/provenance-story-service.js";
import {
  getClaimContextToolDefinitions,
  getGovernanceToolDefinitions,
} from "../../../src/llm/tools/governance-tools.js";

// The reading order of a claim's instances: the Steward's ranks, then the
// provenance story (origins first, by depth, divergence, downstream count),
// then the date of the statement. Insertion order never decides it.

function node(sourceId: string, over: Partial<StoryNode> = {}): StoryNode {
  return {
    source: { id: sourceId, title: sourceId, url: null, source_type: "unknown" },
    instance_ids: [],
    date: null,
    stances: [],
    underlying: false,
    standing: "untraced",
    basis: "none",
    root: null,
    depth: 0,
    upstream: [],
    copy_of: [],
    downstream: 0,
    downstream_total: 0,
    copies: 0,
    diverges: false,
    ...over,
  };
}

const inst = (id: string, over: Partial<{ display_rank: number | null; source_date: string | null; source_published_date: string | null; detached_at: string | null }> = {}) => ({
  id,
  source_id: `s-${id}`,
  display_rank: null,
  source_date: null,
  ...over,
});

describe("orderClaimInstances", () => {
  it("puts ranked instances first, in rank order", () => {
    const rows = [inst("a"), inst("b", { display_rank: 2 }), inst("c", { display_rank: 1 })];
    expect(orderClaimInstances(rows, null).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("then orders by the story: origins before untraced, shallow before deep", () => {
    const rows = [inst("deep"), inst("untraced"), inst("origin")];
    const story = {
      nodes: [
        node("s-deep", { standing: "derived", depth: 1 }),
        node("s-untraced"),
        node("s-origin", { standing: "origin", basis: "primary_source_kind" }),
      ],
    };
    expect(orderClaimInstances(rows, story).map((r) => r.id)).toEqual(["origin", "untraced", "deep"]);
  });

  it("then divergence, then how many sources rest on it", () => {
    const rows = [inst("plain"), inst("busy"), inst("diverges")];
    const story = {
      nodes: [node("s-plain"), node("s-busy", { downstream_total: 3 }), node("s-diverges", { diverges: true })],
    };
    expect(orderClaimInstances(rows, story).map((r) => r.id)).toEqual(["diverges", "busy", "plain"]);
  });

  it("then by the statement's date, the document's date as fallback, undated last", () => {
    const rows = [
      inst("undated"),
      inst("2021", { source_date: "2021-06" }),
      inst("doc2019", { source_published_date: "2019" }),
      inst("2020", { source_date: "2020" }),
    ];
    expect(orderClaimInstances(rows, { nodes: [] }).map((r) => r.id)).toEqual(["doc2019", "2020", "2021", "undated"]);
  });

  it("puts detached instances after every instance that belongs, rank or not", () => {
    const rows = [inst("gone", { display_rank: 1, detached_at: "2026-01-01" }), inst("kept")];
    expect(orderClaimInstances(rows, null).map((r) => r.id)).toEqual(["kept", "gone"]);
  });

  it("does not depend on the input order", () => {
    const rows = [inst("x", { source_date: "2001" }), inst("y", { source_date: "2000" })];
    expect(orderClaimInstances(rows, null).map((r) => r.id)).toEqual(["y", "x"]);
    expect(orderClaimInstances([...rows].reverse(), null).map((r) => r.id)).toEqual(["y", "x"]);
  });
});

describe("the claim reads in the governance bundle", () => {
  const tools = getGovernanceToolDefinitions();
  const byName = new Map(tools.map((t) => [t.name, t]));

  it("renames get_claim_with_context to get_claim and adds get_claim_instances", () => {
    expect(byName.has("get_claim_with_context")).toBe(false);
    expect(byName.has("get_claim")).toBe(true);
    expect(byName.has("get_claim_instances")).toBe(true);
    expect(getClaimContextToolDefinitions().map((t) => t.name)).toEqual(
      expect.arrayContaining(["get_claim", "get_claim_instances"])
    );
  });

  it("describes the instances as what is recorded, not a sample, and the Steward's to decide", () => {
    const d = byName.get("get_claim_instances")!.description!;
    expect(d).toMatch(/currently records/);
    expect(d).toMatch(/not a sample of the\s+discourse/);
    expect(d).toMatch(/not necessarily the right set/);
    expect(d).toMatch(/Steward\s+decides which instances the claim should carry/);
    const props = (byName.get("get_claim_instances")!.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(["claim_id", "limit", "offset", "include_detached"]);
  });

  it("get_claim promises no instances", () => {
    expect(byName.get("get_claim")!.description).toMatch(/returns no\s+sources/);
  });
});
