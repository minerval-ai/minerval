import { describe, it, expect } from "vitest";

// The claim page's line about what has changed under the assessment since it
// was written (#566): said only when something changed, and never when the
// judgment predates the record, where nothing is known either way.
import { sinceAssessedLine } from "../../../web/lib/since-assessed";

const none = {
  premises_rejudged: 0, premises_added: 0, premises_removed: 0,
  sources_added: 0, sources_removed: 0, source_events: 0,
};

describe("sinceAssessedLine", () => {
  it("builds one line from the counts above zero", () => {
    expect(
      sinceAssessedLine({ recorded: true, changed: true, ...none, premises_rejudged: 2, sources_added: 1 })
    ).toBe("Since this assessment: 2 premises judged again, 1 source added.");
    expect(
      sinceAssessedLine({
        recorded: true, changed: true,
        premises_rejudged: 1, premises_added: 1, premises_removed: 3,
        sources_added: 2, sources_removed: 1, source_events: 1,
      })
    ).toBe(
      "Since this assessment: 1 premise judged again, 1 premise added, 3 premises removed, " +
        "2 sources added, 1 source removed, 1 notice on its sources."
    );
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
