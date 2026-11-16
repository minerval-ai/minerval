import { describe, it, expect } from "vitest";

// The claim page's line about what has changed under the assessment since it
// was written (#566): said only when something moved, never for a premise
// judged again to the verdict it had, and never when the judgment predates
// the record, where nothing is known either way.
import { movedPremises, sinceAssessedLine, sinceAssessedMoved } from "../../../web/lib/since-assessed";

const none = {
  premises_rejudged: 0, premises_moved: 0, premises_added: 0, premises_removed: 0,
  sources_added: 0, sources_removed: 0, source_events: 0,
};

describe("sinceAssessedLine", () => {
  it("builds one line from what moved", () => {
    expect(
      sinceAssessedLine({ recorded: true, changed: true, ...none, premises_rejudged: 3, premises_moved: 2, sources_added: 1 })
    ).toBe("Since this assessment: 2 premises judged differently, 1 source added.");
    expect(
      sinceAssessedLine({
        recorded: true, changed: true,
        premises_rejudged: 1, premises_moved: 1, premises_added: 1, premises_removed: 3,
        sources_added: 2, sources_removed: 1, source_events: 1,
      })
    ).toBe(
      "Since this assessment: 1 premise judged differently, 1 premise added, 3 premises removed, " +
        "2 sources added, 1 source removed, 1 notice on its sources."
    );
  });

  it("says nothing of premises judged again to the verdict they had", () => {
    const churn = { recorded: true, changed: true, ...none, premises_rejudged: 4 };
    expect(sinceAssessedMoved(churn)).toBe(false);
    expect(sinceAssessedLine(churn)).toBeNull();
    // An API that predates premises_moved cannot tell the two apart: left unsaid.
    const { premises_moved: _m, ...older } = churn;
    expect(sinceAssessedLine(older)).toBeNull();
  });

  it("calls a quantity's judgment an estimate", () => {
    expect(sinceAssessedLine({ recorded: true, changed: true, ...none, source_events: 2 }, "estimate")).toBe(
      "Since this estimate: 2 notices on its sources."
    );
  });

  it("says nothing when nothing changed", () => {
    expect(sinceAssessedLine({ recorded: true, changed: false, ...none })).toBeNull();
  });

  it("says nothing when the judgment predates the record, or the field is absent", () => {
    expect(sinceAssessedLine({ recorded: false, changed: null, note: "not recorded" })).toBeNull();
    expect(sinceAssessedLine(null)).toBeNull();
    expect(sinceAssessedLine(undefined)).toBeNull();
    // A malformed value never produces an empty sentence.
    expect(sinceAssessedLine({ recorded: true, changed: true })).toBeNull();
  });
});

describe("movedPremises", () => {
  const base = { relation: "requires" as const };
  it("names the premises that moved and how, leaving out those judged again to the same verdict", () => {
    const out = movedPremises({
      recorded: true,
      premises: [
        { ...base, node_id: "same", state: "rejudged", moved: false, text: "Same", verdict_then: "supported", verdict_now: "supported" },
        { ...base, node_id: "down", state: "rejudged", moved: true, text: "Down", verdict_then: "verified", verdict_now: "doubtful" },
        { ...base, node_id: "first", state: "rejudged", moved: true, text: "First", verdict_then: null, verdict_now: "supported" },
        { ...base, node_id: "qty", state: "rejudged", moved: true, text: "Qty", verdict_then: null, verdict_now: null },
        { ...base, node_id: "kept", state: "unchanged", moved: false, text: "Kept" },
        { ...base, node_id: "gone", state: "removed", moved: false, text: "Gone" },
      ],
      premises_added: [{ ...base, node_id: "new", text: "New", verdict_now: "unknown" }],
    });
    expect(out.map((p) => [p.node_id, p.change])).toEqual([
      ["down", "Verified → Doubtful"],
      ["first", "judged for the first time: Supported"],
      ["qty", "estimate changed"],
      ["new", "added (Unknown)"],
      ["gone", "removed"],
    ]);
  });

  it("is empty without a record", () => {
    expect(movedPremises(null)).toEqual([]);
    expect(movedPremises({ recorded: false, premises: [], premises_added: [] })).toEqual([]);
  });
});
