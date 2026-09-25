import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// The web side of replays (#334): the mirrored schema and the pure helpers the
// player folds an arm's deltas with. Pure data in, data out; no DOM.
import {
  REPLAY_VERSION,
  causeChain,
  causedIndexes,
  credenceSeries,
  detailUrl,
  eventIndexByRunId,
  eventIndexBySeq,
  finalGraph,
  graphAt,
  isKnownVersion,
  isTraced,
  layoutGraph,
  lockedIndex,
  promptCarrier,
  promptSpecOf,
  promptText,
  sourceOrderOfEvents,
  touchedClaimIds,
  type Replay,
  type ReplayEventDetail,
} from "../../../web/lib/replay";

const FIX = resolve(__dirname, "fixtures");
const property = JSON.parse(readFileSync(resolve(FIX, "replay-sample.json"), "utf-8")) as Replay;
const adversarial = JSON.parse(readFileSync(resolve(FIX, "replay-adversarial.json"), "utf-8")) as Replay;
const detailA3 = JSON.parse(readFileSync(resolve(FIX, "replay-sample-events/sample-property-eggs/events/a/3.json"), "utf-8")) as ReplayEventDetail;
const detailA5 = JSON.parse(readFileSync(resolve(FIX, "replay-sample-events/sample-property-eggs/events/a/5.json"), "utf-8")) as ReplayEventDetail;

const armA = property.arms[0]!;
const armB = property.arms[1]!;

describe("fixtures", () => {
  it("are the schema version the player knows, and traced", () => {
    expect(property.version).toBe(REPLAY_VERSION);
    expect(isKnownVersion(property)).toBe(true);
    expect(isKnownVersion({ version: 2 })).toBe(false);
    expect(isTraced(property)).toBe(true);
    expect(isTraced({ ...property, arms: property.arms.map((a) => ({ ...a, events: a.events.map((e) => ({ ...e, steps: [] })) })) })).toBe(false);
  });

  it("has the shapes the task asked for", () => {
    expect(property.arms).toHaveLength(2);
    expect(armA.sources).toHaveLength(2);
    expect(armA.events.length).toBeGreaterThanOrEqual(12);
    expect(armB.events.length).toBeGreaterThanOrEqual(12);
    const m = property.matching![0]!;
    expect(m.pairs).toHaveLength(4);
    expect(m.unmatchedA).toHaveLength(1);
    expect(m.unmatchedB).toHaveLength(1);
    // one match with stance denies, two stewards with tool calls, one curator, a caused steward_notified
    const denies = armA.events.flatMap((e) => e.deltas).find((d) => d.op === "claim_matched" && d.stance === "denies");
    expect(denies).toBeTruthy();
    expect(armA.events.filter((e) => e.agent === "steward" && e.steps.some((s) => s.kind === "tool_call")).length).toBeGreaterThanOrEqual(2);
    expect(armA.events.filter((e) => e.agent === "curator")).toHaveLength(1);
    expect(adversarial.arms.map((a) => a.key)).toEqual(["pro", "con", "benign"]);
    expect(adversarial.arms[0]!.events.flatMap((e) => e.deltas).some((d) => d.op === "appeal_filed")).toBe(true);
  });

  it("carries the drill-down fields: detailPath, dataFlow, promptsUsed, prompt steps", () => {
    expect(armA.events.every((e) => typeof e.detailPath === "string")).toBe(true);
    expect(armA.events[2]!.dataFlow?.read[0]?.tool).toBe("search_claims");
    expect(armA.promptsUsed).toHaveLength(2);
    expect(armA.events[2]!.steps[0]!.kind).toBe("prompt");
    expect(detailA3.steps[0]!.full).toBe(true);
  });
});

describe("graphAt", () => {
  it("is empty before the first event and grows as deltas land", () => {
    expect(graphAt(armA, 0).claims).toHaveLength(0);
    const g3 = graphAt(armA, 3);
    expect(g3.claims.map((c) => c.id)).toEqual(["c1"]);
    expect(g3.byId.c1!.instances).toBe(1);
    expect(g3.byId.c1!.status).toBeNull();
    expect(g3.sources.map((s) => s.id)).toEqual(["s1"]);
  });

  it("folds a steward run: subclaim, edge, assessment, importance", () => {
    const g = graphAt(armA, 5);
    expect(g.byId.c1!.status).toBe("supported");
    expect(g.byId.c1!.credence).toBe(0.7);
    expect(g.byId.c1!.confidence).toBe(0.8);
    expect(g.byId.c1!.importance).toBe(0.55);
    expect(g.byId.c1a!.topLevel).toBe(false);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.relation).toBe("requires");
    expect(g.edges[0]!.seq).toBe(5);
  });

  it("counts a match as a second instance and records its stance", () => {
    const g = graphAt(armA, 9);
    expect(g.byId.c2!.instances).toBe(2);
    expect(g.byId.c2!.stances).toEqual(["denies"]);
    expect(g.byId.c2!.sourceIds).toEqual(["s1", "s2"]);
    expect(g.sources).toHaveLength(2);
  });

  it("marks a merged claim and keeps the final assessment", () => {
    const g = graphAt(armA, Infinity);
    expect(g.byId.c4a!.merged).toBe("c2a");
    expect(g.byId.c2!.credence).toBe(0.42);
    expect(g.byId.c4!.confidence).toBe(0.72);
    expect(g.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
  });

  it("updates text on a canonical-form change and stubs a claim the window never created", () => {
    const arm = {
      ...armA,
      events: [
        { ...armA.events[0]!, seq: 1, deltas: [{ op: "canonical_form_updated" as const, claimId: "c1", before: "x", after: "Rewritten" }] },
        { ...armA.events[0]!, seq: 2, deltas: [{ op: "assessment_recorded" as const, claimId: "ghost", status: "unknown", credence: null, confidence: 0.5, trigger: null }] },
      ],
    };
    const g = graphAt(arm, 2);
    expect(g.byId.c1!.text).toBe("Rewritten");
    expect(g.byId.c1!.claimType).toBe("empirical"); // from the final record
    expect(g.byId.ghost!.text).toBe("ghost");
    expect(g.byId.ghost!.status).toBe("unknown");
  });
});

describe("graphAt with a pre-existing graph", () => {
  const pro = adversarial.arms[0]!;
  const benign = adversarial.arms[2]!;

  it("seeds the target from the arm's initial state before any event", () => {
    const g = graphAt(pro, -1);
    expect(g.byId.c2!.preexisting).toBe(true);
    expect(g.byId.c2!.status).toBe("contested");
    expect(g.byId.c2!.credence).toBe(0.42);
    expect(g.byId.c2!.priorUnknown).toBeUndefined();
  });

  it("then applies the window's assessments", () => {
    expect(graphAt(benign, 2).byId.c2!.credence).toBe(0.42);
    expect(graphAt(benign, 3).byId.c2!.credence).toBe(0.36);
    const s = credenceSeries(benign, "c2");
    expect(s.map((p) => [p.index, p.credence])).toEqual([[-1, 0.42], [2, 0.36]]);
  });

  it("without an initial state, seeds from the final record and marks a reassessed prior unknown", () => {
    const noInitial = { ...benign, initial: null };
    const g = graphAt(noInitial, 1);
    expect(g.byId.c2!.preexisting).toBe(true);
    expect(g.byId.c2!.priorUnknown).toBe(true);
    expect(g.byId.c2!.status).toBeNull();
    const conNoInitial = { ...adversarial.arms[1]!, initial: null };  // never reassessed: the final state is the prior
    expect(graphAt(conNoInitial, 0).byId.c2!.credence).toBe(0.42);
    expect(credenceSeries(noInitial, "c2").map((p) => p.index)).toEqual([2]);
  });
});

describe("finalGraph", () => {
  it("prefers the final records and keeps merged-away claims the deltas mention", () => {
    const g = finalGraph(armA);
    expect(g.byId.c2!.status).toBe("contested");
    expect(g.byId.c4a!.merged).toBe("c2a");
    expect(g.claims.map((c) => c.id)).toContain("c4a");
    expect(g.byId.c1!.createdSeq).toBe(3);
  });
});

describe("indexes and series", () => {
  it("indexes events by run id and by seq", () => {
    expect(eventIndexByRunId(armA).get("run-a-stew-1")).toBe(4);
    expect(eventIndexByRunId(armA).has("")).toBe(false);
    expect(eventIndexBySeq(armA).get(13)).toBe(12);
  });

  it("gives a claim's credence over the arm, in event order", () => {
    const s = credenceSeries(armA, "c2");
    expect(s.map((p) => p.credence)).toEqual([0.5, 0.42]);
    expect(s.map((p) => p.index)).toEqual([5, 10]);
    expect(s[1]!.trigger).toBe("new_instance");
    expect(credenceSeries(armA, "nope")).toEqual([]);
  });

  it("lists the claims an event touches", () => {
    expect(touchedClaimIds(armA.events[4]!).sort()).toEqual(["c1", "c1a"]);
    expect(touchedClaimIds(armA.events[12]!).sort()).toEqual(["c2a", "c4", "c4a"]);
  });

  it("walks causes in both directions", () => {
    // event index 4 (seq 5) ← seq 3 ← seq 2 ← seq 1
    expect(causeChain(armA, 4)).toEqual([2, 1, 0]);
    expect(causedIndexes(armA, 3)).toEqual([4]);
    expect(causedIndexes(armA, 2)).toEqual([2, 3]);             // the extractor run fed two matcher runs
    expect(causedIndexes(armA, 8).map((i) => armA.events[i]!.seq)).toEqual([9, 10]);
    expect(causeChain(armA, 0)).toEqual([]);
  });
});

describe("layoutGraph", () => {
  it("puts top-level claims in one row grouped by first source, subclaims below by depth, shared ones once", () => {
    const L = layoutGraph(finalGraph(armA));
    const ids = L.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const top = L.nodes.filter((n) => n.depth === 0).map((n) => n.id);
    expect(top).toEqual(["c1", "c2", "c4"]);          // s1's claims then s2's
    expect(L.groups.map((g) => g.key)).toEqual(["s1", "s2"]);
    expect(L.byId.c1a!.depth).toBe(1);               // child of c1 and c4: shortest path wins, shown once
    expect(L.byId.c2a!.depth).toBe(1);
    expect(L.byId.c4a!.depth).toBe(1);               // merged away, still has a place
    const y0 = L.byId.c1!.y;
    expect(L.byId.c1a!.y).toBeGreaterThan(y0);
    expect(L.width).toBeGreaterThan(0);
    expect(L.height).toBeGreaterThan(L.byId.c1a!.y);
  });

  it("is deterministic and stable as nodes are revealed (positions come from the final graph)", () => {
    const a = layoutGraph(finalGraph(armA));
    const b = layoutGraph(finalGraph(armA));
    expect(a).toEqual(b);
    // Reveal only the first events: the nodes that exist keep the same coordinates.
    const early = graphAt(armA, 5);
    for (const c of early.claims) expect(a.byId[c.id]).toBeTruthy();
  });

  it("gives an orphan subclaim a row rather than dropping it", () => {
    const g = finalGraph(armA);
    g.claims.push({ ...g.byId.c1a!, id: "lonely", topLevel: false, sourceIds: [] });
    g.byId.lonely = g.claims[g.claims.length - 1]!;
    const L = layoutGraph(g);
    expect(L.byId.lonely!.depth).toBe(0);
  });
});

describe("lockstep", () => {
  it("carries the source order forward through events that name none", () => {
    expect(sourceOrderOfEvents(armA)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(sourceOrderOfEvents(armB)[0]).toBe(0); // s2 is arm B's first source
  });

  it("locks the other arm to the same source block at the same offset, clipped", () => {
    // arm A index 7 = second event of source order 1; arm B's order-1 block starts at index 6
    expect(lockedIndex(armA, 7, armB)).toBe(7);
    expect(lockedIndex(armA, 13, armB)).toBe(12);   // clipped to B's last event
    expect(lockedIndex(armA, 0, armB)).toBe(0);
  });
});

describe("detail files and prompts", () => {
  it("resolves the detail url relative to the events root", () => {
    expect(detailUrl("sample-property-eggs", "a", armA.events[2]!)).toBe("/evals/replays/sample-property-eggs/events/a/3.json");
    expect(detailUrl("x", "b", { ...armA.events[2]!, detailPath: null })).toBe("/evals/replays/x/events/b/3.json");
    expect(detailUrl("x", "b", { ...armA.events[2]!, detailPath: "/b/3.json" })).toBe("/evals/replays/x/events/b/3.json");
  });

  it("reads the prompt payload of a prompt step and flattens block-style system text", () => {
    const spec = promptSpecOf(detailA3.steps[0]!)!;
    expect(spec.model).toBe("z-ai/glm-5.3-flash");
    expect(spec.tools).toHaveLength(2);
    expect(promptText(spec.system)).toContain("You are the Matcher");
    expect(promptText(spec.system)).toContain("# Constitution");
    expect(promptText(promptSpecOf(detailA5.steps[0]!)!.system)).toContain("You are the Claim Steward");
    expect(promptSpecOf(detailA3.steps[1]!)).toBeNull();
    // an older export that put the payload on `input`
    expect(promptSpecOf({ seq: 1, kind: "prompt", at: null, text: "", input: { model: "m" } })!.model).toBe("m");
  });

  it("finds the event that carries a prompt's text", () => {
    const p = armA.promptsUsed![1]!;
    expect(promptCarrier(property, "a", p)).toEqual({ armKey: "a", index: 4 });
    expect(promptCarrier(property, "a", { ...p, eventSeq: null })).toEqual({ armKey: "a", index: 4 });
    expect(promptCarrier(property, "zzz", p)).toBeNull();
  });
});
