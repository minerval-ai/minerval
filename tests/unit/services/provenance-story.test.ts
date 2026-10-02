import { describe, it, expect, vi } from "vitest";

// The origins-first read model (#507) as a pure function over rows: who
// stands at the top and why, how deep everything else sits, and the order
// the map draws in. The database loader is covered in tests/db.

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn() }));

import { buildProvenanceStory, type StoryInput } from "../../../src/services/provenance-story-service.js";

const src = (id: string, source_type = "unknown") => ({ id, title: id, url: null, source_type });
const edge = (from: string, to: string, relation_type = "repeats", fidelity = "faithful") => ({
  from_instance_id: `i-${from}`, from_source_id: from, to_source_id: to, relation_type, fidelity,
});
const inst = (source_id: string) => ({ id: `i-${source_id}`, source_id });

function story(input: Partial<StoryInput>) {
  return buildProvenanceStory("c1", { sources: [], instances: [], edges: [], republishes: [], roots: [], ...input });
}

function byId(s: ReturnType<typeof story>) {
  return new Map(s.nodes.map((n) => [n.source.id, n]));
}

describe("buildProvenanceStory", () => {
  it("tells an origin from an untraced source, and an underlying source from one that states the claim", () => {
    // The mayor's remark: a transcript nobody's instance states, a newspaper
    // deriving from it, a post repeating the newspaper and strengthening it.
    const s = story({
      sources: [src("transcript", "transcript"), src("paper"), src("post"), src("blog")],
      instances: [inst("paper"), inst("post"), inst("blog")],
      edges: [edge("paper", "transcript", "derives_from"), edge("post", "paper", "repeats", "strengthened")],
    });
    const n = byId(s);
    expect(n.get("transcript")).toMatchObject({ standing: "origin", basis: "primary_source_kind", underlying: true, depth: 0, downstream: 1, downstream_total: 2 });
    expect(n.get("paper")).toMatchObject({ standing: "derived", basis: "upstream", underlying: false, depth: 1, diverges: false });
    expect(n.get("post")).toMatchObject({ standing: "derived", depth: 2, diverges: true, upstream: [{ source_id: "paper", relation_type: "repeats", fidelity: "strengthened" }] });
    // Nothing recorded upstream and nothing saying it is a beginning.
    expect(n.get("blog")).toMatchObject({ standing: "untraced", basis: "none", depth: 0 });
    expect(s.nodes.map((x) => x.source.id)).toEqual(["transcript", "blog", "paper", "post"]);
    expect(s.counts).toEqual({ sources: 4, origins: 1, untraced: 1, derived: 2, underlying: 1 });
  });

  it("lets the Steward confirm an origin or demote a primary kind, but not hide a recorded upstream edge", () => {
    const root = (source_id: string, status: "origin" | "untraced") => ({
      source_id, status, basis: "why", created_by: "claim_steward", updated_at: "2026-10-01T00:00:00.000Z",
    });
    const s = story({
      sources: [src("release"), src("fake", "transcript"), src("news"), src("reprint", "transcript")],
      instances: [inst("release"), inst("fake"), inst("news"), inst("reprint")],
      edges: [edge("news", "release", "derives_from"), edge("reprint", "news", "repeats")],
      roots: [root("release", "origin"), root("fake", "untraced"), root("reprint", "untraced")],
    });
    const n = byId(s);
    expect(n.get("release")).toMatchObject({ standing: "origin", basis: "steward", root: { status: "origin", basis: "why" } });
    expect(n.get("fake")).toMatchObject({ standing: "untraced", basis: "steward" });
    // An edge recorded after the root row wins: it is below what it draws on.
    expect(n.get("reprint")).toMatchObject({ standing: "derived", basis: "upstream", depth: 2 });
  });

  it("keeps a Steward's origin at the top even when it has an upstream edge, with the edge still listed", () => {
    const s = story({
      sources: [src("a"), src("b")],
      instances: [inst("a"), inst("b")],
      edges: [edge("a", "b", "responds_to")],
      roots: [{ source_id: "a", status: "origin", basis: "first record of the remark", created_by: "claim_steward", updated_at: "x" }],
    });
    const a = byId(s).get("a")!;
    expect(a).toMatchObject({ standing: "origin", depth: 0 });
    expect(a.upstream).toHaveLength(1);
  });

  it("treats a republished copy as resting on its original, and counts copies anywhere as reach", () => {
    const s = story({
      sources: [src("wire"), src("mirror"), src("study", "dataset")],
      instances: [inst("wire"), inst("mirror")],
      edges: [edge("wire", "study", "derives_from")],
      republishes: [
        { parent_source_id: "wire", child_source_id: "mirror" },
        { parent_source_id: "wire", child_source_id: "elsewhere" },
      ],
    });
    const n = byId(s);
    expect(n.get("mirror")).toMatchObject({ standing: "derived", copy_of: ["wire"], depth: 2 });
    expect(n.get("wire")).toMatchObject({ copies: 2, downstream: 1 });
    expect(n.get("study")).toMatchObject({ standing: "origin", downstream_total: 2 });
  });

  it("orders siblings by divergence, then downstream count, then copies", () => {
    const s = story({
      sources: [src("root", "dataset"), src("quiet"), src("busy"), src("bent"), src("leaf1"), src("leaf2"), src("loud")],
      instances: ["quiet", "busy", "bent", "leaf1", "leaf2", "loud"].map(inst),
      edges: [
        edge("quiet", "root"), edge("busy", "root"), edge("bent", "root", "derives_from", "distorted"),
        edge("loud", "root"), edge("leaf1", "busy"), edge("leaf2", "busy"),
      ],
      republishes: [{ parent_source_id: "loud", child_source_id: "x1" }],
    });
    const depth1 = s.nodes.filter((n) => n.depth === 1).map((n) => n.source.id);
    expect(depth1).toEqual(["bent", "busy", "loud", "quiet"]);
  });

  it("survives a loop of responses with no way in, leaving its depth unknown", () => {
    const s = story({
      sources: [src("x"), src("y")],
      instances: [inst("x"), inst("y")],
      edges: [edge("x", "y", "responds_to"), edge("y", "x", "responds_to")],
    });
    expect(s.nodes.every((n) => n.standing === "derived" && n.depth === null)).toBe(true);
    expect(s.nodes.map((n) => n.downstream_total)).toEqual([1, 1]);
  });

  it("is empty for a claim with nothing recorded", () => {
    expect(story({}).nodes).toEqual([]);
  });
});
