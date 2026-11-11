import { describe, it, expect } from "vitest";

// The claim page's words about what examination a node has had (#543): what
// stands in place of a verdict where there is none, and the line under a
// verdict made in part on evidence not shown.
import { evidenceNotShownLine, isExamined, notExaminedLine } from "../../../web/lib/coverage";

const NOT_EXAMINED = { examined: false, on: [] };
const PUBLIC = { examined: true, on: ["public_evidence"] };
const NOT_SHOWN = { examined: true, on: ["public_evidence", "evidence_not_shown"] };

describe("notExaminedLine", () => {
  it("says there is no verdict and that this is not a finding, in each kind's words", () => {
    expect(notExaminedLine("claim")).toBe(
      "Not yet assessed, so this page carries no verdict. That is not a finding for or against the claim."
    );
    expect(notExaminedLine("quantity")).toBe(
      "Not yet estimated, so this page carries no estimate from the graph. That is not a finding about the value."
    );
    expect(notExaminedLine("question")).toBe(
      "Not yet assessed, so this page carries no answer from the graph. That is not a finding about the answer."
    );
  });

  it("drops the lead where the page has just said it", () => {
    expect(notExaminedLine("quantity", { afterLead: true })).toBe(
      "This page carries no estimate from the graph. That is not a finding about the value."
    );
  });

  it("says it is not a finding in every form, so the empty place never reads as an all-clear", () => {
    for (const kind of ["claim", "quantity", "question"] as const) {
      expect(notExaminedLine(kind)).toMatch(/^Not yet /);
      for (const line of [notExaminedLine(kind), notExaminedLine(kind, { afterLead: true })]) {
        expect(line).toContain("That is not a finding");
      }
    }
  });
});

describe("evidenceNotShownLine", () => {
  it("says so when the judgment was made in part on evidence not shown", () => {
    expect(evidenceNotShownLine(NOT_SHOWN)).toBe(
      "This assessment rests in part on evidence not shown: " +
        "at least one of its sources reports a result from data it has not published."
    );
  });

  it("calls a quantity's judgment an estimate", () => {
    expect(evidenceNotShownLine(NOT_SHOWN, "estimate")).toMatch(/^This estimate rests in part on evidence not shown: /);
  });

  it("says nothing for a judgment made on public evidence alone", () => {
    expect(evidenceNotShownLine(PUBLIC)).toBeNull();
  });

  it("says nothing for a node that has not been examined, or when the field is absent", () => {
    expect(evidenceNotShownLine(NOT_EXAMINED)).toBeNull();
    expect(evidenceNotShownLine({ ...NOT_EXAMINED, note: "No judgment of this node is in force." })).toBeNull();
    // Not examined wins over a list that should then be empty.
    expect(evidenceNotShownLine({ examined: false, on: ["evidence_not_shown"] })).toBeNull();
    expect(evidenceNotShownLine(null)).toBeNull();
    expect(evidenceNotShownLine(undefined)).toBeNull();
  });

  it("ignores values it does not know, so the list can gain them", () => {
    expect(evidenceNotShownLine({ examined: true, on: ["public_evidence", "some_later_value"] })).toBeNull();
    expect(evidenceNotShownLine({ examined: true, on: ["some_later_value", "evidence_not_shown"] })).not.toBeNull();
  });
});

describe("isExamined", () => {
  it("goes by coverage when the API serves it", () => {
    expect(isExamined(NOT_EXAMINED, true)).toBe(false);
    expect(isExamined(PUBLIC, false)).toBe(true);
  });

  it("reads the short form a node of a tree carries, with or without `on`", () => {
    expect(isExamined({ examined: false }, true)).toBe(false);
    expect(isExamined({ examined: true }, false)).toBe(true);
    expect(isExamined({ examined: true, on: ["evidence_not_shown"] }, false)).toBe(true);
  });

  it("falls back to what the caller can tell when the field is absent", () => {
    expect(isExamined(undefined, true)).toBe(true);
    expect(isExamined(null, false)).toBe(false);
  });
});
